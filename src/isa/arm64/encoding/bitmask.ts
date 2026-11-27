/**
 * Logical immediates (AND, ORR, EOR, ANDS, TST, MOV): a run of ones, rotated within an element of 2, 4,
 * 8, 16, 32 or 64 bits, and the element repeated to fill the register. Encoded in N:immr:imms.
 */

export interface BitmaskFields {
  N: number
  immr: number
  imms: number
}

const ones = (n: number) => (1n << BigInt(n)) - 1n

function rotr(v: bigint, r: number, size: number): bigint {
  if (r === 0) return v
  const m = ones(size)
  return ((v >> BigInt(r)) | (v << BigInt(size - r))) & m
}

/** The value of a logical immediate, or null when the fields are reserved. */
export function decodeBitmask(N: number, immr: number, imms: number, size: 32 | 64): bigint | null {
  if (size === 32 && N) return null
  const combined = (N << 6) | (~imms & 0x3f)
  if (combined === 0) return null
  const len = 31 - Math.clz32(combined)
  if (len < 1) return null
  const esize = 1 << len
  const levels = esize - 1
  const S = imms & levels
  const R = immr & levels
  if (S === levels) return null
  const elem = rotr(ones(S + 1), R, esize)
  let out = 0n
  for (let i = 0; i < size; i += esize) out |= elem << BigInt(i)
  return out
}

/** The fields for a value, or null when it is not a logical immediate at this register size. */
export function encodeBitmask(value: bigint, size: 32 | 64): BitmaskFields | null {
  const full = ones(size)
  const v = value & full
  if (v === 0n || v === full) return null
  let e: number = size
  while (e > 2) {
    const h = e / 2
    const m = ones(h)
    if ((v & m) !== ((v >> BigInt(h)) & m)) break
    e = h
  }
  const em = ones(e)
  const elem = v & em
  for (let r = 0; r < e; r++) {
    // Rotating the element left by r gives ones(s) when the element is ones(s) rotated right by r.
    const rotl = rotr(elem, (e - r) % e, e)
    if ((rotl & (rotl + 1n)) === 0n) {
      let s = 0
      for (let x = rotl; x; x >>= 1n) s++
      const prefix = ~(e * 2 - 1) & 0x3f
      return { N: e === 64 ? 1 : 0, immr: r, imms: (prefix | (s - 1)) & 0x3f }
    }
  }
  return null
}
