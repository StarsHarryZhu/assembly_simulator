/**
 * Starting states of the native behaviour cases, shared by the generator (scripts/native-golden.mjs) and
 * the replay test (tests/arm64/native.test.ts), so the fixtures only store a seed.
 *
 * Each case sees 31 registers (x18 always 0: Apple's platform register), random NZCV, and a 256-byte
 * buffer. Base registers of loads and stores point into the buffer; those values are compared as offsets.
 */
export const BUF_SIZE = 256
/** Where base registers point, inside the buffer. */
export const BASE_OFFSET = 128

/** A small deterministic generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const EDGES = [0n, 1n, 2n, 0x7fn, 0x80n, 0xffn, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn]

export interface NativeState {
  /** x0–x30; pointer registers hold an offset into the buffer (see `ptr`). */
  x: bigint[]
  nzcv: number
  memory: Uint8Array
}

/**
 * The starting state for a seed. `ptr` registers get BASE_OFFSET (an offset into the buffer), `small`
 * registers a value below 64 (register offsets), the rest a mix of edge values and random bits.
 */
export function initialState(seed: number, ptr: number[], small: number[]): NativeState {
  const r = rng(seed)
  const word = () => BigInt(Math.floor(r() * 2 ** 32))
  const x = Array.from({ length: 31 }, (_, n) => {
    if (n === 18) return 0n
    const pick = r()
    if (pick < 0.3) return EDGES[Math.floor(r() * EDGES.length)]!
    if (pick < 0.5) return BigInt(Math.floor(r() * 200)) - 100n & 0xffffffffffffffffn
    return (word() << 32n) | word()
  })
  // Register 31 is the zero register (or sp, which cases never name): there is nothing to set.
  for (const n of small) if (n < 31) x[n] = BigInt(Math.floor(r() * 64))
  for (const n of ptr) if (n < 31) x[n] = BigInt(BASE_OFFSET)
  const nzcv = Math.floor(r() * 16)
  const memory = new Uint8Array(BUF_SIZE)
  for (let i = 0; i < BUF_SIZE; i++) memory[i] = Math.floor(r() * 256)
  return { x, nzcv, memory }
}

/** Values worth having in floating-point lanes, per element size (h, s, d): zeros, infinities, NaNs, denormals, extremes. */
function specials(bits: number): bigint[] {
  const e = bits === 16 ? 5 : bits === 32 ? 8 : 11
  const f = bits - 1 - e
  const sign = 1n << BigInt(bits - 1)
  const expAll = ((1n << BigInt(e)) - 1n) << BigInt(f)
  const one = ((1n << BigInt(e - 1)) - 1n) << BigInt(f)
  const quiet = 1n << BigInt(f - 1)
  return [0n, sign, expAll, sign | expAll, expAll | quiet, expAll | quiet | 5n, expAll | 1n, sign | expAll | 3n, 1n, (1n << BigInt(f)) - 1n, 1n << BigInt(f), sign | 1n, expAll - 1n, one, sign | one, one | quiet]
}

export interface VectorState {
  /** v0–v31 as 128-bit values. */
  v: bigint[]
  /** A random FPCR (rounding mode, FZ, DN, AH, FIZ, NEP, FZ16, AHP), for the floating-point cases. */
  fpcr: number
}

/**
 * The SIMD&FP registers and an FPCR for a seed, from a generator of their own so the general-purpose
 * state of a seed stays as it was. Each register holds random bits, or lanes of one element size mixing
 * special values, numbers near 1 (where rounding shows) and random bits.
 */
export function vectorState(seed: number): VectorState {
  const r = rng(seed ^ 0x5bd1e995)
  const bitsOf = (n: number) => {
    let v = 0n
    for (let i = 0; i < n; i += 32) v = (v << 32n) | BigInt(Math.floor(r() * 2 ** 32))
    return v & ((1n << BigInt(n)) - 1n)
  }
  const v = Array.from({ length: 32 }, () => {
    if (r() < 0.25) return bitsOf(128)
    const bits = [16, 32, 64][Math.floor(r() * 3)]!
    const e = bits === 16 ? 5 : bits === 32 ? 8 : 11
    const f = bits - 1 - e
    const sp = specials(bits)
    let out = 0n
    for (let lane = 128 / bits - 1; lane >= 0; lane--) {
      const pick = r()
      let x: bigint
      if (pick < 0.25) x = bitsOf(bits)
      else if (pick < 0.45) x = sp[Math.floor(r() * sp.length)]!
      else {
        // ±(1.fraction) × 2^k with k near 0, sometimes with few fraction bits (exact halves, small integers).
        const bias = (1 << (e - 1)) - 1
        const k = Math.floor(r() * 24) - 8
        const frac = r() < 0.5 ? bitsOf(f) : bitsOf(3) << BigInt(f - 3)
        x = (BigInt(r() < 0.5 ? 1 : 0) << BigInt(bits - 1)) | (BigInt(bias + k) << BigInt(f)) | frac
      }
      out = (out << BigInt(bits)) | x
    }
    return out
  })
  let fpcr = 0
  if (r() < 0.6) fpcr |= Math.floor(r() * 4) << 22
  if (r() < 0.2) fpcr |= 1 << 24 // FZ
  if (r() < 0.2) fpcr |= 1 << 25 // DN
  if (r() < 0.2) fpcr |= 1 << 19 // FZ16
  if (r() < 0.2) fpcr |= 2 // AH
  if (r() < 0.1) fpcr |= 1 // FIZ
  if (r() < 0.2) fpcr |= 4 // NEP
  if (r() < 0.05) fpcr |= 1 << 26 // AHP
  return { v, fpcr }
}
