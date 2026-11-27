/** Parsing what people type for a word: hex, binary, decimal, a character, or (for float registers) a real. */
import { addrOf, bitsFromFloat } from '../../core/format'
import type { RegValue } from '../../core/isa'

export function parseWord(text: string, allowFloat = false): number | null {
  const t = text.trim().replace(/_/g, '')
  if (!t) return null
  let m = /^([-+]?)0x([0-9a-f]{1,8})$/i.exec(t)
  if (m) return (m[1] === '-' ? -parseInt(m[2]!, 16) : parseInt(m[2]!, 16)) | 0
  m = /^([-+]?)0b([01]{1,32})$/i.exec(t)
  if (m) return (m[1] === '-' ? -parseInt(m[2]!, 2) : parseInt(m[2]!, 2)) | 0
  if (/^[01]{32}$/.test(t.replace(/\s+/g, ''))) return parseInt(t.replace(/\s+/g, ''), 2) | 0
  if (/^[-+]?\d+$/.test(t)) {
    const n = Number(t)
    return n >= -2147483648 && n <= 4294967295 ? n | 0 : null
  }
  if (/^'(.|\\[nt0])'$/.test(t)) return t[1] === '\\' ? ({ n: 10, t: 9, '0': 0 } as Record<string, number>)[t[2]!]! : t.charCodeAt(1)
  if (allowFloat && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return bitsFromFloat(Number(t))
  return null
}

/**
 * A value for a register of the given width: what parseWord reads for 32 bits and fewer; for wider
 * registers hex (up to 16 digits), binary (up to 64 digits), or a decimal that fits, as a bigint.
 */
export function parseValue(text: string, bits: number, allowFloat = false): RegValue | null {
  if (bits <= 32) return parseWord(text, allowFloat)
  const t = text.trim().replace(/_/g, '')
  const m = /^([-+]?)(0x[0-9a-f]{1,16}|0b[01]{1,64}|\d+)$/i.exec(t)
  if (!m) {
    const small = parseWord(t)
    return small == null ? null : BigInt.asUintN(bits, BigInt(small))
  }
  const v = BigInt(m[2]!)
  const n = m[1] === '-' ? -v : v
  if (n < -(1n << BigInt(bits - 1)) || n >= 1n << BigInt(bits)) return null
  return BigInt.asUintN(bits, n)
}

/**
 * An address as typed, as an address number (see MemoryLayout.addressBits), rounded down to `align`, or null.
 * A 64-bit address between the two halves of the address space reads as null.
 */
export function parseAddress(text: string, bits: 32 | 64, align = 4): number | null {
  const v = parseValue(text, bits)
  if (v == null) return null
  const a = bits === 64 ? addrOf(BigInt(v)) : Number(v) >>> 0
  return a == null ? null : a - (a % align)
}
