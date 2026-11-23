/**
 * One line of assembly on its own, for the instruction set tab.
 *
 * The line goes through the real assembler (with the label operands predefined at addresses the caller
 * chooses), so the calculator picks the same form and reports the same errors as the editor. The program
 * it makes then runs in a real machine for the step-by-step demo.
 */
import { L } from '../../core/i18n'
import type { CatalogEntry, Environment, LineAnalysis, LineOperand, Program, RegValue } from '../../core/isa'
import { vaOf } from '../../core/format'
import { assemble, TEXT_BASE } from './assembler'
import { createMachine } from './cpu'
import { decodeView } from './decoder'
import { buildLine as buildFormLine, encodeInstr, formByKey, isMnemonic, operandsOf, type Form } from './encoding/table'
import { Mismatch } from './encoding/syntax'
import { splitStatements, tokenize } from './lexer'
import { FLAG_Z, parseGpr, PC, SP } from './registers'

/** Where base registers point in the demo: a writable block, so offsets of a few KB stay valid. */
export const DEMO_DATA = 0x500000
const DEMO_SIZE = 0x10000
const DEMO_BASE = DEMO_DATA + 0x800
const INT_DEFAULTS = [42n, 7n, -5n, 100n, 3n, 9n]

const quietEnv = (): Environment => ({
  print: () => {},
  readLine: () => null,
  readChar: () => null,
  dialog: () => null,
  files: { read: () => null, write: () => {}, list: () => [] },
  now: () => 0,
})

const kindOf: Record<string, string> = { reg: 'reg', imm: 'int', label: 'label', word: 'word', mem: 'mem' }

/** Write a form's line from operand texts. */
export function buildLine(key: string, operands: string[]): string {
  const form = formByKey(key)
  if (!form) return operands.join(', ')
  return buildFormLine(form, operands)
}

/** Registers the line reads before writing them, with starting values that make the demo meaningful. */
function demoInputs(program: Program, count: number, form: Form, baseRegs: Set<number>, at: number, line: string): { id: number; value: RegValue }[] {
  const values = new Map<number, RegValue>()
  const order: number[] = []
  let ints = 0
  const fresh = createMachine(program, quietEnv())
  const assign = (id: number) => {
    if (values.has(id)) return
    if (id === SP || id >= 37) values.set(id, fresh.readRegister(id))
    else if (id >= FLAG_Z - 1 && id <= FLAG_Z + 2) values.set(id, id === FLAG_Z ? 1 : 0)
    else if (baseRegs.has(id)) values.set(id, BigInt(DEMO_BASE))
    else if (form.group === 'branch') values.set(id, vaOf(at + 32))
    else if (form.instr.spec.mnemonic === 'svc' && id === 8) values.set(id, 172n)
    else values.set(id, BigInt.asUintN(64, INT_DEFAULTS[ints++ % INT_DEFAULTS.length]!))
  }
  // A read set can depend on values (a fault stops the run early), so settle it in a few rounds.
  for (let round = 0; round < 3; round++) {
    const m = createMachine(program, quietEnv())
    for (const [id, v] of values) m.setRegister(id, v)
    const written = new Set<number>()
    let grew = false
    for (let i = 0; i < count && !m.halted && !m.pending; i++) {
      const pc = m.programCounter
      if (pc < at || pc >= at + 4 * count) break
      const info = m.step()
      for (const id of info.reads) {
        if (id === PC || written.has(id) || order.includes(id)) continue
        order.push(id)
        assign(id)
        grew = true
      }
      for (const w of info.writes) written.add(w.id)
    }
    if (!grew) break
  }
  // In the order the line names them; registers it does not name (flags, sp) last.
  const named = (id: number) => {
    const m = new RegExp(`\\b[xw]${id}\\b`, 'i').exec(line)
    return id < 31 && m ? m.index : Infinity
  }
  order.sort((a, b) => named(a) - named(b))
  return order.map((id) => ({ id, value: values.get(id) ?? 0n }))
}

export function analyzeLine(line: string, catalog: CatalogEntry[], options: { at?: number; labels?: Record<string, number> } = {}): LineAnalysis {
  const at = options.at ?? TEXT_BASE
  const empty: LineAnalysis = { ok: false, error: null, mnemonic: '', entry: null, operands: [], labels: [], instructions: [], program: null, inputs: [] }
  const statements = splitStatements(line, false).statements
  const text = statements.map((s) => s.text).join(' ').trim()
  if (!text) return { ...empty, error: L('输入一条指令，例如 add x0, x1, x2', 'Type an instruction, e.g. add x0, x1, x2') }
  if (statements.filter((s) => s.text.trim()).length > 1) return { ...empty, error: L('这里只能写一条指令', 'Only one instruction here') }
  const toks = tokenize(text)
  const head = toks[0]!
  if (head.kind !== 'ident' || head.text.startsWith('.') || toks[1]?.text === ':') return { ...empty, error: L('这里只能写一条指令（不带标签和伪操作）', 'Only one instruction here (no labels or directives)') }
  const mnemonic = head.text.toLowerCase()
  if (!isMnemonic(mnemonic)) return { ...empty, mnemonic, error: L(`"${head.text}" 不是可识别的指令`, `"${head.text}" is not a recognized instruction`) }
  const ops = toks.slice(1)

  // Which names the line uses as symbols: ask the encoder, giving every name an address.
  const asked = new Set<string>()
  const branchy = (m: string) => /^(b|bl|b\..*|bc\..*|cbn?z|tbn?z)$/.test(m)
  const guess = (name: string) => options.labels?.[name] ?? (branchy(mnemonic) ? at + 32 : DEMO_DATA)
  let form: Form | null = null
  let fields: Record<string, number> = {}
  let spans = new Map<number, [number, number]>()
  let error: string | null = null
  const literal = ops.some((t) => t.kind === 'punct' && t.text === '=')
  try {
    const r = encodeInstr(mnemonic, literal ? ops.slice(0, ops.findIndex((t) => t.text === '=')).concat({ kind: 'num', text: '0', col: 0, value: vaOf(at) }) : ops, {
      pc: at,
      symbol: (name) => {
        // A register name is never a symbol: without this, "add x0, x1, x2" would match the immediate form.
        if (parseGpr(name) !== null) return undefined
        asked.add(name)
        return vaOf(guess(name))
      },
    })
    form = r.form
    fields = r.fields
    spans = r.spans
  } catch (e) {
    if (!(e instanceof Mismatch)) throw e
    error = e.message
  }
  if (!form) return { ...empty, mnemonic, error }

  const items = operandsOf(form.items)
  const operands: LineOperand[] = items.map((op, k) => {
    const span = spans.get(k)
    const first = span ? ops[span[0]] : undefined
    const last = span ? ops[span[1] - 1] : undefined
    const opText = first && last ? text.slice(first.col - 1, last.col - 1 + last.text.length) : ''
    return { kind: kindOf[op.type.kind] ?? 'word', text: opText, hint: op.type.hint(op.arg), options: op.type.options?.(fields, op.arg) }
  })
  const baseRegs = new Set<number>()
  for (let i = 1; i < ops.length; i++) {
    if (ops[i - 1]!.text !== '[' || ops[i]!.kind !== 'ident') continue
    const m = /^(x|w)(\d+)$|^(sp)$/i.exec(ops[i]!.text)
    if (m) baseRegs.add(m[3] ? SP : Number(m[2]))
  }
  const labels = [...asked].filter((n) => !/^\d/.test(n)).map((name) => ({ name, addr: guess(name) }))
  const predefined: Record<string, number> = {}
  for (const l of labels) predefined[l.name] = l.addr

  const result = assemble({ name: 'calc.s', text }, { textBase: at, predefined })
  const entry = catalog.find((e) => e.key === form!.key) ?? null
  const base = { ...empty, mnemonic, entry, operands, labels }
  const err = result.diagnostics.find((d) => d.severity === 'error')
  if (!result.ok || !result.program) return { ...base, error: err?.message ?? L('无法汇编', 'Cannot assemble') }
  const program = result.program
  // A writable block for the demo's base registers.
  program.sections = [...(program.sections ?? []), { name: '.data', addr: DEMO_DATA, size: DEMO_SIZE }]
  const instructions = program.instructions.filter((i) => i.line === 1).map((i) => ({ addr: i.addr, word: i.word, basic: i.basic, view: decodeView(i.word, i.addr) }))
  const inputs = demoInputs(program, instructions.length, form, baseRegs, at, text)
  return { ...base, ok: true, instructions, program, inputs }
}
