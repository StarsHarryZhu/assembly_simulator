/** Encode basic instructions to words, decode words back, and render them as text. */
import { FORMATS, fieldMask, fieldOfOp, getField, setField, type FieldSpec } from './formats'
import { BASIC } from './instructions'
import type { Decoded, InstrDef } from './instructions/types'
import { fprName, gprName } from './registers'

export interface Encodable {
  def: InstrDef
  /** Field values keyed by field name (rs, rt, imm, target, ...). Values are masked to the field width. */
  fields: Record<string, number>
}

function fieldsOf(d: InstrDef): FieldSpec[] {
  return FORMATS[d.fmt]
}

/** Fixed-bit mask and value for a definition. */
export function maskOf(d: InstrDef): { mask: number; match: number } {
  let mask = 0
  let match = 0
  for (const spec of fieldsOf(d)) {
    if (spec.name in d.fixed) {
      mask = (mask | fieldMask(spec)) >>> 0
      match = setField(match, spec, d.fixed[spec.name]!)
    }
  }
  return { mask: mask >>> 0, match: match >>> 0 }
}

export function encode(d: InstrDef, fields: Record<string, number>): number {
  let w = 0
  for (const spec of fieldsOf(d)) {
    const v = spec.name in d.fixed ? d.fixed[spec.name]! : (fields[spec.name] ?? 0)
    w = setField(w, spec, v)
  }
  return w >>> 0
}

export function decodeFields(word: number): Decoded {
  word >>>= 0
  const imm = word & 0xffff
  const rs = (word >>> 21) & 31
  const rt = (word >>> 16) & 31
  const rd = (word >>> 11) & 31
  const sa = (word >>> 6) & 31
  return {
    word,
    op: word >>> 26,
    rs,
    rt,
    rd,
    sa,
    funct: word & 63,
    imm,
    simm: (imm << 16) >> 16,
    target: word & 0x3ffffff,
    code: (word >>> 6) & 0xfffff,
    cc: (word >>> 18) & 7,
    ccLow: (word >>> 8) & 7,
    fmt: rs,
    ft: rt,
    fs: rd,
    fd: sa,
  }
}

function popcount(x: number): number {
  x >>>= 0
  let n = 0
  while (x) {
    x &= x - 1
    n++
  }
  return n
}

interface Candidate {
  def: InstrDef
  mask: number
  match: number
  bits: number
}

/** Candidates by opcode, most specific (most fixed bits) first, so nop beats sll and "jalr $t1" beats "jalr $t1,$t2". */
const BY_OPCODE: Candidate[][] = Array.from({ length: 64 }, () => [])
for (const def of BASIC) {
  const { mask, match } = maskOf(def)
  BY_OPCODE[match >>> 26]!.push({ def, mask, match, bits: popcount(mask) })
}
for (const list of BY_OPCODE) list.sort((a, b) => b.bits - a.bits)

export function findDef(word: number): InstrDef | null {
  word >>>= 0
  for (const c of BY_OPCODE[word >>> 26]!) if (((word & c.mask) >>> 0) === c.match) return c.def
  return null
}

/** Field values that encode() needs, read back from a decoded word. */
export function fieldValues(d: InstrDef, word: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const spec of fieldsOf(d)) out[spec.name] = getField(word, spec)
  return out
}

function hex(v: number, digits = 1): string {
  return '0x' + (v >>> 0).toString(16).padStart(digits, '0')
}

export interface RenderOptions {
  /** Address of the instruction, for branch targets. */
  addr?: number
  /** Name for an address, if a label sits there. */
  label?: (addr: number) => string | null
}

/** Text of one operand of an instruction. */
export function renderOperand(def: InstrDef, op: InstrDef['ops'][number], f: Decoded, opts: RenderOptions = {}): string {
  const fmtCc = def.fmt === 'FCMP' ? f.ccLow : f.cc
  switch (op) {
    case 'rd':
    case 'rs':
    case 'rt':
      return gprName(f[op])
    case 'fd':
    case 'fs':
    case 'ft':
      return fprName(f[op])
    case 'c0':
      return '$' + f.rd
    case 'sa':
      return String(f.sa)
    case 'cc':
      return String(fmtCc)
    case 'imm':
      return String(f.simm)
    case 'immu':
      return f.imm > 9 ? hex(f.imm, 4) : String(f.imm)
    case 'code':
      return String(f.code)
    case 'mem':
      return `${f.simm}(${gprName(f.rs)})`
    case 'off': {
      if (opts.addr == null) return String(f.simm)
      const t = (opts.addr + 4 + f.simm * 4) >>> 0
      return opts.label?.(t) ?? hex(t, 8)
    }
    case 'tgt': {
      const base = opts.addr == null ? 0 : (opts.addr + 4) & 0xf0000000
      const t = (base | (f.target << 2)) >>> 0
      return opts.label?.(t) ?? hex(t, 8)
    }
  }
}

export function render(def: InstrDef, word: number, opts: RenderOptions = {}): string {
  const f = decodeFields(word)
  const parts = def.ops.map((op) => renderOperand(def, op, f, opts))
  return parts.length ? `${def.name} ${parts.join(', ')}` : def.name
}

/** Field a source operand writes, and its value, for the encoder. */
export function operandField(op: InstrDef['ops'][number]): string {
  return fieldOfOp(op)
}
