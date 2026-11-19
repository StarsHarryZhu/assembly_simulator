/**
 * One line of assembly on its own, for the instruction set tab.
 *
 * The line goes through the real assembler inside a tiny program, so the calculator picks the same form,
 * produces the same expansion and reports the same errors as the editor. Label operands are defined at
 * addresses the caller chooses. The same program then runs in a real machine for the step-by-step demo.
 */
import { L } from '../../core/i18n'
import type { CatalogEntry, Environment, LineAnalysis, LineOperand, Program } from '../../core/isa'
import { bitsFromDouble, bitsFromFloat } from '../../core/format'
import { assemble, DATA_BASE, KDATA_BASE, KTEXT_BASE, TEXT_BASE } from './assembler'
import { createMachine } from './cpu'
import { decodeView } from './decoder'
import { ALL_FORMS, choose, describeSpec, type Form, type Spec } from './forms'
import { tokenize } from './lexer'
import { A0, F0, FCC0, GP, GPR_NAMES, HI, LO, PC, SP, V0 } from './registers'

const GPR_OPTIONS = GPR_NAMES.map((n) => '$' + n)
const FPR_OPTIONS = Array.from({ length: 32 }, (_, i) => '$f' + i)
const C0_OPTIONS = ['$8', '$12', '$13', '$14']
const INT_DEFAULTS = [42, 7, -5, 100, 3, 9]
const FLOAT_DEFAULTS = [1.5, -2.25, 10, 0.1]
/** Base register value for memory operands: a data address that stays valid for offsets of ±32 KB. */
const DEMO_BASE = DATA_BASE + 0x80

const byKey = new Map(ALL_FORMS.map((f) => [f.key, f]))

function entryOf(f: Form, catalog: CatalogEntry[]): CatalogEntry | null {
  return catalog.find((e) => e.key === f.key) ?? null
}

function operandOf(s: Spec, text: string): LineOperand | null {
  switch (s.k) {
    case 'reg':
      return { kind: 'reg', text, hint: describeSpec(s), options: GPR_OPTIONS }
    case 'freg':
      return { kind: 'freg', text, hint: describeSpec(s), options: FPR_OPTIONS }
    case 'c0':
      return { kind: 'c0', text, hint: describeSpec(s), options: C0_OPTIONS }
    case 'int':
      return { kind: 'int', text, hint: describeSpec(s) }
    case 'ident':
      return { kind: 'label', text, hint: L('标签（地址在下面设置）', 'a label (set its address below)') }
    default:
      return null
  }
}

/** Write a form's line from operand texts, punctuated the way the form's example is. */
export function buildLine(key: string, operands: string[]): string {
  const form = byKey.get(key)
  if (!form) return operands.join(', ')
  let out = ''
  let i = 0
  let prev: Spec['k'] | null = null
  for (const s of form.spec) {
    if (s.k === 'lparen') out += '('
    else if (s.k === 'rparen') out += ')'
    else if (s.k === 'plus') out += '+'
    else {
      if (prev !== null && prev !== 'lparen' && prev !== 'plus') out += ', '
      out += operands[i++] ?? ''
    }
    prev = s.k
  }
  return out ? `${form.name} ${out}` : form.name
}

function isBranchy(f: Form): boolean {
  if (f.basic) return f.basic.ops.some((o) => o === 'off' || o === 'tgt')
  return /^(b|j)/.test(f.name)
}

function segmentFor(addr: number): string {
  addr >>>= 0
  if (addr < 0x10000000) return '.text'
  if (addr < KTEXT_BASE) return '.data'
  if (addr < KDATA_BASE) return '.ktext'
  return '.kdata'
}

const hex = (v: number) => '0x' + (v >>> 0).toString(16).padStart(8, '0')

const quietEnv = (): Environment => ({
  print: () => {},
  readLine: () => null,
  readChar: () => null,
  dialog: () => null,
  files: { read: () => null, write: () => {}, list: () => [] },
  now: () => 0,
})

/** Registers the expansion reads before writing them, with starting values that make the demo meaningful. */
function demoInputs(program: Program, count: number, f: Form, baseRegs: Set<number>, at: number): { id: number; value: number }[] {
  const values = new Map<number, number>()
  const order: number[] = []
  const double = /\.d$|^(ldc1|sdc1|l\.d|s\.d|mfc1\.d)$/.test(f.name)
  const wordFp = /\.w$/.test(f.name)
  let ints = 0
  let floats = 0
  const fresh = createMachine(program, quietEnv())
  const assign = (id: number) => {
    if (values.has(id)) return
    if (id === SP || id === GP || id >= 74) values.set(id, fresh.readRegister(id) as number)
    else if (baseRegs.has(id)) values.set(id, DEMO_BASE)
    else if (f.name === 'jr' || f.name === 'jalr') values.set(id, at + 32)
    else if (f.name === 'syscall' && id === V0) values.set(id, 1)
    else if (f.name === 'syscall' && id === A0) values.set(id, 42)
    else if (id < 32 || id === HI || id === LO) values.set(id, INT_DEFAULTS[ints++ % INT_DEFAULTS.length]!)
    else if (id >= FCC0) values.set(id, 1)
    else if (double && (id - F0) % 2 === 0) {
      const [lo, hi] = bitsFromDouble(FLOAT_DEFAULTS[floats++ % FLOAT_DEFAULTS.length]!)
      values.set(id, lo)
      values.set(id + 1, hi)
    } else if (double) values.set(id, 0)
    else if (wordFp) values.set(id, INT_DEFAULTS[ints++ % INT_DEFAULTS.length]!)
    else values.set(id, bitsFromFloat(FLOAT_DEFAULTS[floats++ % FLOAT_DEFAULTS.length]!))
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
        if (id === 0 || id === PC || written.has(id) || order.includes(id)) continue
        order.push(id)
        assign(id)
        // A double operand is a register pair: list both halves together.
        if (double && id >= F0 && id < FCC0 && (id - F0) % 2 === 0 && !order.includes(id + 1)) order.push(id + 1)
        grew = true
      }
      for (const w of info.writes) written.add(w.id)
    }
    if (!grew) break
  }
  return order.map((id) => ({ id, value: values.get(id) ?? 0 }))
}

export function analyzeLine(line: string, catalog: CatalogEntry[], options: { at?: number; labels?: Record<string, number> } = {}): LineAnalysis {
  const at = (options.at ?? TEXT_BASE) >>> 0
  const empty: LineAnalysis = { ok: false, error: null, mnemonic: '', entry: null, operands: [], labels: [], instructions: [], program: null, inputs: [] }
  const text = line.replace(/#.*$/, '').trim()
  if (!text) return { ...empty, error: L('输入一条指令，例如 add $t0, $t1, $t2', 'Type an instruction, e.g. add $t0, $t1, $t2') }
  const toks = tokenize(text)
  const head = toks[0]!
  if (head.kind !== 'ident') return { ...empty, error: L('这里只能写一条指令（不带标签和伪操作）', 'Only one instruction here (no labels or directives)') }
  const name = head.text.toLowerCase()
  const ops = toks.slice(1)
  const choice = choose(name, ops)
  if (!choice) return { ...empty, mnemonic: name, error: L(`"${head.text}" 不是可识别的指令`, `"${head.text}" is not a recognized instruction`) }
  const form = choice.form

  const operands: LineOperand[] = []
  const baseRegs = new Set<number>()
  for (let i = 0; i < form.spec.length; i++) {
    const op = operandOf(form.spec[i]!, ops[i]?.text ?? '')
    if (op) operands.push(op)
  }
  for (let i = 1; i < ops.length; i++) if (ops[i - 1]!.kind === 'lparen' && ops[i]!.kind === 'reg') baseRegs.add(ops[i]!.value!)

  const labels: { name: string; addr: number }[] = []
  for (const t of ops) {
    if (t.kind !== 'ident' || labels.some((l) => l.name === t.text)) continue
    const given = options.labels?.[t.text]
    labels.push({ name: t.text, addr: (given ?? (isBranchy(form) ? at + 32 : DATA_BASE)) >>> 0 })
  }

  const source = [`.text ${hex(at)}`, text, ...labels.flatMap((l) => [`${segmentFor(l.addr)} ${hex(l.addr)}`, `${l.name}:`])].join('\n')
  const result = assemble({ name: 'calc.asm', text: source })
  const base = { ...empty, mnemonic: name, entry: entryOf(form, catalog), operands, labels }
  const err = result.diagnostics.find((d) => d.severity === 'error')
  if (!result.ok || !result.program) {
    return { ...base, error: err ? (err.line === 2 ? err.message : L(`标签设置有误：${err.message}`, `Bad label setting: ${err.message}`)) : L('无法汇编', 'Cannot assemble') }
  }
  const program = result.program
  const instructions = program.instructions
    .filter((i) => i.line === 2)
    .map((i) => ({ addr: i.addr, word: i.word, basic: i.basic, view: decodeView(i.word, i.addr) }))
  const inputs = demoInputs(program, instructions.length, form, baseRegs, at)
  return { ...base, ok: true, instructions, program, inputs }
}
