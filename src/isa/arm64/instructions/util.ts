/** Arithmetic shared by instruction semantics: widths, flags, shifts and extends on bigints. */

export const M64 = 0xffff_ffff_ffff_ffffn
export const M32 = 0xffff_ffffn

export const maskOf = (sf: number) => (sf ? M64 : M32)
export const bitsOf = (sf: number) => (sf ? 64 : 32)

/** Signed value of a register at a width. */
export const signed = (sf: number, v: bigint) => (sf ? BigInt.asIntN(64, v) : BigInt.asIntN(32, v))

/** Sign-extend a field value of `bits` bits to a JS number. */
export const sext = (v: number, bits: number) => (bits >= 32 ? v | 0 : (v << (32 - bits)) >> (32 - bits))

/** x + y + carry at a width, with the N Z C V flags it sets. */
export function addWithCarry(sf: number, x: bigint, y: bigint, carry: number): [bigint, number] {
  const bits = sf ? 64 : 32
  const m = sf ? M64 : M32
  const usum = x + y + BigInt(carry)
  const result = usum & m
  const ssum = BigInt.asIntN(bits, x) + BigInt.asIntN(bits, y) + BigInt(carry)
  const n = Number(result >> BigInt(bits - 1)) & 1
  const z = result === 0n ? 1 : 0
  const c = usum === result ? 0 : 1
  const v = BigInt.asIntN(bits, result) === ssum ? 0 : 1
  return [result, (n << 3) | (z << 2) | (c << 1) | v]
}

/** N and Z of a logical result (C and V cleared). */
export function logicFlags(sf: number, result: bigint): number {
  const n = Number(result >> BigInt(sf ? 63 : 31)) & 1
  return (n << 3) | (result === 0n ? 4 : 0)
}

/** Shift a register value: 0 LSL, 1 LSR, 2 ASR, 3 ROR. */
export function shiftValue(sf: number, v: bigint, type: number, amount: number): bigint {
  const bits = sf ? 64 : 32
  const m = sf ? M64 : M32
  const a = BigInt(amount % bits)
  if (amount === 0) return v & m
  switch (type) {
    case 0:
      return (v << a) & m
    case 1:
      return (v & m) >> a
    case 2:
      return BigInt.asUintN(bits, BigInt.asIntN(bits, v) >> a)
    default:
      return ((v >> a) | (v << (BigInt(bits) - a))) & m
  }
}

/** Extend a register value (option: UXTB UXTH UXTW UXTX SXTB SXTH SXTW SXTX) and shift it left. */
export function extendValue(sf: number, v: bigint, option: number, shift: number): bigint {
  const len = 8 << (option & 3)
  const x = option & 4 ? BigInt.asIntN(len, v) : BigInt.asUintN(len, v)
  return BigInt.asUintN(sf ? 64 : 32, x << BigInt(shift))
}

export function countLeadingZeros(v: bigint, bits: number): number {
  for (let i = bits - 1; i >= 0; i--) if ((v >> BigInt(i)) & 1n) return bits - 1 - i
  return bits
}

export function countTrailingZeros(v: bigint, bits: number): number {
  for (let i = 0; i < bits; i++) if ((v >> BigInt(i)) & 1n) return i
  return bits
}

export function popcount(v: bigint): number {
  let n = 0
  for (let x = v; x; x &= x - 1n) n++
  return n
}

/** Reverse the bytes within each container of `container` bits. */
export function reverseBytes(v: bigint, bits: number, container: number): bigint {
  let out = 0n
  for (let c = 0; c < bits; c += container) {
    for (let b = 0; b < container; b += 8) {
      const byte = (v >> BigInt(c + b)) & 0xffn
      out |= byte << BigInt(c + container - 8 - b)
    }
  }
  return out
}

export function reverseBits(v: bigint, bits: number): bigint {
  let out = 0n
  for (let i = 0; i < bits; i++) if ((v >> BigInt(i)) & 1n) out |= 1n << BigInt(bits - 1 - i)
  return out
}

/** The value of a logical immediate's rotated element for BFM-family semantics: ones(n). */
export const ones = (n: number) => (n <= 0 ? 0n : (1n << BigInt(n)) - 1n)

export function rotateRight(v: bigint, r: number, bits: number): bigint {
  const m = ones(bits)
  r %= bits
  if (r === 0) return v & m
  return ((v >> BigInt(r)) | (v << BigInt(bits - r))) & m
}

/** Replicate an element of `esize` bits across `bits`. */
export function replicate(elem: bigint, esize: number, bits: number): bigint {
  let out = 0n
  for (let i = 0; i < bits; i += esize) out |= elem << BigInt(i)
  return out
}

/**
 * DecodeBitMasks from the Arm pseudocode, returning (wmask, tmask), for BFM, SBFM and UBFM.
 * Returns null for reserved combinations.
 */
export function decodeBitMasks(N: number, imms: number, immr: number, immediate: boolean, M: number): [bigint, bigint] | null {
  const combined = (N << 6) | (~imms & 0x3f)
  if (combined === 0) return null
  const len = 31 - Math.clz32(combined)
  if (len < 1) return null
  const levels = (1 << len) - 1
  if (immediate && (imms & levels) === levels) return null
  const S = imms & levels
  const R = immr & levels
  const diff = (S - R) & levels
  const esize = 1 << len
  const d = diff
  const welem = ones(S + 1)
  const telem = ones(d + 1)
  const wmask = replicate(rotateRight(welem, R, esize), esize, M)
  const tmask = replicate(telem, esize, M)
  return [wmask, tmask]
}

/** CRC-32 (reflected polynomial) of the low `size` bytes of `data`, continuing from `acc`. */
export function crc32(acc: bigint, data: bigint, size: number, castagnoli: boolean): bigint {
  const poly = castagnoli ? 0x82f63b78 : 0xedb88320
  let crc = Number(acc & M32) >>> 0
  for (let i = 0; i < size; i++) {
    crc ^= Number((data >> BigInt(8 * i)) & 0xffn)
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ poly : crc >>> 1
  }
  return BigInt(crc >>> 0)
}
