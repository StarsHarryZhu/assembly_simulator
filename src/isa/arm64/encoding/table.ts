/**
 * The instruction table: every encoding and alias, compiled once, with lookups for both directions.
 *
 * An instruction (`InstrSpec`) is one encoding: its bit pattern, operand template, description and
 * semantics. An alias (`AliasSpec`) is another way to write an instruction (MOV for ORR, LSL for UBFM): its
 * own template over the instruction's fields, with hooks between its operand values and those fields, and
 * a condition for when the disassembler prefers it. Mnemonics like `b.<cond>` stand for one per condition.
 */
import { L, type Text } from '../../../core/i18n'
import type { Tok } from '../lexer'
import type { Cpu } from '../instructions/types'
import { build, extract, parsePattern, type Pattern } from './pattern'
import { COND_NAMES, printWidths, resolve } from './operands'
import {
  buildSyntax,
  compileSyntax,
  matchSyntax,
  Mismatch,
  OperandStream,
  operandsOf,
  printSyntax,
  sampleSyntax,
  type AsmContext,
  type Fields,
  type Item,
  type PrintContext,
  type Spans,
} from './syntax'

export type Exec = (c: Cpu, f: Fields) => void

export interface InstrSpec {
  id: string
  mnemonic: string
  /** Catalog group. */
  group: string
  /** Architecture feature, for documentation ('base' when omitted). */
  feature?: string
  bits: string
  syntax: string
  /** Whether a field combination belongs to this encoding (otherwise it is reserved or another one's). */
  valid?: (f: Fields) => boolean
  /** Fill fields the operands do not name (EXTR's N, which equals sf). */
  encode?: (f: Fields) => void
  /**
   * Refuse, when assembling, register choices the architecture leaves UNPREDICTABLE (as clang does):
   * return the reason. The decoder still shows such words.
   */
  check?: (f: Fields) => string | void
  /** The catalog's example line, when the generated one would be another form's. */
  example?: string
  desc: Text
  exec: Exec
  /** Explanations for the decoder. */
  notes?: (f: Fields, pc: number) => string[]
}

export interface AliasSpec {
  id: string
  /** The instruction this writes. */
  of: string
  mnemonic: string
  syntax: string
  /** Fields the alias fixes. */
  fixed?: Fields
  /** When the disassembler shows this alias (after `fixed` matches); false: assembly only. Default: always. */
  prefer?: ((f: Fields) => boolean) | false
  /** Fill the instruction's fields from the alias's operand values; a string refuses with that message. */
  encode?: (f: Fields) => string | void
  /** Compute the alias's operand values from the instruction's fields, for printing. */
  decode?: (f: Fields) => void
  /** The catalog's example line, when the generated one would be another form's. */
  example?: string
  desc?: Text
  group?: string
}

export interface Instr {
  spec: InstrSpec
  pattern: Pattern
  widths: Record<string, number>
  form: Form
  aliases: Form[]
}

export interface Form {
  key: string
  /** As written, e.g. 'add' or 'b.<cond>'. */
  mnemonic: string
  group: string
  desc: Text
  items: Item[]
  instr: Instr
  alias: AliasSpec | null
  fixed: Fields
  order: number
}

const instrs: Instr[] = []
const byId = new Map<string, Instr>()
const formsByKey = new Map<string, Form>()
/** Lower-case mnemonic as typed → forms to try, in order, with fields the mnemonic itself fixes. */
const byMnemonic = new Map<string, { form: Form; preset: Fields }[]>()
let order = 0

function index(form: Form) {
  formsByKey.set(form.key, form)
  const m = form.mnemonic.toLowerCase()
  if (m.includes('<cond>')) {
    const names = [...COND_NAMES.map((n, i) => [n, i] as const), ['cs', 2] as const, ['cc', 3] as const]
    for (const [n, i] of names) {
      const key = m.replace('<cond>', n)
      const list = byMnemonic.get(key) ?? []
      list.push({ form, preset: { cond: i } })
      byMnemonic.set(key, list)
    }
    return
  }
  const list = byMnemonic.get(m) ?? []
  list.push({ form, preset: {} })
  byMnemonic.set(m, list)
}

/** Add instructions to the table. */
export function defineInstrs(specs: InstrSpec[]): void {
  for (const spec of specs) {
    if (byId.has(spec.id)) throw new Error(`duplicate instruction id ${spec.id}`)
    const pattern = parsePattern(spec.bits)
    const widths: Record<string, number> = {}
    for (const f of pattern.fields) widths[f.name] = f.width
    const instr = { spec, pattern, widths, aliases: [] } as unknown as Instr
    instr.form = { key: spec.id, mnemonic: spec.mnemonic, group: spec.group, desc: spec.desc, items: compileSyntax(spec.syntax, resolve), instr, alias: null, fixed: {}, order: order++ }
    instrs.push(instr)
    byId.set(spec.id, instr)
    index(instr.form)
  }
  decodeIndex = null
}

/** Add aliases (their instructions must be defined first). */
export function defineAliases(specs: AliasSpec[]): void {
  for (const spec of specs) {
    const instr = byId.get(spec.of)
    if (!instr) throw new Error(`alias ${spec.id} of unknown ${spec.of}`)
    if (formsByKey.has(spec.id)) throw new Error(`duplicate alias id ${spec.id}`)
    const form: Form = {
      key: spec.id,
      mnemonic: spec.mnemonic,
      group: spec.group ?? instr.spec.group,
      desc: spec.desc ?? instr.spec.desc,
      items: compileSyntax(spec.syntax, resolve),
      instr,
      alias: spec,
      fixed: spec.fixed ?? {},
      order: order++,
    }
    instr.aliases.push(form)
    index(form)
  }
}

export function allInstrs(): readonly Instr[] {
  return instrs
}
export function allForms(): Form[] {
  return [...formsByKey.values()].sort((a, b) => a.order - b.order)
}
export function formByKey(key: string): Form | undefined {
  return formsByKey.get(key)
}
export function instrById(id: string): Instr | undefined {
  return byId.get(id)
}
export function isMnemonic(m: string): boolean {
  return byMnemonic.has(m.toLowerCase())
}
export function mnemonicList(): string[] {
  return [...byMnemonic.keys()]
}

/* ------------------------------------------------------------------ assembling */

export interface Encoded {
  word: number
  form: Form
  fields: Fields
  spans: Spans
}

/** Encode one instruction; throws the most telling Mismatch when no form fits. */
export function encodeInstr(mnemonic: string, toks: Tok[], ctx: AsmContext): Encoded {
  const candidates = byMnemonic.get(mnemonic.toLowerCase())
  if (!candidates) throw new Mismatch(-1, L(`"${mnemonic}" 不是可识别的指令`, `"${mnemonic}" is not a recognized instruction`), true, null, null, 'unknown-mnemonic')
  const best: { m: Mismatch | null } = { m: null }
  for (const { form, preset } of candidates) {
    const f: Fields = { ...form.fixed, ...preset }
    const s = new OperandStream(toks, ctx, form.instr.widths)
    const spans: Spans = new Map()
    try {
      matchSyntax(form.items, s, f, spans, best)
      for (const op of operandsOf(form.items)) op.type.fillDefault?.(f, op.arg)
      if (form.alias?.encode) {
        const err = form.alias.encode(f)
        if (err) throw new Mismatch(toks.length, err, true)
      }
      form.instr.spec.encode?.(f)
      const word = build(form.instr.pattern, f)
      const real = extract(form.instr.pattern, word)
      if (form.instr.spec.valid && !form.instr.spec.valid(real)) throw new Mismatch(toks.length, L('这种操作数组合不合法（保留的编码）', 'This combination of operands is not allowed (a reserved encoding)'), true)
      const bad = form.instr.spec.check?.(real)
      if (bad) throw new Mismatch(toks.length, bad, true)
      return { word, form, fields: f, spans }
    } catch (e) {
      if (!(e instanceof Mismatch)) throw e
      const b = best.m
      if (!b || e.pos > b.pos || (e.pos === b.pos && e.hard && !b.hard)) best.m = e
    }
  }
  throw best.m ?? new Mismatch(0, L('操作数不对', 'Bad operands'))
}

/* ------------------------------------------------------------------ disassembling */

/** Instructions by the top 11 bits of a word. */
let decodeIndex: Instr[][] | null = null

function buildIndex(): Instr[][] {
  const out: Instr[][] = Array.from({ length: 2048 }, () => [])
  for (const ins of instrs) {
    const m = ins.pattern.mask >>> 21
    const v = ins.pattern.value >>> 21
    const free: number[] = []
    for (let b = 0; b < 11; b++) if (!(m & (1 << b))) free.push(b)
    for (let k = 0; k < 1 << free.length; k++) {
      let key = v
      free.forEach((b, j) => {
        if (k & (1 << j)) key |= 1 << b
      })
      out[key]!.push(ins)
    }
  }
  for (const list of out) list.sort((a, b) => b.pattern.fixedBits - a.pattern.fixedBits || a.form.order - b.form.order)
  return out
}

export interface Decoded {
  instr: Instr
  fields: Fields
}

/** The instruction a word encodes, or null when it is unallocated (or not implemented). */
export function decodeWord(word: number): Decoded | null {
  decodeIndex ??= buildIndex()
  word >>>= 0
  for (const ins of decodeIndex[word >>> 21]!) {
    if (((word & ins.pattern.mask) >>> 0) !== ins.pattern.value) continue
    const fields = extract(ins.pattern, word)
    if (ins.spec.valid && !ins.spec.valid(fields)) continue
    return { instr: ins, fields }
  }
  return null
}

/** The form the disassembler shows: the first preferred alias, or the instruction itself. */
export function displayForm(d: Decoded): { form: Form; fields: Fields } {
  for (const a of d.instr.aliases) {
    const spec = a.alias!
    if (spec.prefer === false) continue
    if (Object.entries(a.fixed).some(([k, v]) => d.fields[k] !== v)) continue
    const f = { ...d.fields }
    spec.decode?.(f)
    if (spec.prefer && !spec.prefer(f)) continue
    return { form: a, fields: f }
  }
  return { form: d.instr.form, fields: d.fields }
}

export function mnemonicOf(form: Form, f: Fields): string {
  return form.mnemonic.includes('<cond>') ? form.mnemonic.replace('<cond>', COND_NAMES[f.cond!]!) : form.mnemonic
}

/** Print a form with field values. */
export function printForm(form: Form, f: Fields, ctx: PrintContext): string {
  printWidths.current = form.instr.widths
  const ops = printSyntax(form.items, f, ctx)
  const m = mnemonicOf(form, f)
  return ops ? `${m} ${ops}` : m
}

/** Assembly text of a word at an address. */
export function disassemble(word: number, ctx: PrintContext): string | null {
  const d = decodeWord(word)
  if (!d) return null
  const { form, fields } = displayForm(d)
  return printForm(form, fields, ctx)
}

/** An example line for a form. */
export function sampleLine(form: Form): string {
  const given = form.alias ? form.alias.example : form.instr.spec.example
  if (given) return given
  printWidths.current = form.instr.widths
  const f: Fields = { ...form.fixed }
  const ops = sampleSyntax(form.items, f)
  const m = form.mnemonic.includes('<cond>') ? form.mnemonic.replace('<cond>', 'eq') : form.mnemonic
  return ops ? `${m} ${ops}` : m
}

/** Write a form's line from operand texts. */
export function buildLine(form: Form, texts: string[], mnemonic?: string): string {
  const ops = buildSyntax(form.items, texts)
  const m = mnemonic ?? (form.mnemonic.includes('<cond>') ? form.mnemonic.replace('<cond>', 'eq') : form.mnemonic)
  return ops ? `${m} ${ops}` : m
}

export { operandsOf }
