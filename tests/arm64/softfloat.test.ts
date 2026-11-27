/**
 * The soft-float core against the host's IEEE double and single arithmetic (round to nearest), plus the
 * flags and special cases the host cannot show. Bit-exact behaviour of every mode and FPCR control is
 * checked against the real CPU in native.test.ts.
 */
import { describe, expect, it } from 'vitest'
import * as sf from '../../src/isa/arm64/softfloat'

const dv = new DataView(new ArrayBuffer(8))
const bitsD = (v: number) => (dv.setFloat64(0, v), dv.getBigUint64(0))
const bitsS = (v: number) => (dv.setFloat32(0, v), BigInt(dv.getUint32(0)))
const numD = (b: bigint) => (dv.setBigUint64(0, b), dv.getFloat64(0))
const numS = (b: bigint) => (dv.setUint32(0, Number(b)), dv.getFloat32(0))

/** Random doubles over many magnitudes, with some specials. */
function values(n: number, seed: number): number[] {
  let s = seed
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff)
  const out = [0, -0, 1, -1, 0.5, 3, Infinity, -Infinity, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308]
  while (out.length < n) out.push((r() - 0.5) * 2 ** Math.floor((r() - 0.5) * 2100))
  return out
}

describe('soft float', () => {
  const vs = values(300, 3)
  const env = () => new sf.FpEnv(0)

  it('adds, multiplies, divides and takes square roots like the host in double precision', () => {
    for (let i = 0; i < vs.length; i++)
      for (let j = 0; j < vs.length; j += 7) {
        const a = vs[i]!
        const b = vs[j]!
        const same = (got: bigint, want: number, what: string) => {
          if (Number.isNaN(want)) expect(Number.isNaN(numD(got)), what).toBe(true)
          else expect(numD(got), `${what} ${a} ${b}`).toBe(want)
        }
        same(sf.fpAdd(env(), sf.F64, bitsD(a), bitsD(b)), a + b, 'add')
        same(sf.fpSub(env(), sf.F64, bitsD(a), bitsD(b)), a - b, 'sub')
        same(sf.fpMul(env(), sf.F64, bitsD(a), bitsD(b)), a * b, 'mul')
        same(sf.fpDiv(env(), sf.F64, bitsD(a), bitsD(b)), a / b, 'div')
      }
    for (const a of vs) {
      const r = sf.fpSqrt(env(), sf.F64, bitsD(a))
      if (a < 0) expect(Number.isNaN(numD(r))).toBe(true)
      else expect(numD(r)).toBe(Math.sqrt(a))
    }
  })

  it('rounds single precision like Math.fround', () => {
    for (let i = 0; i < 200; i++)
      for (let j = 0; j < 200; j += 13) {
        const a = Math.fround(vs[i]! % 1e30)
        const b = Math.fround(vs[j]! % 1e30)
        expect(numS(sf.fpAdd(env(), sf.F32, bitsS(a), bitsS(b)))).toBe(Math.fround(a + b))
        expect(numS(sf.fpMul(env(), sf.F32, bitsS(a), bitsS(b)))).toBe(Math.fround(a * b))
        const q = sf.fpDiv(env(), sf.F32, bitsS(a), bitsS(b))
        if (!Number.isNaN(a / b)) expect(numS(q)).toBe(Math.fround(a / b))
      }
  })

  it('raises the exception flags', () => {
    const e = env()
    sf.fpDiv(e, sf.F64, bitsD(1), bitsD(3))
    expect(e.flags).toBe(sf.IXC)
    const z = env()
    sf.fpDiv(z, sf.F64, bitsD(1), bitsD(0))
    expect(z.flags).toBe(sf.DZC)
    const o = env()
    expect(numD(sf.fpMul(o, sf.F64, bitsD(1e300), bitsD(1e300)))).toBe(Infinity)
    expect(o.flags).toBe(sf.OFC | sf.IXC)
    const u = env()
    sf.fpMul(u, sf.F64, bitsD(1e-300), bitsD(1e-20))
    expect(u.flags).toBe(sf.UFC | sf.IXC)
    const n = env()
    sf.fpAdd(n, sf.F64, bitsD(Infinity), bitsD(-Infinity))
    expect(n.flags).toBe(sf.IOC)
  })

  it('converts between formats and to integers', () => {
    const e = env()
    expect(sf.fpConvert(e, sf.F64, sf.F16, bitsD(1.5))).toBe(0x3e00n)
    expect(sf.fpConvert(e, sf.F16, sf.F64, 0x3e00n)).toBe(bitsD(1.5))
    expect(sf.fpToFixed(e, sf.F64, bitsD(-2.5), 0, false, sf.RN, 32)).toBe(0xfffffffen)
    expect(sf.fpToFixed(e, sf.F64, bitsD(-2.5), 0, false, sf.RA, 32)).toBe(0xfffffffdn)
    expect(sf.fpToFixed(e, sf.F64, bitsD(1e20), 0, false, sf.RZ, 32)).toBe(0x7fffffffn)
    expect(sf.fixedToFp(e, sf.F32, 0xffffffffn, 0, true, 32)).toBe(bitsS(4294967296))
    expect(sf.fpRoundInt(env(), sf.F64, bitsD(-0.4), sf.RN, true)).toBe(bitsD(-0))
    expect(sf.fpRoundInt(env(), sf.F64, bitsD(2.5), sf.RN, false)).toBe(bitsD(2))
    expect(sf.fpRoundInt(env(), sf.F64, bitsD(2.5), sf.RA, false)).toBe(bitsD(3))
    expect(sf.fpToFixedJS(env(), bitsD(2 ** 32 + 5)).value).toBe(5n)
  })

  it('fuses multiply-add with a single rounding', () => {
    // 1 + 2^-53 is not representable; (1 + 2^-52)(1 - 2^-52) - 1 is exactly -2^-104 when fused.
    const a = bitsD(1 + 2 ** -52)
    const b = bitsD(1 - 2 ** -52)
    expect(numD(sf.fpMulAdd(env(), sf.F64, bitsD(-1), a, b))).toBe(-(2 ** -104))
  })
})

describe('native fast path', () => {
  /** A deterministic generator of 32-bit words (mulberry32). */
  function gen(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return (t ^ (t >>> 14)) >>> 0
    }
  }
  const FPCRS = [0, sf.FZ, sf.DN, sf.AH, sf.FIZ, sf.FZ | sf.DN | sf.AH, sf.FZ | sf.FIZ, 1 << 22, 2 << 22, 3 << 22]

  /** Operands for one format: random bits, near-equal pairs, wide gaps, edges of the range, zeros and specials. */
  function operands(single: boolean, n: number, seed: number): bigint[][] {
    const w = gen(seed)
    const bits = (): bigint => (single ? BigInt(w()) : (BigInt(w()) << 32n) | BigInt(w()))
    const [E, F, N] = single ? [8, 23, 32] : [11, 52, 64]
    const make = (s: number, e: number, frac: bigint) => (BigInt(s) << BigInt(N - 1)) | (BigInt(e) << BigInt(F)) | frac
    const fracR = () => bits() & ((1n << BigInt(F)) - 1n)
    const bias = (1 << (E - 1)) - 1
    const maxE = (1 << E) - 2
    const pick = (): bigint => {
      const k = w() % 10
      if (k < 3) return bits()
      if (k < 6) return make(w() & 1, bias + ((w() % 41) - 20), fracR())
      if (k === 6) return make(w() & 1, w() % 3 === 0 ? maxE - (w() % 2) : 1 + (w() % 4), fracR())
      if (k === 7) return make(w() & 1, 0, w() % 2 ? 0n : fracR())
      if (k === 8) return make(w() & 1, maxE + 1, w() % 2 ? 0n : fracR())
      return make(w() & 1, bias + ((w() % 401) - 200), fracR() & ~((1n << BigInt(F - 3)) - 1n))
    }
    const out: bigint[][] = []
    for (let i = 0; i < n; i++) {
      const a = pick()
      const kind = w() % 4
      // Near-equal: the other operand is ±a nudged a few ulps (cancellation).
      const b = kind === 0 ? ((a ^ (BigInt(w() & 1) << BigInt(N - 1))) + BigInt((w() % 5) - 2)) & ((1n << BigInt(N)) - 1n) : pick()
      out.push([a, b, pick()])
    }
    return out
  }

  /** Single-precision multiply-adds whose double sum lands exactly halfway between two singles (double rounding). */
  function ties(n: number, seed: number): bigint[][] {
    const w = gen(seed)
    const out: bigint[][] = []
    for (let i = 0; i < n; i++) {
      const e = 20 + (w() % 200)
      const a = numS((BigInt(w() & 1) << 31n) | (BigInt(e) << 23n) | BigInt(w() & 0x7fffff))
      const half = 2 ** (e - 127 - 24)
      const sb = w() & 1 ? 1 : -1
      // (1 ± 2^-23)(1 ∓ 2^-23) = 1 − 2^-46: a product just short of (or past) half an ulp of a.
      out.push([bitsS(a), bitsS(sb * (1 + 2 ** -23)), bitsS((w() & 1 ? 1 : -1) * (1 - 2 ** -23) * half)])
    }
    return out
  }

  function compare(name: string, single: boolean, cases: bigint[][], run: (env: sf.FpEnv, x: bigint[]) => bigint) {
    const problems: string[] = []
    let fastHits = 0
    for (const x of cases)
      for (const fpcr of FPCRS) {
        sf.fast.on = true
        const e1 = new sf.FpEnv(fpcr)
        const r1 = run(e1, x)
        sf.fast.on = false
        const e2 = new sf.FpEnv(fpcr)
        const r2 = run(e2, x)
        sf.fast.on = true
        if (r1 !== r2 || e1.flags !== e2.flags) problems.push(`${name} ${x.map((v) => v.toString(16)).join(' ')} FPCR ${fpcr.toString(16)}: ${r1.toString(16)}/${e1.flags} exact ${r2.toString(16)}/${e2.flags}`)
        if (fpcr === 0 && (single ? numS : numD)(r1) !== 0) fastHits++
      }
    expect(problems.slice(0, 10), `${problems.length} problems`).toEqual([])
    expect(fastHits).toBeGreaterThan(cases.length / 4)
  }

  for (const single of [true, false]) {
    const fmt = single ? sf.F32 : sf.F64
    const name = single ? 'single' : 'double'
    it(`${name}: add, subtract and multiply give the exact path's results and flags`, () => {
      const cases = operands(single, 20000, single ? 5 : 6)
      compare('add', single, cases, (env, [a, b]) => sf.fpAdd(env, fmt, a!, b!))
      compare('sub', single, cases, (env, [a, b]) => sf.fpSub(env, fmt, a!, b!))
      compare('mul', single, cases, (env, [a, b]) => sf.fpMul(env, fmt, a!, b!))
    })
  }

  it("single: multiply-add gives the exact path's results and flags, double-rounding ties included", () => {
    compare('fma', true, operands(true, 20000, 7), (env, [a, b, c]) => sf.fpMulAdd(env, sf.F32, a!, b!, c!))
    compare('fma tie', true, ties(5000, 8), (env, [a, b, c]) => sf.fpMulAdd(env, sf.F32, a!, b!, c!))
  })
})
