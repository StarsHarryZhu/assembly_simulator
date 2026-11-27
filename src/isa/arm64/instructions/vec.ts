/**
 * Lane helpers for the Advanced SIMD semantics: registers as arrays of elements (unsigned bigints), signed
 * and saturating arithmetic, the shifts of SSHL and friends, and the read-modify-write helpers every Neon
 * instruction uses. Element sizes are numbered 0–3 for 8, 16, 32 and 64 bits.
 */
import type { Cpu } from './types'

export const ESIZE = [8, 16, 32, 64, 128]

const MASKS = ESIZE.map((bits) => (1n << BigInt(bits)) - 1n)
export const maskEs = (es: number) => MASKS[es]!
export const sx = (v: bigint, es: number) => BigInt.asIntN(ESIZE[es]!, v)
export const ux = (v: bigint, es: number) => BigInt.asUintN(ESIZE[es]!, v)
export const ones = (es: number) => MASKS[es]!

/** The little-endian 32-bit word at byte `at`. */
const word = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0

// One 64-bit scratch cell seen at every width: storing a bigint into a BigUint64Array truncates it to 64 bits
// without allocating, and the narrower views read its low bits back as numbers (Number(bigint) is a slow
// runtime call in V8), so lanes convert without either.
const S64 = new BigUint64Array(2)
const S32 = new Uint32Array(S64.buffer)
const S16 = new Uint16Array(S64.buffer)
const S8 = new Uint8Array(S64.buffer)
/** The low 32 bits of a bigint as an unsigned number. */
export function lo32(v: bigint): number {
  S64[0] = v
  return S32[0]!
}

/** The 256 byte values as bigints, so byte lanes need no conversion. */
const BYTE = Array.from({ length: 256 }, (_, i) => BigInt(i))

/** `count` elements of size es (unsigned) from the bytes of b starting at `at`. */
export function lanesAt(b: Uint8Array, at: number, count: number, es: number): bigint[] {
  const out: bigint[] = new Array(count)
  switch (es) {
    case 0:
      for (let i = 0; i < count; i++) out[i] = BYTE[b[at + i]!]!
      break
    case 1:
      for (let i = 0, k = at; i < count; i++, k += 2) out[i] = BigInt(b[k]! | (b[k + 1]! << 8))
      break
    case 2:
      for (let i = 0, k = at; i < count; i++, k += 4) out[i] = BigInt(word(b, k))
      break
    case 3:
      for (let i = 0, k = at; i < count; i++, k += 8) {
        S32[0] = word(b, k)
        S32[1] = word(b, k + 4)
        out[i] = S64[0]!
      }
      break
    default:
      for (let i = 0, k = at; i < count; i++, k += 16) {
        S32[0] = word(b, k)
        S32[1] = word(b, k + 4)
        S32[2] = word(b, k + 8)
        S32[3] = word(b, k + 12)
        out[i] = S64[0]! | (S64[1]! << 64n)
      }
  }
  return out
}

/** Store elements of size es (each truncated to its size) into b starting at byte `at`. */
export function storeLanes(vals: bigint[], es: number, b: Uint8Array, at: number): void {
  const count = vals.length
  switch (es) {
    case 0:
      for (let i = 0; i < count; i++) {
        S64[0] = vals[i]!
        b[at + i] = S8[0]!
      }
      break
    case 1:
      for (let i = 0, k = at; i < count; i++, k += 2) {
        S64[0] = vals[i]!
        const x = S16[0]!
        b[k] = x
        b[k + 1] = x >>> 8
      }
      break
    case 2:
      for (let i = 0, k = at; i < count; i++, k += 4) {
        S64[0] = vals[i]!
        putWord(b, k, S32[0]!)
      }
      break
    case 3:
      for (let i = 0, k = at; i < count; i++, k += 8) {
        S64[0] = vals[i]!
        putWord(b, k, S32[0]!)
        putWord(b, k + 4, S32[1]!)
      }
      break
    default:
      for (let i = 0, k = at; i < count; i++, k += 16) {
        S64[0] = vals[i]!
        S64[1] = vals[i]! >> 64n
        putWord(b, k, S32[0]!)
        putWord(b, k + 4, S32[1]!)
        putWord(b, k + 8, S32[2]!)
        putWord(b, k + 12, S32[3]!)
      }
  }
}

const putWord = (b: Uint8Array, at: number, x: number) => {
  b[at] = x
  b[at + 1] = x >>> 8
  b[at + 2] = x >>> 16
  b[at + 3] = x >>> 24
}

/** Bytes to elements of size es (unsigned). */
export const elems = (bytes: Uint8Array, es: number): bigint[] =>
  lanesAt(bytes, 0, Math.floor(bytes.length / (ESIZE[es]! / 8)), es)

/** Elements of size es to bytes. */
export function toBytes(vals: bigint[], es: number): Uint8Array {
  const out = new Uint8Array((vals.length * ESIZE[es]!) / 8)
  storeLanes(vals, es, out, 0)
  return out
}

/** Register n as elements: `bytes` 8 or 16. */
export const readV = (c: Cpu, n: number, es: number, bytes: number) => c.vlanes(n, bytes, es)
/** Write elements to register n (the rest of the register becomes zero). */
export const writeV = (c: Cpu, n: number, vals: bigint[], es: number) => c.vsetLanes(n, vals, es)

/** Saturate an integer to a signed or unsigned element; reports whether it saturated. */
export function sat(v: bigint, es: number, unsigned: boolean): [bigint, boolean] {
  const bits = BigInt(ESIZE[es]!)
  const lo = unsigned ? 0n : -(1n << (bits - 1n))
  const hi = unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n
  if (v < lo) return [ux(lo, es), true]
  if (v > hi) return [ux(hi, es), true]
  return [ux(v, es), false]
}

/** The integer value of an element, signed or not. */
export const int = (v: bigint, es: number, unsigned: boolean) => (unsigned ? v : sx(v, es))

/** Shift right of an integer that rounds toward minus infinity (Arm's >> on integers). */
export const asr = (v: bigint, n: number) => (n >= 0 ? v >> BigInt(n) : v << BigInt(-n))

/**
 * SSHL, USHL, SRSHL, URSHL, SQSHL, UQSHL, SQRSHL, UQRSHL (register): shift by the signed low byte of the
 * second operand; negative shifts right. Returns the element and whether it saturated.
 */
export function shiftReg(a: bigint, b: bigint, es: number, unsigned: boolean, rounding: boolean, saturating: boolean): [bigint, boolean] {
  const shift = Number(BigInt.asIntN(8, b))
  const roundConst = rounding && shift < 0 ? 1n << BigInt(-shift - 1) : 0n
  const v = asr(int(a, es, unsigned) + roundConst, -shift)
  if (saturating) return sat(v, es, unsigned)
  return [ux(v, es), false]
}

/**
 * SVE2's and SME2's shifts by vector take the whole signed element as the shift, clamped to ±(esize + 1)
 * (Arm's ShiftSat), where Neon reads only its low byte.
 */
export function shiftSve(a: bigint, b: bigint, es: number, unsigned: boolean, round: boolean, saturate: boolean): bigint {
  const lim = BigInt(ESIZE[es]! + 1)
  let sh = sx(b, es)
  if (sh > lim) sh = lim
  if (sh < -lim) sh = -lim
  return shiftReg(a, sh, es, unsigned, round, saturate)[0]
}

/** Polynomial multiply over GF(2) of two `bits`-bit values (PMUL, PMULL). */
export function polyMul(a: bigint, b: bigint, bits: number): bigint {
  let r = 0n
  for (let i = 0; i < bits; i++) if ((b >> BigInt(i)) & 1n) r ^= a << BigInt(i)
  return r
}

/** Count leading sign bits (CLS) and leading zeros (CLZ) of an element. */
export function clz(v: bigint, es: number): number {
  const bits = ESIZE[es]!
  for (let i = bits - 1; i >= 0; i--) if ((v >> BigInt(i)) & 1n) return bits - 1 - i
  return bits
}
export function cls(v: bigint, es: number): number {
  const bits = ESIZE[es]!
  const top = (v >> BigInt(bits - 1)) & 1n
  const x = top ? ~v & maskEs(es) : v
  return clz(x, es) - 1
}
export function popcount(v: bigint): number {
  let n = 0
  for (let x = v; x; x &= x - 1n) n++
  return n
}
export function rbit(v: bigint, es: number): bigint {
  let r = 0n
  for (let i = 0; i < ESIZE[es]!; i++) if ((v >> BigInt(i)) & 1n) r |= 1n << BigInt(ESIZE[es]! - 1 - i)
  return r
}

/** Write a narrowed result: the low half of Vd, or (the "2" forms) the high half keeping the low half. */
export function writeNarrow(c: Cpu, d: number, vals: bigint[], es: number, upper: boolean): void {
  if (!upper) return writeV(c, d, vals, es)
  const old = c.vread(d, 16)
  old.set(toBytes(vals, es), 8)
  c.vwrite(d, old)
}

/** The elements of a source's lower or upper half (the "2" forms read the upper half). */
export function half(c: Cpu, n: number, es: number, upper: boolean): bigint[] {
  const all = readV(c, n, es, 16)
  return upper ? all.slice(all.length / 2) : all.slice(0, all.length / 2)
}
