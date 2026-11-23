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
