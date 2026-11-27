/**
 * How the register panel reads one lane of a vector or matrix register: hex, signed, unsigned or
 * floating point (half, single or double by the lane's size).
 */
import { bigOfBytes, doubleFromBits, floatFromBits, halfFromBits, hexBits, javaDouble, javaFloat } from '../../core/format'

export type LaneFormat = 'hex' | 'int' | 'uint' | 'float'

/** The lane of `size` bytes at `at`, least significant byte first. */
export function laneText(bytes: Uint8Array, at: number, size: number, format: LaneFormat): string {
  const raw = bigOfBytes(bytes, at, size)
  const bits = size * 8
  if (format === 'int') return BigInt.asIntN(bits, raw).toString()
  if (format === 'uint') return raw.toString()
  if (format === 'float') {
    if (size === 2) return String(halfFromBits(Number(raw)))
    if (size === 4) return javaFloat(floatFromBits(Number(raw) | 0))
    if (size === 8) return javaDouble(doubleFromBits(Number(raw & 0xffffffffn) | 0, Number(raw >> 32n) | 0))
    return '—'
  }
  return hexBits(raw, bits)
}
