/**
 * Bit patterns of instruction encodings, written most significant bit first:
 *
 *   'sf 0 0 100010 sh imm12:12 Rn:5 Rd:5'
 *
 * Runs of 0 and 1 are fixed bits; `name:width` is a field; a bare `name` is a one-bit field. The widths add
 * up to 32. A pattern gives the mask and value that identify the encoding and where each field sits.
 */

export interface FieldSpec {
  name: string
  lo: number
  width: number
}

/** A run of bits as the decoder shows it: a field, or a run of fixed bits. */
export interface Segment {
  hi: number
  lo: number
  /** Field name; null for fixed bits. */
  name: string | null
  /** For fixed bits, their value. */
  value: number
}

export interface Pattern {
  text: string
  mask: number
  value: number
  fields: FieldSpec[]
  segments: Segment[]
  /** Number of fixed bits (more is more specific). */
  fixedBits: number
}

export function parsePattern(text: string): Pattern {
  let bit = 32
  let mask = 0
  let value = 0
  const fields: FieldSpec[] = []
  const segments: Segment[] = []
  for (const tok of text.trim().split(/\s+/)) {
    if (/^[01]+$/.test(tok)) {
      const w = tok.length
      bit -= w
      const v = parseInt(tok, 2)
      mask = (mask | ((((1 << w) - 1) >>> 0) << bit)) >>> 0
      value = (value | (v << bit)) >>> 0
      const prev = segments[segments.length - 1]
      // Adjacent fixed runs join into one segment.
      if (prev && prev.name === null && prev.lo === bit + w) {
        prev.value = (prev.value << w) | v
        prev.lo = bit
      } else segments.push({ hi: bit + w - 1, lo: bit, name: null, value: v })
      continue
    }
    const m = /^([A-Za-z_][\w]*)(?::(\d+))?$/.exec(tok)
    if (!m) throw new Error(`bad pattern token ${tok} in ${text}`)
    const w = m[2] ? Number(m[2]) : 1
    bit -= w
    fields.push({ name: m[1]!, lo: bit, width: w })
    segments.push({ hi: bit + w - 1, lo: bit, name: m[1]!, value: 0 })
  }
  if (bit !== 0) throw new Error(`pattern is ${32 - bit} bits, not 32: ${text}`)
  let fixedBits = 0
  for (let m = mask; m; m &= m - 1) fixedBits++
  return { text, mask, value, fields, segments, fixedBits }
}

export function getField(word: number, f: FieldSpec): number {
  return f.width === 32 ? word >>> 0 : (word >>> f.lo) & ((1 << f.width) - 1)
}

/** Every field of the pattern from a word. */
export function extract(p: Pattern, word: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of p.fields) out[f.name] = getField(word, f)
  return out
}

/** The word for field values (missing fields are 0; values are cut to their width). */
export function build(p: Pattern, fields: Record<string, number>): number {
  let w = p.value
  for (const f of p.fields) {
    const v = fields[f.name] ?? 0
    w = (w | ((v & ((1 << f.width) - 1)) << f.lo)) >>> 0
  }
  return w >>> 0
}
