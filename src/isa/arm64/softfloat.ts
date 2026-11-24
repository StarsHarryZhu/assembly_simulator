/**
 * IEEE 754 arithmetic in software, as AArch64 defines it: half, single and double precision and BFloat16,
 * the four FPCR rounding modes (plus ties-away and round-to-odd where instructions use them), the FPCR
 * controls FZ, FZ16, DN and AHP, the FEAT_AFP controls FIZ and AH, and the FPSR cumulative exception flags.
 *
 * Every operation works on exact values (an integer significand times a power of two, in bigints) and
 * rounds once, the way the Arm ARM's FPRound does, so results and flags match the architecture bit for
 * bit. Operands and results are bit patterns in bigints. Flags go to the FpEnv the caller passes in.
 */

export interface Fmt {
  /** Total bits. */
  readonly n: number
  /** Exponent bits. */
  readonly e: number
  /** Fraction bits. */
  readonly f: number
}
export const F16: Fmt = { n: 16, e: 5, f: 10 }
export const F32: Fmt = { n: 32, e: 8, f: 23 }
export const F64: Fmt = { n: 64, e: 11, f: 52 }
export const BF16: Fmt = { n: 16, e: 8, f: 7 }

/** The format of an FP register size in bytes: 2, 4 or 8. */
export const fmtOfBytes = (bytes: number): Fmt => (bytes === 2 ? F16 : bytes === 4 ? F32 : F64)

/* FPSR cumulative exception bits. */
export const IOC = 1
export const DZC = 2
export const OFC = 4
export const UFC = 8
export const IXC = 16
export const IDC = 128

/* FPCR bits. RMode is bits 23:22. */
export const FIZ = 1
export const AH = 2
export const NEP = 4
export const FZ16 = 1 << 19
export const FZ = 1 << 24
export const DN = 1 << 25
export const AHP = 1 << 26
/** The FPCR bits this machine implements (the trap enables and EBF read as zero). */
export const FPCR_MASK = FIZ | AH | NEP | FZ16 | (3 << 22) | FZ | DN | AHP

/* Rounding modes: the FPCR's four, then the ones instructions choose themselves. */
export const RN = 0
export const RP = 1
export const RM = 2
export const RZ = 3
export const RA = 4
export const RO = 5
/**
 * BFRound, the rounding of the BFloat16 dot products (FPCR.EBF = 0): to odd, but tiny results flush to
 * zero before rounding and overflow gives infinity. Only ever set through FpEnv.mode.
 */
export const RBF = 6

/** The control register for one operation, and the exception flags it raises. */
export class FpEnv {
  constructor(
    public fpcr: number,
    private readonly box: { flags: number } = { flags: 0 },
  ) {}
  /** Exception flags raised so far (shared with every copy made by `with`). */
  get flags(): number {
    return this.box.flags
  }
  set flags(v: number) {
    this.box.flags = v
  }
  /** A rounding mode the FPCR cannot hold (round to odd, for the BFloat16 dot products), overriding RMode. */
  mode: number | undefined = undefined
  get rmode(): number {
    return this.mode ?? (this.fpcr >>> 22) & 3
  }
  get altfp(): boolean {
    return (this.fpcr & AH) !== 0
  }
  /** A copy with some FPCR bits changed (the flags still go to this one). */
  with(set: number, clear = 0): FpEnv {
    return new FpEnv((this.fpcr & ~clear) | set, this.box)
  }
}

/* Unpacked kinds. */
export const ZERO = 0
export const NUM = 1
export const INF = 2
export const QNAN = 3
export const SNAN = 4

/** A value: for NUM, (-1)^s × m × 2^x with m > 0. `d`: a denormal input that was kept. */
export interface Val {
  t: number
  s: number
  m: bigint
  x: number
  d: boolean
}

const B = BigInt
const ones = (n: number) => (1n << B(n)) - 1n

export function bitLength(m: bigint): number {
  let n = 0
  let v = m
  while (v >= 1n << 64n) {
    v >>= 64n
    n += 64
  }
  return n + (v === 0n ? 0 : v.toString(2).length)
}

/* ------------------------------------------------------------------ packing */

export const isNaN_ = (fmt: Fmt, bits: bigint) => ((bits >> B(fmt.f)) & ones(fmt.e)) === ones(fmt.e) && (bits & ones(fmt.f)) !== 0n
const signBit = (fmt: Fmt) => 1n << B(fmt.n - 1)
const quietBit = (fmt: Fmt) => 1n << B(fmt.f - 1)
export const zeroOf = (fmt: Fmt, s: number) => (s ? signBit(fmt) : 0n)
export const infOf = (fmt: Fmt, s: number) => (s ? signBit(fmt) : 0n) | (ones(fmt.e) << B(fmt.f))
export const maxNormal = (fmt: Fmt, s: number) => (s ? signBit(fmt) : 0n) | ((ones(fmt.e) - 1n) << B(fmt.f)) | ones(fmt.f)
export const defaultNaN = (fmt: Fmt, env: FpEnv) => (env.altfp ? signBit(fmt) : 0n) | (ones(fmt.e) << B(fmt.f)) | quietBit(fmt)
/** ±2.0, ±1.5 and 1.0 (the step instructions' special results). */
const constOf = (fmt: Fmt, s: number, exp: number, frac: bigint) => (s ? signBit(fmt) : 0n) | (B(exp + (1 << (fmt.e - 1)) - 1) << B(fmt.f)) | frac
export const twoOf = (fmt: Fmt, s: number) => constOf(fmt, s, 1, 0n)
export const onePointFive = (fmt: Fmt, s: number) => constOf(fmt, s, 0, 1n << B(fmt.f - 1))

/**
 * FPUnpack. `ahp`: a half-precision operand of a conversion in the alternative format (no infinities or
 * NaNs). `cv`: a conversion's unpack, which never flushes half precision.
 */
export function unpack(env: FpEnv, fmt: Fmt, bits: bigint, fpexc = true, ahp = false, cv = false): Val {
  const { n, e, f } = fmt
  const s = Number((bits >> B(n - 1)) & 1n)
  const ex = Number((bits >> B(f)) & ones(e))
  const fr = bits & ones(f)
  const bias = (1 << (e - 1)) - 1
  if (ex === 0) {
    if (fr === 0n) return { t: ZERO, s, m: 0n, x: 0, d: false }
    if (fmt === F16) {
      if (!cv && env.fpcr & FZ16) return { t: ZERO, s, m: 0n, x: 0, d: false }
    } else {
      const fz = (env.fpcr & FZ) !== 0 && !env.altfp
      const fiz = (env.fpcr & FIZ) !== 0
      if (fz || fiz) {
        if (fz && fpexc) env.flags |= IDC
        return { t: ZERO, s, m: 0n, x: 0, d: false }
      }
    }
    return { t: NUM, s, m: fr, x: 1 - bias - f, d: true }
  }
  if (ex === (1 << e) - 1 && !(fmt === F16 && ahp)) {
    if (fr === 0n) return { t: INF, s, m: 0n, x: 0, d: false }
    return { t: fr & quietBit(fmt) ? QNAN : SNAN, s, m: 0n, x: 0, d: false }
  }
  return { t: NUM, s, m: fr | (1n << B(f)), x: ex - bias - f, d: false }
}

/**
 * FPProcessDenorm(s): with AH = 1, a kept denormal input sets IDC, except in half precision (BFloat16, the top
 * half of a single, counts as single).
 */
export function denorms(env: FpEnv, fmt: Fmt, ...vals: Val[]): void {
  if (env.altfp && fmt !== F16 && vals.some((v) => v.d)) env.flags |= IDC
}

/* ------------------------------------------------------------------ rounding */

/** m × 2^s as an integer rounded down, and where the rest lies: 0 none, 1 below half, 2 half, 3 above. */
function split(m: bigint, s: number): [bigint, number] {
  if (s >= 0) return [m << B(s), 0]
  const k = B(-s)
  const q = m >> k
  const r = m & ((1n << k) - 1n)
  if (r === 0n) return [q, 0]
  const half = 1n << (k - 1n)
  return [q, r < half ? 1 : r === half ? 2 : 3]
}

function roundsUp(rounding: number, rest: number, lsb: bigint, s: number): boolean {
  switch (rounding) {
    case RN:
      return rest === 3 || (rest === 2 && lsb === 1n)
    case RP:
      return rest !== 0 && s === 0
    case RM:
      return rest !== 0 && s === 1
    case RA:
      return rest >= 2
    default:
      return false
  }
}

export interface RoundOpts {
  fpexc?: boolean
  /** The result is half precision in the alternative format (FCVT with FPCR.AHP). */
  ahp?: boolean
  /** Never flush the result (conversions to half precision, FMAX with AH). */
  noFlush?: boolean
}

/** FPRoundBase: the nonzero real (-1)^s × m × 2^x rounded to the format. */
export function round(env: FpEnv, fmt: Fmt, s: number, m: bigint, x: number, roundingIn = env.rmode, opts: RoundOpts = {}): bigint {
  const fpexc = opts.fpexc ?? true
  const { e: E, f: F } = fmt
  const minExp = 2 - (1 << (E - 1))
  const altfp = env.altfp
  const fz = !opts.noFlush && (fmt === F16 ? (env.fpcr & FZ16) !== 0 : (env.fpcr & FZ) !== 0)
  const exponent = bitLength(m) - 1 + x
  const bfr = roundingIn === RBF
  const rounding = bfr ? RO : roundingIn
  if (bfr && exponent < minExp) return zeroOf(fmt, s)
  if (!altfp && fz && exponent < minExp) {
    if (fpexc) env.flags |= UFC
    return zeroOf(fmt, s)
  }
  let bexp = Math.max(exponent - minExp + 1, 0)
  const ulp = bexp > 0 ? exponent - F : minExp - F
  let [mant, rest] = split(m, x - ulp)
  let error = rest !== 0
  if (!altfp && bexp === 0 && error && fpexc) env.flags |= UFC
  if (altfp) {
    let [mu, restU] = split(m, x - (exponent - F))
    let bu = exponent - minExp + 1
    if (roundsUp(rounding, restU, mu & 1n, s)) {
      mu++
      if (mu === 1n << B(F + 1)) {
        bu++
        mu >>= 1n
      }
    }
    if (bu < 1 && mu !== 0n) {
      if (fz) {
        if (fpexc) env.flags |= UFC | IXC
        return zeroOf(fmt, s)
      }
      if (error && fpexc) env.flags |= UFC
    }
  }
  const overflowToInf = bfr || rounding === RN || rounding === RA || (rounding === RP && s === 0) || (rounding === RM && s === 1)
  if (roundsUp(rounding, rest, mant & 1n, s)) {
    mant++
    if (mant === 1n << B(F)) bexp = 1
    if (mant === 1n << B(F + 1)) {
      bexp++
      mant >>= 1n
    }
  }
  if (rest !== 0 && rounding === RO) mant |= 1n
  let result: bigint
  if (!opts.ahp) {
    if (bexp >= (1 << E) - 1) {
      result = overflowToInf ? infOf(fmt, s) : maxNormal(fmt, s)
      if (fpexc) env.flags |= OFC
      error = true
    } else result = (s ? signBit(fmt) : 0n) | (B(bexp) << B(F)) | (mant & ones(F))
  } else if (bexp >= 1 << E) {
    result = (s ? signBit(fmt) : 0n) | ones(fmt.n - 1)
    if (fpexc) env.flags |= IOC
    error = false
  } else result = (s ? signBit(fmt) : 0n) | (B(bexp) << B(F)) | (mant & ones(F))
  if (error && fpexc) env.flags |= IXC
  return result
}

/* ------------------------------------------------------------------ NaNs */

/** FPProcessNaN: quiet a signalling NaN (IOC), or give the default NaN when FPCR.DN is set. */
export function processNaN(env: FpEnv, fmt: Fmt, t: number, bits: bigint, fpexc = true): bigint {
  let r = bits
  if (t === SNAN) {
    r |= quietBit(fmt)
    if (fpexc) env.flags |= IOC
  }
  return env.fpcr & DN ? defaultNaN(fmt, env) : r
}

const isNaNT = (t: number) => t === QNAN || t === SNAN

/** FPProcessNaNs: the NaN result of a two-operand operation, or null when neither is a NaN. */
export function processNaNs(env: FpEnv, fmt: Fmt, a: Val, b: Val, op1: bigint, op2: bigint, fpexc = true): bigint | null {
  if (env.altfp && isNaNT(a.t) && isNaNT(b.t)) return processNaN(env, fmt, a.t === SNAN || b.t === SNAN ? SNAN : QNAN, op1, fpexc)
  if (a.t === SNAN) return processNaN(env, fmt, a.t, op1, fpexc)
  if (b.t === SNAN) return processNaN(env, fmt, b.t, op2, fpexc)
  if (a.t === QNAN) return processNaN(env, fmt, a.t, op1, fpexc)
  if (b.t === QNAN) return processNaN(env, fmt, b.t, op2, fpexc)
  return null
}

/** FPProcessNaNs3, operands in pseudocode order (the addend first for multiply-add). */
export function processNaNs3(env: FpEnv, fmt: Fmt, a: Val, b: Val, c: Val, op1: bigint, op2: bigint, op3: bigint, fpexc = true): bigint | null {
  if (env.altfp) {
    const tn = a.t === SNAN || b.t === SNAN || c.t === SNAN ? SNAN : QNAN
    const an = isNaNT(a.t)
    const bn = isNaNT(b.t)
    const cn = isNaNT(c.t)
    if (bn && (an || cn)) return processNaN(env, fmt, tn, op2, fpexc)
    if (cn && an) return processNaN(env, fmt, tn, op3, fpexc)
  }
  if (a.t === SNAN) return processNaN(env, fmt, a.t, op1, fpexc)
  if (b.t === SNAN) return processNaN(env, fmt, b.t, op2, fpexc)
  if (c.t === SNAN) return processNaN(env, fmt, c.t, op3, fpexc)
  if (a.t === QNAN) return processNaN(env, fmt, a.t, op1, fpexc)
  if (b.t === QNAN) return processNaN(env, fmt, b.t, op2, fpexc)
  if (c.t === QNAN) return processNaN(env, fmt, c.t, op3, fpexc)
  return null
}

/* ------------------------------------------------------------------ exact values */

/** a + b as an exact value (m may be negative). */
function addExact(a: Val, b: Val): { m: bigint; x: number } {
  const ma = a.t === NUM ? (a.s ? -a.m : a.m) : 0n
  const mb = b.t === NUM ? (b.s ? -b.m : b.m) : 0n
  if (ma === 0n) return { m: mb, x: b.x }
  if (mb === 0n) return { m: ma, x: a.x }
  const x = Math.min(a.x, b.x)
  return { m: (ma << B(a.x - x)) + (mb << B(b.x - x)), x }
}

/** Round a signed exact value; an exact zero takes its sign from the rounding mode. */
function roundSigned(env: FpEnv, fmt: Fmt, m: bigint, x: number, rounding = env.rmode, opts?: RoundOpts): bigint {
  if (m === 0n) return zeroOf(fmt, rounding === RM ? 1 : 0)
  return m < 0n ? round(env, fmt, 1, -m, x, rounding, opts) : round(env, fmt, 0, m, x, rounding, opts)
}

/** Compare two non-NaN values: -1, 0 or 1. */
function compareVals(a: Val, b: Val): number {
  const sa = a.t === ZERO ? 0 : a.s ? -1 : 1
  const sb = b.t === ZERO ? 0 : b.s ? -1 : 1
  if (a.t === INF || b.t === INF) {
    const va = a.t === INF ? sa * 2 : a.t === ZERO ? 0 : sa
    const vb = b.t === INF ? sb * 2 : b.t === ZERO ? 0 : sb
    return Math.sign(va - vb)
  }
  const d = addExact(a, { ...b, s: b.s ^ 1 })
  return d.m === 0n ? 0 : d.m < 0n ? -1 : 1
}

/* ------------------------------------------------------------------ sign operations */

/** FPNeg and FPAbs: with AH = 1 a NaN keeps its sign. */
export function fpNeg(env: FpEnv, fmt: Fmt, op: bigint): bigint {
  return env.altfp && isNaN_(fmt, op) ? op : op ^ signBit(fmt)
}
export function fpAbs(env: FpEnv, fmt: Fmt, op: bigint): bigint {
  return env.altfp && isNaN_(fmt, op) ? op : op & ~signBit(fmt)
}

/* ------------------------------------------------------------------ arithmetic */

export function fpAdd(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint, negate2 = false, fpexc = true): bigint {
  const rounding = env.rmode
  const a = unpack(env, fmt, op1, fpexc)
  let b = unpack(env, fmt, op2, fpexc)
  const nan = processNaNs(env, fmt, a, b, op1, op2, fpexc)
  if (nan !== null) return nan
  if (negate2) b = { ...b, s: b.s ^ 1 }
  let r: bigint
  if (a.t === INF && b.t === INF && a.s !== b.s) {
    r = defaultNaN(fmt, env)
    if (fpexc) env.flags |= IOC
  } else if ((a.t === INF && a.s === 0) || (b.t === INF && b.s === 0)) r = infOf(fmt, 0)
  else if ((a.t === INF && a.s === 1) || (b.t === INF && b.s === 1)) r = infOf(fmt, 1)
  else if (a.t === ZERO && b.t === ZERO && a.s === b.s) r = zeroOf(fmt, a.s)
  else {
    const v = addExact(a, b)
    r = roundSigned(env, fmt, v.m, v.x, rounding, { fpexc })
  }
  if (fpexc) denorms(env, fmt, a, b)
  return r
}

export function fpSub(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint, fpexc = true): bigint {
  return fpAdd(env, fmt, op1, op2, true, fpexc)
}

export function fpMul(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint, fpexc = true): bigint {
  const a = unpack(env, fmt, op1, fpexc)
  const b = unpack(env, fmt, op2, fpexc)
  const nan = processNaNs(env, fmt, a, b, op1, op2, fpexc)
  if (nan !== null) return nan
  let r: bigint
  const s = a.s ^ b.s
  if ((a.t === INF && b.t === ZERO) || (a.t === ZERO && b.t === INF)) {
    r = defaultNaN(fmt, env)
    if (fpexc) env.flags |= IOC
  } else if (a.t === INF || b.t === INF) r = infOf(fmt, s)
  else if (a.t === ZERO || b.t === ZERO) r = zeroOf(fmt, s)
  else r = round(env, fmt, s, a.m * b.m, a.x + b.x, env.rmode, { fpexc })
  if (fpexc) denorms(env, fmt, a, b)
  return r
}

/** FMULX: infinity times zero is ±2.0 instead of a NaN. */
export function fpMulX(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint): bigint {
  const a = unpack(env, fmt, op1)
  const b = unpack(env, fmt, op2)
  const nan = processNaNs(env, fmt, a, b, op1, op2)
  if (nan !== null) return nan
  const s = a.s ^ b.s
  let r: bigint
  if ((a.t === INF && b.t === ZERO) || (a.t === ZERO && b.t === INF)) r = twoOf(fmt, s)
  else if (a.t === INF || b.t === INF) r = infOf(fmt, s)
  else if (a.t === ZERO || b.t === ZERO) r = zeroOf(fmt, s)
  else r = round(env, fmt, s, a.m * b.m, a.x + b.x)
  denorms(env, fmt, a, b)
  return r
}

export function fpDiv(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint): bigint {
  const a = unpack(env, fmt, op1)
  const b = unpack(env, fmt, op2)
  const nan = processNaNs(env, fmt, a, b, op1, op2)
  if (nan !== null) return nan
  const s = a.s ^ b.s
  let r: bigint
  if ((a.t === INF && b.t === INF) || (a.t === ZERO && b.t === ZERO)) {
    r = defaultNaN(fmt, env)
    env.flags |= IOC
  } else if (a.t === INF || b.t === ZERO) {
    r = infOf(fmt, s)
    if (a.t !== INF) env.flags |= DZC
  } else if (a.t === ZERO || b.t === INF) r = zeroOf(fmt, s)
  else {
    // Enough quotient bits for the rounding position plus a sticky bit for the remainder.
    const k = Math.max(0, fmt.f + 3 + bitLength(b.m) - bitLength(a.m)) + 2
    const num = a.m << B(k)
    const q = num / b.m
    const sticky = num % b.m !== 0n ? 1n : 0n
    r = round(env, fmt, s, (q << 1n) | sticky, a.x - b.x - k - 1)
  }
  denorms(env, fmt, a, b)
  return r
}

/** Integer square root, rounded down. */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = B(Math.floor(Math.sqrt(Number(n))))
  if (x === 0n) x = 1n
  // Newton steps from the float estimate (exact for small n, a few steps for large).
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) break
    x = y
  }
  while (x * x > n) x--
  while ((x + 1n) * (x + 1n) <= n) x++
  return x
}

export function fpSqrt(env: FpEnv, fmt: Fmt, op: bigint): bigint {
  const a = unpack(env, fmt, op)
  let r: bigint
  if (a.t === QNAN || a.t === SNAN) r = processNaN(env, fmt, a.t, op)
  else if (a.t === ZERO) r = zeroOf(fmt, a.s)
  else if (a.t === INF && a.s === 0) r = infOf(fmt, 0)
  else if (a.s === 1) {
    r = defaultNaN(fmt, env)
    env.flags |= IOC
  } else {
    // m × 2^x with x even and m wide enough for the result bits plus a sticky bit.
    let m = a.m
    let x = a.x
    const want = 2 * (fmt.f + 4)
    let shift = Math.max(0, want - bitLength(m))
    if ((x - shift) % 2 !== 0) shift++
    m <<= B(shift)
    x -= shift
    const root = isqrt(m)
    const sticky = root * root !== m ? 1n : 0n
    r = round(env, fmt, 0, (root << 1n) | sticky, x / 2 - 1)
  }
  denorms(env, fmt, a)
  return r
}

/** FPMulAdd: addend + op1 × op2, rounded once. */
export function fpMulAdd(env: FpEnv, fmt: Fmt, addend: bigint, op1: bigint, op2: bigint, fpexc = true): bigint {
  const rounding = env.rmode
  const A = unpack(env, fmt, addend, fpexc)
  const a = unpack(env, fmt, op1, fpexc)
  const b = unpack(env, fmt, op2, fpexc)
  const infZero = (a.t === INF && b.t === ZERO) || (a.t === ZERO && b.t === INF)
  let r = processNaNs3(env, fmt, A, a, b, addend, op1, op2, fpexc)
  const done = r !== null
  if (!env.altfp && A.t === QNAN && infZero) {
    r = defaultNaN(fmt, env)
    if (fpexc) env.flags |= IOC
  }
  if (done) return r!
  const sP = a.s ^ b.s
  const infP = a.t === INF || b.t === INF
  const zeroP = a.t === ZERO || b.t === ZERO
  const invalid = infZero || (A.t === INF && infP && A.s !== sP)
  if (invalid) {
    r = defaultNaN(fmt, env)
    if (fpexc) env.flags |= IOC
  } else if ((A.t === INF && A.s === 0) || (infP && sP === 0)) r = infOf(fmt, 0)
  else if ((A.t === INF && A.s === 1) || (infP && sP === 1)) r = infOf(fmt, 1)
  else if (A.t === ZERO && zeroP && A.s === sP) r = zeroOf(fmt, A.s)
  else {
    const prod: Val = zeroP ? { t: ZERO, s: sP, m: 0n, x: 0, d: false } : { t: NUM, s: sP, m: a.m * b.m, x: a.x + b.x, d: false }
    const v = addExact(A, prod)
    r = roundSigned(env, fmt, v.m, v.x, rounding, { fpexc })
  }
  if (!invalid && fpexc) denorms(env, fmt, A, a, b)
  return r!
}

/** FSCALE: op × 2^n, rounded once. */
export function fpScale(env: FpEnv, fmt: Fmt, op: bigint, n: number): bigint {
  const v = unpack(env, fmt, op)
  if (v.t === QNAN || v.t === SNAN) return processNaN(env, fmt, v.t, op)
  denorms(env, fmt, v)
  if (v.t === ZERO) return zeroOf(fmt, v.s)
  if (v.t === INF) return infOf(fmt, v.s)
  return round(env, fmt, v.s, v.m, v.x + Math.max(-5000, Math.min(5000, n)))
}

/** A NaN of format `from` as a NaN of format `to` (FPConvertNaN: sign and the top payload bits kept). */
function widenNaN(from: Fmt, to: Fmt, bits: bigint): bigint {
  const s = (bits >> B(from.n - 1)) & 1n
  const frac = bits & ones(from.f)
  return (s << B(to.n - 1)) | (ones(to.e) << B(to.f)) | (frac << B(to.f - from.f))
}

/**
 * FPDot: op1a × op2a + op1b × op2b with a single rounding; the four factors are 16-bit (`src`), the result
 * single precision. NaNs first: signalling before quiet, in operand order (FPProcessNaNs4).
 */
export function fpDot(env: FpEnv, src: Fmt, op1a: bigint, op1b: bigint, op2a: bigint, op2b: bigint, fpexc = true): bigint {
  const f = [op1a, op1b, op2a, op2b]
  const v = f.map((x) => unpack(env, src, x, fpexc))
  for (const t of [SNAN, QNAN]) {
    const i = v.findIndex((x) => x.t === t)
    if (i >= 0) return processNaN(env, F32, t, widenNaN(src, F32, f[i]!), fpexc)
  }
  const prods = [0, 1].map((k) => {
    const x = v[k]!
    const y = v[k + 2]!
    return { s: x.s ^ y.s, inf: x.t === INF || y.t === INF, zero: x.t === ZERO || y.t === ZERO, x, y }
  })
  const [pa, pb] = prods as [(typeof prods)[0], (typeof prods)[0]]
  if (prods.some((p) => p.inf && p.zero) || (pa.inf && pb.inf && pa.s !== pb.s)) {
    if (fpexc) env.flags |= IOC
    return defaultNaN(F32, env)
  }
  if ((pa.inf && pa.s === 0) || (pb.inf && pb.s === 0)) return infOf(F32, 0)
  if (pa.inf || pb.inf) return infOf(F32, 1)
  if (pa.zero && pb.zero && pa.s === pb.s) return zeroOf(F32, pa.s)
  const val = (p: (typeof prods)[0]): Val => (p.zero ? { t: ZERO, s: p.s, m: 0n, x: 0, d: false } : { t: NUM, s: p.s, m: p.x.m * p.y.m, x: p.x.x + p.y.x, d: false })
  const sum = addExact(val(pa), val(pb))
  return roundSigned(env, F32, sum.m, sum.x, env.rmode, { fpexc })
}

/** FRECPS: 2 − op1 × op2, fused (infinity times zero gives 2.0). */
export function fpRecipStep(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint): bigint {
  return stepFused(env, fmt, op1, op2, false)
}
/** FRSQRTS: (3 − op1 × op2) / 2, fused (infinity times zero gives 1.5). */
export function fpRSqrtStep(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint): bigint {
  return stepFused(env, fmt, op1, op2, true)
}
function stepFused(env0: FpEnv, fmt: Fmt, op1In: bigint, op2: bigint, sqrt: boolean): bigint {
  // With FPCR.AH: denormals flushed, round to nearest, and no exception flags.
  const altfp = env0.altfp
  const env = altfp ? env0.with(FIZ | FZ, 3 << 22) : env0
  const fpexc = !altfp
  const op1 = fpNeg(env, fmt, op1In)
  const a = unpack(env, fmt, op1, fpexc)
  const b = unpack(env, fmt, op2, fpexc)
  const nan = processNaNs(env, fmt, a, b, op1, op2, fpexc)
  if (nan !== null) return nan
  let r: bigint
  if ((a.t === INF && b.t === ZERO) || (a.t === ZERO && b.t === INF)) r = sqrt ? onePointFive(fmt, 0) : twoOf(fmt, 0)
  else if (a.t === INF || b.t === INF) r = infOf(fmt, a.s ^ b.s)
  else {
    const prod: Val = a.t === ZERO || b.t === ZERO ? { t: ZERO, s: 0, m: 0n, x: 0, d: false } : { t: NUM, s: a.s ^ b.s, m: a.m * b.m, x: a.x + b.x, d: false }
    const c: Val = { t: NUM, s: 0, m: sqrt ? 3n : 2n, x: 0, d: false }
    const v = addExact(c, prod)
    r = roundSigned(env, fmt, v.m, sqrt ? v.x - 1 : v.x, env.rmode, { fpexc })
  }
  if (fpexc) denorms(env, fmt, a, b)
  return r
}

/* ------------------------------------------------------------------ min and max */

/** FPMax / FPMin. `alt`: the instruction honours FPCR.AH (FMAX, FMIN; not the NM forms). */
export function fpMaxMin(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint, max: boolean, alt: boolean): bigint {
  const altfp = alt && env.altfp
  const a = unpack(env, fmt, op1)
  const b = unpack(env, fmt, op2)
  if (altfp && a.t === ZERO && b.t === ZERO && a.s !== b.s) return zeroOf(fmt, b.s)
  if (altfp && (isNaNT(a.t) || isNaNT(b.t))) {
    env.flags |= IOC
    return b.t === ZERO ? zeroOf(fmt, b.s) : op2
  }
  const nan = processNaNs(env, fmt, a, b, op1, op2)
  if (nan !== null) return nan
  const c = compareVals(a, b)
  const pick = (max ? c > 0 : c < 0) ? a : b
  let r: bigint
  if (pick.t === INF) r = infOf(fmt, pick.s)
  else if (pick.t === ZERO) r = zeroOf(fmt, max ? a.s & b.s : a.s | b.s)
  else r = round(altfp ? env.with(0, FZ | FZ16) : env, fmt, pick.s, pick.m, pick.x, env.rmode)
  denorms(env, fmt, a, b)
  return r
}

/** FPMaxNum / FPMinNum: a single quiet NaN loses to a number. */
export function fpMaxMinNum(env: FpEnv, fmt: Fmt, op1In: bigint, op2In: bigint, max: boolean): bigint {
  let op1 = op1In
  let op2 = op2In
  const t1 = unpack(env.with(0), fmt, op1, false).t
  const t2 = unpack(env.with(0), fmt, op2, false).t
  if (!(env.altfp && isNaNT(t1) && isNaNT(t2))) {
    if (t1 === QNAN && t2 !== QNAN) op1 = infOf(fmt, max ? 1 : 0)
    else if (t1 !== QNAN && t2 === QNAN) op2 = infOf(fmt, max ? 1 : 0)
  }
  return fpMaxMin(env, fmt, op1, op2, max, false)
}

/* ------------------------------------------------------------------ comparisons */

/** FPCompare: NZCV for FCMP (signal: FCMPE, which also signals on quiet NaNs). */
export function fpCompare(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint, signal: boolean): number {
  const a = unpack(env, fmt, op1)
  const b = unpack(env, fmt, op2)
  if (isNaNT(a.t) || isNaNT(b.t)) {
    if (a.t === SNAN || b.t === SNAN || signal) env.flags |= IOC
    return 0b0011
  }
  denorms(env, fmt, a, b)
  const c = compareVals(a, b)
  return c === 0 ? 0b0110 : c < 0 ? 0b1000 : 0b0010
}

/** FPCompareEQ, FPCompareGE, FPCompareGT (the vector compares). */
export function fpCompareOp(env: FpEnv, fmt: Fmt, op1: bigint, op2: bigint, kind: 'eq' | 'ge' | 'gt'): boolean {
  const a = unpack(env, fmt, op1)
  const b = unpack(env, fmt, op2)
  if (isNaNT(a.t) || isNaNT(b.t)) {
    if (kind !== 'eq' || a.t === SNAN || b.t === SNAN) env.flags |= IOC
    return false
  }
  denorms(env, fmt, a, b)
  const c = compareVals(a, b)
  return kind === 'eq' ? c === 0 : kind === 'ge' ? c >= 0 : c > 0
}

/* ------------------------------------------------------------------ conversions */

/** FPConvertNaN: a NaN in another format, quieted, keeping the top fraction bits. */
function convertNaN(from: Fmt, to: Fmt, op: bigint): bigint {
  const s = (op >> B(from.n - 1)) & 1n
  let frac = (op & ones(from.f - 1)) as bigint
  // The payload below the quiet bit, aligned at the top.
  frac = from.f > to.f ? frac >> B(from.f - to.f) : frac << B(to.f - from.f)
  return (s << B(to.n - 1)) | (ones(to.e) << B(to.f)) | quietBit(to) | (frac & ones(to.f - 1))
}

/** FPConvert between half, single and double precision (FCVT). */
export function fpConvert(env: FpEnv, from: Fmt, to: Fmt, op: bigint, rounding = env.rmode): bigint {
  const ahpIn = from === F16 && (env.fpcr & AHP) !== 0
  const altHp = to === F16 && (env.fpcr & AHP) !== 0
  const v = unpack(env, from, op, true, ahpIn, true)
  let r: bigint
  if (isNaNT(v.t)) {
    if (altHp) r = zeroOf(to, v.s)
    else if (env.fpcr & DN) r = defaultNaN(to, env)
    else r = convertNaN(from, to, op)
    if (v.t === SNAN || altHp) env.flags |= IOC
  } else if (v.t === INF) {
    if (altHp) {
      r = (v.s ? signBit(to) : 0n) | ones(to.n - 1)
      env.flags |= IOC
    } else r = infOf(to, v.s)
  } else if (v.t === ZERO) r = zeroOf(to, v.s)
  else {
    r = round(env, to, v.s, v.m, v.x, rounding, { ahp: altHp, noFlush: to === F16 })
    denorms(env, from, v)
  }
  return r
}

/** FPConvertBF: single precision to BFloat16 (BFCVT, BFCVTN). */
export function fpConvertBF(env0: FpEnv, op: bigint): bigint {
  const altfp = env0.altfp
  const env = altfp ? env0.with(FIZ | FZ, 3 << 22) : env0
  const fpexc = !altfp
  const v = unpack(env, F32, op, fpexc)
  let r: bigint
  if (isNaNT(v.t)) {
    r = env.fpcr & DN ? defaultNaN(F32, env) : op | quietBit(F32)
    if (v.t === SNAN && fpexc) env.flags |= IOC
  } else if (v.t === INF) r = infOf(F32, v.s)
  else if (v.t === ZERO) r = zeroOf(F32, v.s)
  else return round(env, BF16, v.s, v.m, v.x, altfp ? RN : env.rmode, { fpexc })
  return r >> 16n
}

/** FPRoundInt (FRINTN, FRINTP, FRINTM, FRINTZ, FRINTA, FRINTI, FRINTX). `exact`: FRINTX signals inexact. */
export function fpRoundInt(env: FpEnv, fmt: Fmt, op: bigint, rounding: number, exact: boolean): bigint {
  const v = unpack(env, fmt, op)
  if (isNaNT(v.t)) return processNaN(env, fmt, v.t, op)
  if (v.t === INF) return infOf(fmt, v.s)
  if (v.t === ZERO) return zeroOf(fmt, v.s)
  const [int, rest, r] = roundToInt(v, rounding)
  // No FPProcessDenorm here: the CPU sets no IDC for a kept denormal input with AH = 1.
  if (rest !== 0 && exact) env.flags |= IXC
  return r === 0n ? zeroOf(fmt, v.s) : round(env, fmt, int < 0n ? 1 : 0, int < 0n ? -int : int, 0, RZ)
}

/** The signed integer a value rounds to: [integer, where the rest lay (0 exact), integer again]. */
function roundToInt(v: Val, rounding: number): [bigint, number, bigint] {
  // Round the magnitude toward minus infinity of the signed value: floor.
  const [q, rest] = split(v.m, v.x)
  let int = v.s ? -q : q
  // floor for negatives with a remainder is one lower.
  if (v.s && rest !== 0) int -= 1n
  // error = value − floor, as a "rest" relative to one: for negatives the rest flips around the half.
  const err = v.s && rest !== 0 ? 4 - rest : rest
  let up = false
  switch (rounding) {
    case RN:
      up = err === 3 || (err === 2 && (int & 1n) === 1n)
      break
    case RP:
      up = err !== 0
      break
    case RM:
      up = false
      break
    case RZ:
      up = err !== 0 && int < 0n
      break
    case RA:
      up = err === 3 || (err === 2 && int >= 0n)
      break
  }
  if (up) int++
  return [int, rest, int]
}

/** FPRoundIntN (FRINT32Z, FRINT32X, FRINT64Z, FRINT64X). */
export function fpRoundIntN(env: FpEnv, fmt: Fmt, op: bigint, rounding: number, intsize: number): bigint {
  const v = unpack(env, fmt, op)
  const minInt = () => round(env.with(0, FZ | FZ16), fmt, 1, 1n, intsize - 1, RZ)
  if (isNaNT(v.t) || v.t === INF) {
    env.flags |= IOC
    return minInt()
  }
  if (v.t === ZERO) return zeroOf(fmt, v.s)
  const [int, rest] = roundToInt(v, rounding)
  // No FPProcessDenorm here: the CPU sets no IDC for a kept denormal input with AH = 1.
  const lim = 1n << B(intsize - 1)
  if (int >= lim || int < -lim) {
    env.flags |= IOC
    return minInt()
  }
  if (rest !== 0) env.flags |= IXC
  return int === 0n ? zeroOf(fmt, v.s) : round(env, fmt, int < 0n ? 1 : 0, int < 0n ? -int : int, 0, RZ)
}

/** FPToFixed: to a signed or unsigned integer of `bits` bits with `fbits` fraction bits, saturating (FCVT*S, FCVT*U). */
export function fpToFixed(env: FpEnv, fmt: Fmt, op: bigint, fbits: number, unsigned: boolean, rounding: number, bits: number): bigint {
  const v = unpack(env, fmt, op)
  if (isNaNT(v.t)) env.flags |= IOC
  let int: bigint
  let rest = 0
  if (v.t === NUM) {
    ;[int, rest] = roundToInt({ ...v, x: v.x + fbits }, rounding)
  } else if (v.t === INF) int = v.s ? -(1n << 2000n) : 1n << 2000n
  else int = 0n
  const lo = unsigned ? 0n : -(1n << B(bits - 1))
  const hi = unsigned ? (1n << B(bits)) - 1n : (1n << B(bits - 1)) - 1n
  let r = int
  if (int < lo || int > hi) {
    r = int < lo ? lo : hi
    env.flags |= IOC
  } else if (rest !== 0) env.flags |= IXC
  // No FPProcessDenorm here: the CPU sets no IDC for a kept denormal input with AH = 1.
  return BigInt.asUintN(bits, r)
}

/** FixedToFP: a `bits`-bit integer with `fbits` fraction bits to floating point (SCVTF, UCVTF). */
export function fixedToFp(env: FpEnv, fmt: Fmt, op: bigint, fbits: number, unsigned: boolean, bits: number, rounding = env.rmode): bigint {
  const int = unsigned ? BigInt.asUintN(bits, op) : BigInt.asIntN(bits, op)
  if (int === 0n) return zeroOf(fmt, 0)
  return round(env, fmt, int < 0n ? 1 : 0, int < 0n ? -int : int, -fbits, rounding)
}

/** FPToFixedJS (FJCVTZS): JavaScript's ToInt32, and whether it was exact (the Z flag). */
export function fpToFixedJS(env: FpEnv, op: bigint): { value: bigint; z: boolean } {
  const v = unpack(env, F64, op)
  let z = true
  if (isNaNT(v.t)) {
    env.flags |= IOC
    z = false
  }
  let int = 0n
  let rest = 0
  if (v.t === NUM) [int, rest] = roundToInt(v, RZ)
  const big = v.t === INF || int < -(1n << 31n) || int > (1n << 31n) - 1n
  if (big) {
    env.flags |= IOC
    z = false
  } else if (rest !== 0) {
    env.flags |= IXC
    z = false
  } else if (v.t === ZERO && v.s) z = false
  else if (v.t === ZERO && (op & ones(52)) !== 0n) z = false
  if (v.t === INF) int = 0n
  return { value: BigInt.asUintN(32, int), z }
}

/* ------------------------------------------------------------------ estimates */

/** RecipEstimate: a in 256..511 (or 4096..8191 with increased precision) to the reciprocal's bits. */
export function recipEstimate(a: number, increased: boolean): number {
  if (!increased) {
    const b = Math.floor((1 << 19) / (a * 2 + 1))
    return (b + 1) >> 1
  }
  const d = a * 2 + 1
  // 2^25 / d rounded to nearest (never a tie).
  const q = Math.floor(2 ** 25 / d)
  const err = 2 ** 25 - q * d
  return 2 * err > d ? q + 1 : q
}

/** RecipSqrtEstimate: a in 128..511 (or 1024..4095 with increased precision), x = a / 512 (or / 4096). */
export function recipSqrtEstimate(aIn: number, increased: boolean): number {
  const [half, start, limit] = increased ? [2048, 8192, 2n ** 39n] : [256, 512, 2n ** 28n]
  let a = aIn
  // To units of 1/1024 (1/8192) rounded to nearest: 0.25..0.5 keep every bit, 0.5..1 drop the bottom one.
  if (a < half) a = a * 2 + 1
  else {
    a = (a >> 1) << 1
    a = (a + 1) * 2
  }
  // The largest b with a × b² below the limit, then halved with rounding.
  const A = B(a)
  let b = B(Math.max(start, Math.floor(Math.sqrt(Number(limit) / a)) - 2))
  while (A * (b + 1n) * (b + 1n) < limit) b++
  return Number((b + 1n) >> 1n)
}

/** Raw fields of an operand: [sign, exponent, fraction widened to 52 bits]. */
function fields52(fmt: Fmt, op: bigint): [number, number, bigint] {
  const s = Number((op >> B(fmt.n - 1)) & 1n)
  const exp = Number((op >> B(fmt.f)) & ones(fmt.e))
  return [s, exp, (op & ones(fmt.f)) << B(52 - fmt.f)]
}

/** FPRecipEstimate (FRECPE). `rpres`: FEAT_RPRES, used for single precision when AH = 1. */
export function fpRecipEstimate(env0: FpEnv, fmt: Fmt, op: bigint, rpres = true): bigint {
  const altfp = env0.altfp
  const env = altfp ? env0.with(FIZ | FZ, 3 << 22) : env0
  const fpexc = !altfp
  const v = unpack(env, fmt, op, fpexc)
  const rounding = env.rmode
  const N = fmt.n
  if (isNaNT(v.t)) return processNaN(env, fmt, v.t, op, fpexc)
  if (v.t === INF) return zeroOf(fmt, v.s)
  if (v.t === ZERO) {
    if (fpexc) env.flags |= DZC
    return infOf(fmt, v.s)
  }
  const mag = bitLength(v.m) - 1 + v.x // floor(log2 |value|)
  const tiny = N === 16 ? -16 : N === 32 ? -128 : -1024
  if (mag < tiny) {
    const toInf = rounding === RN || (rounding === RP && v.s === 0) || (rounding === RM && v.s === 1)
    if (fpexc) env.flags |= OFC | IXC
    return toInf ? infOf(fmt, v.s) : maxNormal(fmt, v.s)
  }
  const fz = fmt === F16 ? (env.fpcr & FZ16) !== 0 : (env.fpcr & FZ) !== 0
  if (fz && mag >= (N === 16 ? 14 : N === 32 ? 126 : 1022)) {
    if (fpexc) env.flags |= UFC
    return zeroOf(fmt, v.s)
  }
  let [, exp, fraction] = fields52(fmt, op)
  const sign = v.s
  if (exp === 0) {
    if (((fraction >> 51n) & 1n) === 0n) {
      exp = -1
      fraction = (fraction << 2n) & ones(52)
    } else fraction = (fraction << 1n) & ones(52)
  }
  const inc = N === 32 && rpres && altfp
  const scaled = inc ? Number((1n << 11n) | (fraction >> 41n)) : Number((1n << 8n) | (fraction >> 44n))
  let rexp = (N === 16 ? 29 : N === 32 ? 253 : 2045) - exp
  const est = recipEstimate(scaled, inc)
  fraction = inc ? B(est & 0xfff) << 40n : B(est & 0xff) << 44n
  if (rexp === 0) fraction = (1n << 51n) | (fraction >> 1n)
  else if (rexp === -1) {
    fraction = (1n << 50n) | (fraction >> 2n)
    rexp = 0
  }
  return (B(sign) << B(N - 1)) | (B(rexp) << B(fmt.f)) | (fraction >> B(52 - fmt.f))
}

/** FPRSqrtEstimate (FRSQRTE). */
export function fpRSqrtEstimate(env0: FpEnv, fmt: Fmt, op: bigint, rpres = true): bigint {
  const altfp = env0.altfp
  const env = altfp ? env0.with(FIZ | FZ, 3 << 22) : env0
  const fpexc = !altfp
  const v = unpack(env, fmt, op, fpexc)
  const N = fmt.n
  if (isNaNT(v.t)) return processNaN(env, fmt, v.t, op, fpexc)
  if (v.t === ZERO) {
    if (fpexc) env.flags |= DZC
    return infOf(fmt, v.s)
  }
  if (v.s === 1) {
    if (fpexc) env.flags |= IOC
    return defaultNaN(fmt, env)
  }
  if (v.t === INF) return zeroOf(fmt, 0)
  let [, exp, fraction] = fields52(fmt, op)
  if (exp === 0) {
    while (((fraction >> 51n) & 1n) === 0n) {
      fraction = (fraction << 1n) & ones(52)
      exp--
    }
    fraction = (fraction << 1n) & ones(52)
  }
  const inc = N === 32 && rpres && altfp
  const even = (exp & 1) === 0
  // Even exponents give 0.5 ≤ x < 1 ('1':fraction), odd ones 0.25 ≤ x < 0.5 ('01':fraction).
  const scaled = inc ? Number(even ? (1n << 11n) | (fraction >> 41n) : (1n << 10n) | (fraction >> 42n)) : Number(even ? (1n << 8n) | (fraction >> 44n) : (1n << 7n) | (fraction >> 45n))
  const rexp = Math.floor(((N === 16 ? 44 : N === 32 ? 380 : 3068) - exp) / 2)
  const est = recipSqrtEstimate(scaled, inc)
  const top = inc ? B(est & 0xfff) << 40n : B(est & 0xff) << 44n
  return (B(rexp) << B(fmt.f)) | (top >> B(52 - fmt.f))
}

/** FPRecpX (FRECPX): the exponent inverted, the fraction cleared. */
export function fpRecpX(env0: FpEnv, fmt: Fmt, op: bigint): bigint {
  const altfp = env0.altfp
  const env = altfp ? env0.with(FIZ | FZ) : env0
  const v = unpack(env, fmt, op, !altfp)
  if (isNaNT(v.t)) return processNaN(env, fmt, v.t, op, !altfp)
  const exp = (op >> B(fmt.f)) & ones(fmt.e)
  const sign = op & signBit(fmt)
  if (exp === 0n) return sign | ((ones(fmt.e) - 1n) << B(fmt.f))
  return sign | ((~exp & ones(fmt.e)) << B(fmt.f))
}

/* ------------------------------------------------------------------ host numbers */

/** A bit pattern as a JavaScript number (for display and printf). */
export function toNumber(fmt: Fmt, bits: bigint): number {
  const s = Number((bits >> B(fmt.n - 1)) & 1n) ? -1 : 1
  const ex = Number((bits >> B(fmt.f)) & ones(fmt.e))
  const fr = Number(bits & ones(fmt.f))
  const bias = (1 << (fmt.e - 1)) - 1
  if (ex === (1 << fmt.e) - 1) return fr ? NaN : s * Infinity
  if (ex === 0) return s * fr * 2 ** (1 - bias - fmt.f)
  return s * (fr + 2 ** fmt.f) * 2 ** (ex - bias - fmt.f)
}

/** A JavaScript number as a bit pattern, rounded to nearest. */
export function fromNumber(fmt: Fmt, v: number): bigint {
  const buf = new DataView(new ArrayBuffer(8))
  buf.setFloat64(0, v)
  const d = buf.getBigUint64(0)
  if (fmt === F64) return d
  const env = new FpEnv(0)
  return fpConvert(env, F64, fmt, d, RN)
}
