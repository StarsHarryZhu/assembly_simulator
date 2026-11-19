/** Parsing what people type for a word: hex, binary, decimal, a character, or (for float registers) a real. */
import { bitsFromFloat } from '../../core/format'

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
