/**
 * GNU as (AArch64) assembler, following LLVM's integrated assembler where the two differ.
 *
 * One pass walks the statements in order: it expands .include, macros, .rept/.irp and .if, keeps the
 * location counter of every section, defines labels and .equ symbols, sizes data and reserves literal-pool
 * entries (every instruction is 4 bytes, so nothing waits for later). A second pass evaluates operands with
 * every symbol known, encodes the instructions and writes the data.
 *
 * Sections are then laid out one after another, page-aligned, as a linker would: .text at 0x400000, then
 * .rodata, .data and .bss, so ADR reaches data from code; the kernel's .ktext starts at 0xffff800000000000
 * with .kdata after it. Until then pass 1 keeps each section at a provisional base far from the others,
 * which is enough for differences between labels of one section; .equ values that depend on an address
 * wait for the final layout. Calls to C library functions the program does not define go to the built-in
 * library (libc.ts), like calls through a dynamic linker's PLT.
 */
import { L } from '../../core/i18n'
import { addrOf, vaOf } from '../../core/format'
import type { AssembleOptions, AssembleResult, DataDeclaration, DataKind, Diagnostic, Program, ProgramInstruction, SourceFile } from '../../core/isa'
import { ExprError, parseExpr } from './expr'
import { splitStatements, tokenize, type Tok } from './lexer'
import { loadTables } from './instructions/index'
import { disassemble, encodeInstr, isMnemonic } from './encoding/table'
import { Mismatch } from './encoding/syntax'
import { LIBC_FUNCTIONS, stubAddress } from './libc'
import { HEAP_BASE, KSTACK_TOP, KTEXT_BASE, pageUp } from './linux'

loadTables()

export const TEXT_BASE = 0x400000
/** User sections must end below the brk heap; kernel sections 16 MB into the top half, below the kernel stack. */
export const USER_LIMIT = HEAP_BASE
export const KERNEL_LIMIT = KTEXT_BASE + 0x1000000
export { KTEXT_BASE, KSTACK_TOP }

export type SectionId = 'text' | 'rodata' | 'data' | 'bss' | 'ktext' | 'kdata' | 'discard'

interface SectionSpec {
  /** Where pass 1 puts the section, and how big it may grow. */
  provisional: number
  capacity: number
  title: string
}

const MB = 1 << 20
export const SECTIONS: Record<Exclude<SectionId, 'discard'>, SectionSpec> = {
  text: { provisional: TEXT_BASE, capacity: 32 * MB, title: '.text' },
  rodata: { provisional: 0x4000000, capacity: 32 * MB, title: '.rodata' },
  data: { provisional: 0x8000000, capacity: 32 * MB, title: '.data' },
  bss: { provisional: 0xc000000, capacity: 64 * MB, title: '.bss' },
  ktext: { provisional: KTEXT_BASE, capacity: 4 * MB, title: '.ktext' },
  kdata: { provisional: KTEXT_BASE + 0x800000, capacity: 4 * MB, title: '.kdata' },
}
const ORDER: Exclude<SectionId, 'discard'>[] = ['text', 'rodata', 'data', 'bss', 'ktext', 'kdata']

const NOP = 0xd503201f

/* ------------------------------------------------------------------ directives */

const DATA_SIZES: Record<string, { size: number; kind: DataKind }> = {
  '.byte': { size: 1, kind: 'byte' },
  '.hword': { size: 2, kind: 'half' },
  '.short': { size: 2, kind: 'half' },
  '.2byte': { size: 2, kind: 'half' },
  '.word': { size: 4, kind: 'word' },
  '.long': { size: 4, kind: 'word' },
  '.int': { size: 4, kind: 'word' },
  '.4byte': { size: 4, kind: 'word' },
  '.quad': { size: 8, kind: 'dword' },
  '.xword': { size: 8, kind: 'dword' },
  '.dword': { size: 8, kind: 'dword' },
  '.8byte': { size: 8, kind: 'dword' },
}

/** Directives accepted and ignored: symbol bookkeeping, debug info and unwinding tables. */
const IGNORED = new Set([
  '.global', '.globl', '.local', '.weak', '.hidden', '.protected', '.internal', '.type', '.size', '.file', '.ident', '.loc',
  '.arch', '.arch_extension', '.cpu', '.fpu', '.variant_pcs', '.extern', '.func', '.endfunc', '.addrsig', '.addrsig_sym',
  '.cfi_startproc', '.cfi_endproc', '.cfi_def_cfa', '.cfi_def_cfa_offset', '.cfi_def_cfa_register', '.cfi_offset', '.cfi_restore',
  '.cfi_adjust_cfa_offset', '.cfi_rel_offset', '.cfi_remember_state', '.cfi_restore_state', '.cfi_sections', '.cfi_negate_ra_state',
  '.cfi_undefined', '.cfi_same_value', '.cfi_register', '.cfi_escape', '.cfi_signal_frame', '.cfi_window_save', '.cfi_b_key_frame',
  '.cfi_personality', '.cfi_lsda', '.cfi_return_column', '.cfi_mte_tagged_frame', '.uleb128', '.sleb128',
])

export const DIRECTIVES = [
  ...Object.keys(DATA_SIZES),
  '.text', '.data', '.bss', '.rodata', '.section', '.pushsection', '.popsection', '.previous',
  '.ascii', '.asciz', '.string', '.float', '.single', '.double', '.skip', '.space', '.zero', '.fill',
  '.align', '.p2align', '.balign', '.org', '.inst', '.ltorg', '.pool',
  '.equ', '.set', '.equiv', '.eqv', '.include', '.macro', '.endm', '.exitm', '.purgem', '.rept', '.irp', '.irpc', '.endr',
  '.if', '.ifdef', '.ifndef', '.ifeq', '.ifne', '.ifgt', '.ifge', '.iflt', '.ifle', '.ifc', '.ifnc', '.ifb', '.ifnb', '.else', '.elseif', '.endif',
  '.err', '.error', '.warning', '.print', '.end',
  ...IGNORED,
].sort()

/* ------------------------------------------------------------------ model */

interface Stmt {
  file: string
  line: number
  /** The source line shown for this statement (the macro call's line for a macro body). */
  source: string
  /** The statement text (comments blanked) and its first column. */
  text: string
  col: number
}

interface SectionState {
  id: SectionId
  offset: number
  bytes: Uint8Array
  /** Bytes actually written (data), for the image. */
  size: number
  pool: PoolEntry[]
}

interface PoolEntry {
  toks: Tok[]
  size: number
  /** Offset in the section, once placed. */
  offset: number
  stmt: Stmt
  value: bigint | null
}

interface InstrRecord {
  stmt: Stmt
  section: SectionId
  offset: number
  mnemonic: string
  /** Column of the mnemonic. */
  mcol: number
  toks: Tok[]
  /** For `ldr Rt, =value`: the pool entry, or the MOVZ it became. */
  pool: PoolEntry | null
  movz?: { value: bigint; shift: bigint } | null
  /** For .inst: the expression tokens. */
  inst?: boolean
}

interface DataRecord {
  stmt: Stmt
  section: SectionId
  offset: number
  size: number
  toks: Tok[]
  float?: 'float' | 'double'
}

interface Macro {
  name: string
  params: { name: string; dflt: string; required: boolean; vararg: boolean }[]
  body: Stmt[]
}

class Diags {
  list: Diagnostic[] = []
  error(s: { file: string; line: number }, col: number, code: string, message: string, length?: number) {
    this.list.push({ severity: 'error', file: s.file, line: s.line, col, code, message, length })
  }
  warn(s: { file: string; line: number }, col: number, code: string, message: string, length?: number) {
    this.list.push({ severity: 'warning', file: s.file, line: s.line, col, code, message, length })
  }
  get errors() {
    return this.list.filter((d) => d.severity === 'error').length
  }
}

/** Split operand text at top-level commas. */
function splitArgs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      cur += c
      if (c === '\\') cur += text[++i] ?? ''
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"') quote = c
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim() || out.length) out.push(cur.trim())
  return out
}

/** The value of a float literal token sequence: [-] float | [-] int. */
function floatValue(toks: Tok[]): number | null {
  let sign = 1
  let i = 0
  if (toks[i]?.kind === 'punct' && (toks[i]!.text === '-' || toks[i]!.text === '+')) {
    if (toks[i]!.text === '-') sign = -1
    i++
  }
  const t = toks[i]
  if (!t || i !== toks.length - 1) return null
  if (t.kind === 'float') return sign * t.fnum!
  if (t.kind === 'num') return sign * Number(t.value!)
  if (t.kind === 'ident' && /^(inf|infinity|nan)$/i.test(t.text)) return t.text.toLowerCase() === 'nan' ? NaN : sign * Infinity
  return null
}

/* ------------------------------------------------------------------ assemble */

export interface ArmAssembleOptions extends AssembleOptions {
  /** Where .text starts (the calculator places its line at a chosen address). */
  textBase?: number
  /** Labels defined up front at fixed addresses (the calculator's label operands). */
  predefined?: Record<string, number>
}

export function assemble(main: SourceFile, options: ArmAssembleOptions = {}): AssembleResult {
  const diags = new Diags()
  const files = new Map((options.files ?? []).map((f) => [f.name, f.text]))
  const textBase = options.textBase ?? TEXT_BASE

  const sections = new Map<SectionId, SectionState>()
  const section = (id: SectionId): SectionState => {
    let s = sections.get(id)
    if (!s) {
      s = { id, offset: 0, bytes: new Uint8Array(id === 'bss' || id === 'discard' ? 0 : 4096), size: 0, pool: [] }
      sections.set(id, s)
    }
    return s
  }
  /** Section bases: provisional during pass 1, final afterwards. */
  const bases: Record<SectionId, number> = { text: textBase, rodata: 0, data: 0, bss: 0, ktext: 0, kdata: 0, discard: 0 }
  for (const id of ORDER) if (id !== 'text') bases[id] = SECTIONS[id].provisional
  const baseOf = (id: SectionId) => bases[id]
  const limitOf = (id: SectionId) => (id === 'discard' ? Infinity : bases[id] + SECTIONS[id].capacity)

  let cur = section('text')
  const sectionStack: SectionId[] = []
  let previous: SectionId = 'text'

  /** Symbols: labels are internal addresses (numbers) in a section; .equ values are bigints. */
  const labels = new Map<string, number>()
  const labelSection = new Map<string, SectionId>()
  const equs = new Map<string, bigint>()
  /** .equ symbols whose value depends on an address (or on a later symbol): evaluated when used. */
  const deferred = new Map<string, { toks: Tok[]; stmt: Stmt; section: SectionId; offset: number }>()
  const definedAt = new Map<string, Stmt>()
  for (const [name, addr] of Object.entries(options.predefined ?? {})) labels.set(name, addr)
  const localCounts = new Map<string, number>()

  const instructions: InstrRecord[] = []
  const datas: DataRecord[] = []
  const declarations: DataDeclaration[] = []
  const declarationAt: { section: SectionId; offset: number }[] = []
  let lastLabel: { name: string; addr: number } | null = null

  const here = () => baseOf(cur.id) + cur.offset

  const resolving = new Set<string>()
  const symbol = (name: string): bigint | undefined => {
    const l = labels.get(name)
    if (l !== undefined) return vaOf(l)
    const e = equs.get(name)
    if (e !== undefined) return e
    const d = deferred.get(name)
    if (d && !resolving.has(name)) {
      resolving.add(name)
      try {
        return parseExpr(d.toks, 0, { symbol, dot: vaOf(baseOf(d.section) + d.offset) }).value
      } catch {
        return undefined
      } finally {
        resolving.delete(name)
      }
    }
    return undefined
  }
  /** Pass 2 also knows the C library. */
  const finalSymbol = (name: string): bigint | undefined => {
    const v = symbol(name)
    if (v !== undefined) return v
    if (LIBC_FUNCTIONS.includes(name)) {
      usedLibc.add(name)
      return vaOf(stubAddress(name))
    }
    return undefined
  }
  const usedLibc = new Set<string>()

  const evalNow = (toks: Tok[], stmt: Stmt, what: string): bigint | null => {
    try {
      const r = parseExpr(toks, 0, { symbol, dot: vaOf(here()) })
      if (r.end < toks.length) {
        diags.error(stmt, toks[r.end]!.col, 'bad-expression', L(`${what}：多余的内容 "${toks[r.end]!.text}"`, `${what}: unexpected "${toks[r.end]!.text}"`))
        return null
      }
      return r.value
    } catch (e) {
      if (e instanceof ExprError) {
        diags.error(stmt, e.col, e.undefinedSymbol ? 'undefined-symbol' : 'bad-expression', e.undefinedSymbol ? L(`${what}：符号 "${e.undefinedSymbol}" 在这里还没有定义（这个值要在汇编时就确定）`, `${what}: symbol "${e.undefinedSymbol}" is not defined yet (the value must be known here)`) : e.message, e.length)
        return null
      }
      throw e
    }
  }

  /** Grow a section's buffer to hold `end` bytes. */
  const reserve = (s: SectionState, end: number, stmt: Stmt, col: number): boolean => {
    if (baseOf(s.id) + end > limitOf(s.id)) {
      diags.error(stmt, col, 'section-full', L(`${SECTIONS[s.id as Exclude<SectionId, 'discard'>]?.title ?? s.id} 段放不下了`, `The ${SECTIONS[s.id as Exclude<SectionId, 'discard'>]?.title ?? s.id} section is full`))
      return false
    }
    if (s.id === 'bss' || s.id === 'discard') return true
    if (end > s.bytes.length) {
      let n = s.bytes.length
      while (n < end) n *= 2
      const b = new Uint8Array(n)
      b.set(s.bytes)
      s.bytes = b
    }
    s.size = Math.max(s.size, end)
    return true
  }

  const writeBytes = (s: SectionState, offset: number, bytes: ArrayLike<number>) => {
    if (s.id === 'bss' || s.id === 'discard') return
    s.bytes.set(bytes as Uint8Array, offset)
  }

  const isCodeSection = (id: SectionId) => id === 'text' || id === 'ktext'

  const declare = (stmt: Stmt, kind: DataKind, addr: number, size: number, count: number) => {
    if (isCodeSection(cur.id) || cur.id === 'discard') return
    const label = lastLabel && lastLabel.addr === addr ? lastLabel.name : null
    declarations.push({ label, kind, addr, size, count, file: stmt.file, line: stmt.line, segment: cur.id })
    declarationAt.push({ section: cur.id, offset: addr - baseOf(cur.id) })
  }

  /** Place a section's literal pool here. */
  const flushPool = (s: SectionState) => {
    for (const e of s.pool) {
      const off = Math.ceil(s.offset / e.size) * e.size
      if (!reserve(s, off + e.size, e.stmt, e.stmt.col)) return
      e.offset = off
      s.offset = off + e.size
    }
    s.pool = []
  }

  const align = (stmt: Stmt, col: number, bytes: number, fill: number | null, max: number | null) => {
    if (bytes <= 1) return
    const target = Math.ceil(cur.offset / bytes) * bytes
    if (max !== null && target - cur.offset > max) return
    if (!reserve(cur, target, stmt, col)) return
    if (fill === null && isCodeSection(cur.id)) {
      let o = cur.offset
      while (o % 4 && o < target) writeBytes(cur, o++, [0])
      for (; o + 4 <= target; o += 4) writeBytes(cur, o, [NOP & 0xff, (NOP >> 8) & 0xff, (NOP >> 16) & 0xff, NOP >>> 24])
    } else if (fill !== null) for (let o = cur.offset; o < target; o++) writeBytes(cur, o, [fill & 0xff])
    cur.offset = target
  }

  const switchTo = (id: SectionId) => {
    if (id !== cur.id) previous = cur.id
    cur = section(id)
  }

  const sectionFor = (name: string, flags: string): SectionId | null => {
    const n = name.toLowerCase()
    if (n === '.text' || n.startsWith('.text.')) return 'text'
    if (n === '.rodata' || n.startsWith('.rodata.')) return 'rodata'
    if (n === '.data' || n.startsWith('.data.')) return 'data'
    if (n === '.bss' || n.startsWith('.bss.')) return 'bss'
    if (n === '.ktext' || n.startsWith('.ktext.')) return 'ktext'
    if (n === '.kdata' || n.startsWith('.kdata.')) return 'kdata'
    if (n.startsWith('.note') || n.startsWith('.comment') || n.startsWith('.debug') || n.startsWith('.eh_frame')) return 'discard'
    if (flags.includes('x')) return 'text'
    if (flags.includes('w')) return 'data'
    if (flags.includes('a')) return 'rodata'
    return null
  }

  /* -------------------------------------------------------------- statements */

  const macros = new Map<string, Macro>()
  let macroSerial = 0
  /** .if nesting: whether each level is active, and whether a branch has been taken. */
  const conds: { active: boolean; taken: boolean; parent: boolean }[] = []
  const active = () => conds.length === 0 || conds[conds.length - 1]!.active
  let ended = false

  /** Read a file's statements. */
  const readFile = (name: string, text: string): Stmt[] => {
    const out: Stmt[] = []
    let inBlock = false
    text.split(/\r?\n/).forEach((src, i) => {
      const r = splitStatements(src, inBlock)
      inBlock = r.inBlock
      for (const st of r.statements) out.push({ file: name, line: i + 1, source: src, text: st.text, col: st.col })
    })
    return out
  }

  const queue: Stmt[] = readFile(main.name, main.text)
  const includeDepth = new Map<string, number>()

  /** Collect a block's body up to its end directive (.endm, .endr), with nesting. */
  const collectBlock = (opens: RegExp, close: RegExp, start: Stmt): Stmt[] | null => {
    const body: Stmt[] = []
    let depth = 1
    while (queue.length) {
      const s = queue.shift()!
      const word = /^\s*(?:[\w.$]+:\s*)*(\.\w+)/.exec(s.text)?.[1]?.toLowerCase() ?? ''
      if (opens.test(word)) depth++
      else if (close.test(word) && --depth === 0) return body
      body.push(s)
    }
    diags.error(start, start.col, 'unterminated-block', L('缺少结束的 .endm / .endr', 'Missing the closing .endm / .endr'))
    return null
  }

  const substitute = (body: Stmt[], values: Map<string, string>, at: Stmt): Stmt[] => {
    const serial = String(macroSerial++)
    return body.map((s) => {
      let text = s.text.replace(/\\(\w+|@|\(\))/g, (m, name: string) => {
        if (name === '@') return serial
        if (name === '()') return ''
        return values.has(name) ? values.get(name)! : m
      })
      // A substituted value may hold a ';' that splits statements; keep it whole as GNU as does not, either.
      if (text.includes('\n')) text = text.replace(/\n/g, ' ')
      return { file: at.file, line: at.line, source: at.source, text, col: at.col }
    })
  }

  while (queue.length && !ended) {
    const stmt = queue.shift()!
    let toks = tokenize(stmt.text, stmt.col - 1)
    if (!toks.length) continue
    const bad = toks.find((t) => t.kind === 'bad')

    // Conditional assembly comes first: it decides whether anything else here counts.
    const head0 = labelsEnd(toks)
    const dir0 = toks[head0]?.kind === 'ident' ? toks[head0]!.text.toLowerCase() : ''
    if (/^\.if/.test(dir0) || dir0 === '.else' || dir0 === '.elseif' || dir0 === '.endif') {
      handleConditional(stmt, toks, head0, dir0)
      continue
    }
    if (!active()) continue
    if (bad) {
      diags.error(stmt, bad.col, 'bad-token', bad.error!, bad.text.length)
      continue
    }

    // Labels: name: (also numeric local labels 1:)
    let i = 0
    while (i + 1 < toks.length && (toks[i]!.kind === 'ident' || toks[i]!.kind === 'num') && toks[i + 1]!.kind === 'punct' && toks[i + 1]!.text === ':') {
      const t = toks[i]!
      if (t.kind === 'num') {
        const key = String(t.value)
        const n = (localCounts.get(key) ?? 0) + 1
        localCounts.set(key, n)
        defineLabel(`\u0001L${key}_${n}`, stmt, t)
      } else defineLabel(t.text, stmt, t)
      i += 2
    }
    toks = toks.slice(i)
    if (!toks.length) continue
    // Numeric local references: 1b, 1f.
    for (const [k, t] of toks.entries()) {
      if (t.kind !== 'local') continue
      const key = String(t.value)
      const n = localCounts.get(key) ?? 0
      const target = t.dir === 'b' ? n : n + 1
      if (t.dir === 'b' && n === 0) {
        diags.error(stmt, t.col, 'undefined-symbol', L(`前面没有局部标签 ${key}:`, `No local label ${key}: before this`), t.text.length)
        toks = []
        break
      }
      toks[k] = { kind: 'ident', text: `\u0001L${key}_${target}`, col: t.col }
    }
    if (!toks.length) continue
    const head = toks[0]!
    // name = value
    if (head.kind === 'ident' && toks[1]?.kind === 'punct' && toks[1].text === '=' && !isMnemonic(head.text)) {
      defineEqu(head.text, toks.slice(2), stmt, head, false)
      continue
    }
    if (head.kind !== 'ident') {
      diags.error(stmt, head.col, 'syntax', L(`这里应该是指令或伪操作，而不是 "${head.text}"`, `Expected an instruction or directive, not "${head.text}"`), head.text.length)
      continue
    }
    const word = head.text.toLowerCase()
    const args = toks.slice(1)
    if (word.startsWith('.')) {
      directive(stmt, word, head, args)
      continue
    }
    const macro = macros.get(word)
    if (macro) {
      expandMacro(macro, stmt, head, toks)
      continue
    }
    instruction(stmt, head, args)
  }

  for (const c of conds) void c
  if (conds.length) diags.error({ file: main.name, line: 1 }, 0, 'unterminated-if', L('有 .if 缺少对应的 .endif', 'An .if is missing its .endif'))

  function labelsEnd(toks: Tok[]): number {
    let i = 0
    while (i + 1 < toks.length && (toks[i]!.kind === 'ident' || toks[i]!.kind === 'num') && toks[i + 1]!.kind === 'punct' && toks[i + 1]!.text === ':') i += 2
    return i
  }

  function defineLabel(name: string, stmt: Stmt, t: Tok) {
    if (labels.has(name) || equs.has(name) || deferred.has(name)) {
      const first = definedAt.get(name)
      diags.error(stmt, t.col, 'duplicate-label', L(`标签 "${name}" 重复定义${first ? `（第一次在第 ${first.line} 行）` : ''}`, `Label "${name}" is already defined${first ? ` (first on line ${first.line})` : ''}`), t.text.length)
      return
    }
    if (isMnemonic(name) && !name.startsWith('\u0001')) diags.warn(stmt, t.col, 'label-is-mnemonic', L(`标签 "${name}" 和指令同名，容易看错`, `Label "${name}" has the name of an instruction`), t.text.length)
    labels.set(name, here())
    labelSection.set(name, cur.id)
    definedAt.set(name, stmt)
    if (!name.startsWith('\u0001')) lastLabel = { name, addr: here() }
  }

  function defineEqu(name: string, toks: Tok[], stmt: Stmt, t: Tok, once: boolean) {
    if (labels.has(name) || (once && (equs.has(name) || deferred.has(name)))) {
      diags.error(stmt, t.col, 'duplicate-label', L(`符号 "${name}" 已经定义过了`, `Symbol "${name}" is already defined`), t.text.length)
      return
    }
    if (!toks.length) {
      diags.error(stmt, t.col, 'bad-directive', L(`符号 "${name}" 缺少值`, `Symbol "${name}" needs a value`))
      return
    }
    const later = { toks, stmt, section: cur.id, offset: cur.offset }
    try {
      const r = parseExpr(toks, 0, { symbol, dot: vaOf(here()) })
      if (r.end < toks.length) {
        diags.error(stmt, toks[r.end]!.col, 'bad-expression', L(`多余的内容 "${toks[r.end]!.text}"`, `Unexpected "${toks[r.end]!.text}"`))
        return
      }
      // An address is final only after layout: keep the expression and evaluate it when used.
      if (toks.some((k) => k.kind === 'ident' && (k.text === '.' || labels.has(k.text) || deferred.has(k.text)))) {
        equs.delete(name)
        deferred.set(name, later)
      } else {
        equs.set(name, r.value)
        deferred.delete(name)
      }
    } catch (e) {
      if (!(e instanceof ExprError)) throw e
      if (!e.undefinedSymbol) {
        diags.error(stmt, e.col, 'bad-expression', e.message, e.length)
        return
      }
      // Refers to something defined later: evaluate when it is used.
      equs.delete(name)
      deferred.set(name, later)
    }
    definedAt.set(name, stmt)
  }

  function handleConditional(stmt: Stmt, toks: Tok[], at: number, dir: string) {
    const args = toks.slice(at + 1)
    const parent = active()
    const text = stmt.text.slice(toks[at]!.col - stmt.col + toks[at]!.text.length).trim()
    const test = (): boolean => {
      if (!parent) return false
      switch (dir) {
        case '.ifdef':
        case '.ifndef': {
          const name = args[0]?.text ?? ''
          const def = labels.has(name) || equs.has(name) || deferred.has(name)
          return dir === '.ifdef' ? def : !def
        }
        case '.ifc':
        case '.ifnc': {
          const [a = '', b = ''] = splitArgs(text).map((x) => x.replace(/^'(.*)'$/, '$1'))
          return (a === b) === (dir === '.ifc')
        }
        case '.ifb':
          return text === ''
        case '.ifnb':
          return text !== ''
      }
      const v = evalNow(args, stmt, dir) ?? 0n
      switch (dir) {
        case '.if':
        case '.ifne':
        case '.elseif':
          return v !== 0n
        case '.ifeq':
          return v === 0n
        case '.ifgt':
          return v > 0n
        case '.ifge':
          return v >= 0n
        case '.iflt':
          return v < 0n
        case '.ifle':
          return v <= 0n
      }
      return false
    }
    if (dir === '.endif') {
      if (!conds.pop()) diags.error(stmt, toks[at]!.col, 'bad-directive', L('.endif 没有对应的 .if', '.endif without .if'))
      return
    }
    if (dir === '.else') {
      const c = conds[conds.length - 1]
      if (!c) return diags.error(stmt, toks[at]!.col, 'bad-directive', L('.else 没有对应的 .if', '.else without .if'))
      c.active = c.parent && !c.taken
      c.taken = true
      return
    }
    if (dir === '.elseif') {
      const c = conds[conds.length - 1]
      if (!c) return diags.error(stmt, toks[at]!.col, 'bad-directive', L('.elseif 没有对应的 .if', '.elseif without .if'))
      if (c.taken) c.active = false
      else {
        c.active = c.parent && evalNow(args, stmt, '.elseif') !== 0n
        c.taken = c.active
      }
      return
    }
    const on = test()
    conds.push({ active: on, taken: on, parent })
  }

  function expandMacro(m: Macro, stmt: Stmt, head: Tok, toks: Tok[]) {
    if (macroSerial > 100000) {
      diags.error(stmt, head.col, 'macro-depth', L('宏展开太多次（可能是无限递归）', 'Too many macro expansions (endless recursion?)'))
      return
    }
    const argText = stmt.text.slice(head.col - stmt.col + head.text.length)
    let raw = argText.trim() ? splitArgs(argText) : []
    if (raw.length === 1 && m.params.length > 1 && /\s/.test(raw[0]!)) raw = raw[0]!.split(/\s+/)
    const values = new Map<string, string>()
    let ok = true
    m.params.forEach((p, k) => {
      let v = p.vararg ? raw.slice(k).join(', ') : raw[k]
      const named = raw.find((r) => r.startsWith(p.name + '='))
      if (named) v = named.slice(p.name.length + 1)
      if (v === undefined || v === '') {
        if (p.required) {
          diags.error(stmt, head.col, 'macro-args', L(`宏 ${m.name} 缺少参数 ${p.name}`, `Macro ${m.name} needs argument ${p.name}`))
          ok = false
        }
        v = p.dflt
      }
      values.set(p.name, v)
    })
    if (raw.length > m.params.length && !m.params.some((p) => p.vararg)) {
      diags.error(stmt, head.col, 'macro-args', L(`宏 ${m.name} 只有 ${m.params.length} 个参数，这里给了 ${raw.length} 个`, `Macro ${m.name} takes ${m.params.length} arguments, ${raw.length} given`))
      ok = false
    }
    void toks
    if (ok) queue.unshift(...substitute(m.body, values, stmt))
  }

  function directive(stmt: Stmt, d: string, head: Tok, args: Tok[]) {
    const argText = stmt.text.slice(head.col - stmt.col + head.text.length).trim()
    const err = (code: string, zh: string, en: string, t: Tok = head) => diags.error(stmt, t.col, code, L(zh, en), t.text.length)
    const exprList = (): Tok[][] => {
      const out: Tok[][] = []
      let part: Tok[] = []
      let depth = 0
      for (const t of args) {
        if (t.kind === 'punct' && t.text === '(') depth++
        if (t.kind === 'punct' && t.text === ')') depth--
        if (t.kind === 'punct' && t.text === ',' && depth === 0) {
          out.push(part)
          part = []
        } else part.push(t)
      }
      if (part.length || out.length) out.push(part)
      return out
    }
    const one = (what: string): bigint | null => {
      if (!args.length) {
        err('bad-directive', `${d} 缺少参数`, `${d} needs an argument`)
        return null
      }
      return evalNow(args, stmt, what)
    }

    if (IGNORED.has(d)) return
    const data = DATA_SIZES[d]
    if (data) {
      const list = exprList()
      if (!list.length || list.some((p) => !p.length)) return err('bad-directive', `${d} 后面要写一个或多个值，用逗号分隔`, `${d} takes one or more values separated by commas`)
      const addr = here()
      if (!reserve(cur, cur.offset + data.size * list.length, stmt, head.col)) return
      for (const p of list) {
        datas.push({ stmt, section: cur.id, offset: cur.offset, size: data.size, toks: p })
        cur.offset += data.size
      }
      declare(stmt, data.kind, addr, data.size * list.length, list.length)
      return
    }
    switch (d) {
      case '.text':
        return switchTo('text')
      case '.data':
        return switchTo('data')
      case '.bss':
        return switchTo('bss')
      case '.rodata':
        return switchTo('rodata')
      case '.section':
      case '.pushsection': {
        const parts = splitArgs(argText)
        const name = parts[0]?.trim() ?? ''
        const flags = (parts[1] ?? '').replace(/"/g, '')
        const id = sectionFor(name, flags)
        if (!name || !id) return err('unknown-section', `不认识的段 "${name}"：可以用 .text、.data、.bss、.rodata、.ktext、.kdata`, `Unknown section "${name}": use .text, .data, .bss, .rodata, .ktext or .kdata`)
        if (d === '.pushsection') sectionStack.push(cur.id)
        return switchTo(id)
      }
      case '.popsection': {
        const id = sectionStack.pop()
        if (!id) return err('bad-directive', '.popsection 没有对应的 .pushsection', '.popsection without .pushsection')
        return switchTo(id)
      }
      case '.previous':
        return switchTo(previous)
      case '.ascii':
      case '.asciz':
      case '.string': {
        if (!args.length) return err('bad-directive', `${d} 后面要写字符串`, `${d} needs a string`)
        const addr = here()
        let total = 0
        for (const p of exprList()) {
          if (p.length !== 1 || p[0]!.kind !== 'str') return err('bad-directive', `${d} 只接受用双引号括起来的字符串`, `${d} takes double-quoted strings`, p[0] ?? head)
          const bytes = [...p[0]!.bytes!, ...(d === '.ascii' ? [] : [0])]
          if (!reserve(cur, cur.offset + bytes.length, stmt, head.col)) return
          writeBytes(cur, cur.offset, bytes)
          cur.offset += bytes.length
          total += bytes.length
        }
        declare(stmt, d === '.ascii' ? 'ascii' : 'asciiz', addr, total, total)
        return
      }
      case '.float':
      case '.single':
      case '.double': {
        const list = exprList()
        const size = d === '.double' ? 8 : 4
        const addr = here()
        if (!list.length) return err('bad-directive', `${d} 后面要写数`, `${d} needs numbers`)
        if (!reserve(cur, cur.offset + size * list.length, stmt, head.col)) return
        for (const p of list) {
          if (floatValue(p) === null) return err('bad-directive', `${d} 只接受数字`, `${d} takes numbers`, p[0] ?? head)
          datas.push({ stmt, section: cur.id, offset: cur.offset, size, toks: p, float: size === 8 ? 'double' : 'float' })
          cur.offset += size
        }
        declare(stmt, size === 8 ? 'double' : 'float', addr, size * list.length, list.length)
        return
      }
      case '.skip':
      case '.space':
      case '.zero': {
        const list = exprList()
        const n = list[0] ? evalNow(list[0], stmt, d) : null
        if (n === null) return
        if (n < 0n || n > 0x10000000n) return err('bad-directive', `${d} 的大小 ${n} 不合理`, `${d} size ${n} is out of range`)
        const fill = list[1] ? evalNow(list[1], stmt, d) : 0n
        const addr = here()
        if (!reserve(cur, cur.offset + Number(n), stmt, head.col)) return
        if (fill) writeBytes(cur, cur.offset, new Uint8Array(Number(n)).fill(Number(fill & 0xffn)))
        cur.offset += Number(n)
        if (n > 0n) declare(stmt, 'space', addr, Number(n), Number(n))
        return
      }
      case '.fill': {
        const list = exprList()
        const rep = list[0] ? evalNow(list[0], stmt, d) : null
        const size = list[1] ? evalNow(list[1], stmt, d) : 1n
        const value = list[2] ? evalNow(list[2], stmt, d) : 0n
        if (rep === null || size === null || value === null) return
        if (rep < 0n || rep > 0x1000000n) return err('bad-directive', '.fill 的次数不合理', '.fill repeat count is out of range')
        const sz = Number(size > 8n ? 8n : size)
        const addr = here()
        if (!reserve(cur, cur.offset + Number(rep) * sz, stmt, head.col)) return
        for (let k = 0; k < Number(rep); k++) {
          // GNU as writes at most 4 bytes of the value, then zeros.
          const bytes: number[] = []
          for (let b = 0; b < sz; b++) bytes.push(b < 4 ? Number((value >> BigInt(8 * b)) & 0xffn) : 0)
          writeBytes(cur, cur.offset, bytes)
          cur.offset += sz
        }
        if (rep > 0n) declare(stmt, sz === 8 ? 'dword' : sz === 4 ? 'word' : sz === 2 ? 'half' : 'byte', addr, Number(rep) * sz, Number(rep))
        return
      }
      case '.align':
      case '.p2align':
      case '.balign': {
        const list = exprList()
        const n = list[0] ? evalNow(list[0], stmt, d) : null
        if (n === null) return
        const bytes = d === '.balign' ? Number(n) : 2 ** Number(n)
        if (d === '.balign' ? n < 1n || n > 1n << 16n || (n & (n - 1n)) !== 0n : n < 0n || n > 16n)
          return err('bad-directive', d === '.balign' ? '.balign 要写 2 的幂（字节数）' : `${d} 要写 0 到 16 之间的指数`, d === '.balign' ? '.balign takes a power of two (bytes)' : `${d} takes an exponent from 0 to 16`)
        const fill = list[1]?.length ? evalNow(list[1], stmt, d) : null
        const max = list[2]?.length ? evalNow(list[2], stmt, d) : null
        align(stmt, head.col, bytes, fill === null ? null : Number(fill & 0xffn), max === null ? null : Number(max))
        return
      }
      case '.org': {
        const v = one('.org')
        if (v === null) return
        let target = Number(v)
        // An absolute address in this section, or an offset from its start.
        const base = baseOf(cur.id)
        const abs = addrOf(BigInt.asUintN(64, v))
        if (abs !== null && abs >= base) target = abs - base
        if (target < cur.offset) return err('bad-directive', '.org 不能往回移动', '.org cannot move backwards')
        if (!reserve(cur, target, stmt, head.col)) return
        cur.offset = target
        return
      }
      case '.inst': {
        if (!isCodeSection(cur.id)) return err('instruction-in-data', '.inst 只能写在代码段（.text）里', '.inst belongs in a code section (.text)')
        for (const p of exprList()) {
          align(stmt, head.col, 4, null, null)
          if (!reserve(cur, cur.offset + 4, stmt, head.col)) return
          instructions.push({ stmt, section: cur.id, offset: cur.offset, mnemonic: '.inst', mcol: head.col, toks: p, pool: null, inst: true })
          cur.offset += 4
        }
        return
      }
      case '.ltorg':
      case '.pool':
        return flushPool(cur)
      case '.equ':
      case '.set':
      case '.equiv':
      case '.eqv': {
        const name = args[0]
        if (!name || name.kind !== 'ident' || args[1]?.text !== ',') return err('bad-directive', `${d} 的写法是：${d} 名字, 值`, `${d} is written: ${d} name, value`)
        return defineEqu(name.text, args.slice(2), stmt, name, d === '.equiv')
      }
      case '.include': {
        const name = args[0]?.kind === 'str' ? new TextDecoder().decode(new Uint8Array(args[0].bytes!)) : argText
        const text = files.get(name)
        if (text === undefined) return err('include', `找不到要包含的文件 "${name}"（先在“文件”面板里添加）`, `Cannot find the included file "${name}" (add it in the Files panel first)`)
        const depth = (includeDepth.get(name) ?? 0) + 1
        if (depth > 20) return err('include', `文件 "${name}" 被循环包含`, `File "${name}" includes itself`)
        includeDepth.set(name, depth)
        queue.unshift(...readFile(name, text))
        return
      }
      case '.macro': {
        const parts = argText.split(/[\s,]+/).filter(Boolean)
        const name = parts.shift()?.toLowerCase()
        if (!name) return err('bad-directive', '.macro 后面要写宏的名字', '.macro needs a name')
        const params = parts.map((p) => {
          const [nm, dflt = ''] = p.split('=')
          const [pn, qual] = nm!.split(':')
          return { name: pn!, dflt, required: qual === 'req', vararg: qual === 'vararg' }
        })
        const body = collectBlock(/^\.macro$/, /^\.endm$/, stmt)
        if (body) macros.set(name, { name, params, body })
        return
      }
      case '.purgem':
        macros.delete(argText.toLowerCase())
        return
      case '.endm':
      case '.endr':
        return err('bad-directive', `${d} 没有对应的开头`, `${d} without a matching start`)
      case '.exitm':
        return
      case '.rept': {
        const n = one('.rept')
        const body = collectBlock(/^\.(rept|irp|irpc)$/, /^\.endr$/, stmt)
        if (n === null || !body) return
        if (n < 0n || n > 100000n) return err('bad-directive', '.rept 的次数不合理', '.rept count is out of range')
        const out: Stmt[] = []
        for (let k = 0n; k < n; k++) out.push(...substitute(body, new Map(), stmt))
        queue.unshift(...out)
        return
      }
      case '.irp':
      case '.irpc': {
        const parts = splitArgs(argText)
        const sym = parts.shift()?.trim() ?? ''
        const body = collectBlock(/^\.(rept|irp|irpc)$/, /^\.endr$/, stmt)
        if (!body || !sym) return
        const items = d === '.irp' ? (parts.length === 1 && /\s/.test(parts[0]!) ? parts[0]!.split(/\s+/) : parts) : [...(parts.join(',') ?? '')]
        const out: Stmt[] = []
        for (const v of items) out.push(...substitute(body, new Map([[sym, v]]), stmt))
        queue.unshift(...out)
        return
      }
      case '.err':
      case '.error':
        return err('user-error', args[0]?.kind === 'str' ? new TextDecoder().decode(new Uint8Array(args[0].bytes!)) : '.error', args[0]?.kind === 'str' ? new TextDecoder().decode(new Uint8Array(args[0].bytes!)) : '.error')
      case '.warning':
        diags.warn(stmt, head.col, 'user-warning', args[0]?.kind === 'str' ? new TextDecoder().decode(new Uint8Array(args[0].bytes!)) : '.warning')
        return
      case '.print':
        return
      case '.end':
        ended = true
        return
    }
    err('unknown-directive', `不认识的伪操作 "${head.text}"`, `Unknown directive "${head.text}"`)
  }

  function instruction(stmt: Stmt, head: Tok, args: Tok[]) {
    if (!isCodeSection(cur.id)) {
      diags.error(stmt, head.col, 'instruction-in-data', L(`指令要写在代码段（.text）里，这里是 ${cur.id === 'discard' ? '被丢弃的段' : SECTIONS[cur.id].title}`, `Instructions belong in a code section (.text), not ${cur.id === 'discard' ? 'a discarded section' : SECTIONS[cur.id].title}`), head.text.length)
      return
    }
    if (!isMnemonic(head.text)) {
      diags.error(stmt, head.col, 'unknown-mnemonic', L(`"${head.text}" 不是可识别的指令`, `"${head.text}" is not a recognized instruction`), head.text.length)
      return
    }
    if (cur.offset % 4) align(stmt, head.col, 4, 0, null)
    if (!reserve(cur, cur.offset + 4, stmt, head.col)) return
    let pool: PoolEntry | null = null
    let movz: InstrRecord['movz'] = null
    const eq = args.findIndex((t) => t.kind === 'punct' && t.text === '=')
    if (eq >= 0 && /^ldr$/i.test(head.text) && eq === 2 && args[1]?.text === ',' && args[0]?.kind === 'ident') {
      const size = /^x|^lr$|^fp$/i.test(args[0].text) ? 8 : 4
      const toks = args.slice(3)
      // As in LLVM: a value known right here (no address in it) that one MOVZ can make becomes that MOVZ;
      // anything else goes in the literal pool.
      const known = constantNow(toks)
      if (known !== null) {
        const mask = size === 8 ? 0xffffffffffffffffn : 0xffffffffn
        const u = known & mask
        for (let sh = 0n; sh < BigInt(size * 8) && !movz; sh += 16n) if ((u & ~(0xffffn << sh) & mask) === 0n) movz = { value: u >> sh, shift: sh }
      }
      if (!movz) {
        pool = { toks, size, offset: -1, stmt, value: known }
        cur.pool.push(pool)
      }
    }
    instructions.push({ stmt, section: cur.id, offset: cur.offset, mnemonic: head.text, mcol: head.col, toks: args, pool, movz })
    cur.offset += 4
  }

  /** The value of an expression with no address in it, if every symbol it uses is known here. */
  function constantNow(toks: Tok[]): bigint | null {
    if (toks.some((k) => k.kind === 'ident' && (k.text === '.' || labels.has(k.text) || deferred.has(k.text) || k.text.startsWith('\u0001')))) return null
    try {
      const r = parseExpr(toks, 0, { symbol, dot: 0n })
      return r.end === toks.length ? r.value : null
    } catch {
      return null
    }
  }

  for (const s of sections.values()) flushPool(s)

  /* -------------------------------------------------------------- layout */

  // Each section starts on the page after the previous one (.text, .rodata, .data, .bss; .ktext, .kdata).
  const provisional = { ...bases }
  const sizeOf = (id: SectionId) => sections.get(id)?.offset ?? 0
  bases.rodata = pageUp(bases.text + sizeOf('text'))
  bases.data = pageUp(bases.rodata + sizeOf('rodata'))
  bases.bss = pageUp(bases.data + sizeOf('data'))
  bases.kdata = pageUp(bases.ktext + sizeOf('ktext'))
  if (bases.bss + sizeOf('bss') > USER_LIMIT) diags.error({ file: main.name, line: 1 }, 0, 'section-full', L('程序的代码和数据太大了（最多到 0x10000000）', 'The program\'s code and data are too large (they must end below 0x10000000)'))
  if (bases.kdata + sizeOf('kdata') > KERNEL_LIMIT) diags.error({ file: main.name, line: 1 }, 0, 'section-full', L('内核的代码和数据太大了（最多 16 MB）', 'The kernel code and data are too large (16 MB at most)'))
  for (const [name, sec] of labelSection) labels.set(name, labels.get(name)! - provisional[sec] + bases[sec])
  declarations.forEach((d, k) => (d.addr = bases[declarationAt[k]!.section] + declarationAt[k]!.offset))

  /* -------------------------------------------------------------- pass 2 */

  const programInstructions: ProgramInstruction[] = []
  const pool = (e: PoolEntry, sec: SectionId) => baseOf(sec) + e.offset

  // Pass 2 runs even after errors, so one assembly reports every line that is wrong.
  {
    for (const r of instructions) {
      const s = sections.get(r.section)!
      const pc = baseOf(r.section) + r.offset
      const ctx = { pc, symbol: finalSymbol }
      let word: number | null = null
      if (r.inst) {
        try {
          const v = parseExpr(r.toks, 0, { symbol: finalSymbol, dot: vaOf(pc) })
          word = Number(BigInt.asUintN(32, v.value))
        } catch (e) {
          if (!(e instanceof ExprError)) throw e
          diags.error(r.stmt, e.col, e.undefinedSymbol ? 'undefined-symbol' : 'bad-expression', e.message, e.length)
          continue
        }
      } else if (r.pool || r.movz) {
        word = encodePool(r, s, pc)
      } else {
        try {
          word = encodeInstr(r.mnemonic, r.toks, ctx).word
        } catch (e) {
          if (!(e instanceof Mismatch)) throw e
          report(r, e)
          continue
        }
      }
      if (word === null) continue
      writeBytes(s, r.offset, [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24])
      programInstructions.push({
        addr: pc,
        word: word >>> 0,
        basic: disassemble(word, { pc, name: nameOf }) ?? `.inst 0x${(word >>> 0).toString(16).padStart(8, '0')}`,
        file: r.stmt.file,
        line: r.stmt.line,
        source: r.stmt.source,
        part: 0,
        parts: 1,
      })
    }
    for (const d of datas) {
      const s = sections.get(d.section)!
      if (d.float) {
        const v = floatValue(d.toks)!
        const b = new Uint8Array(d.size)
        const view = new DataView(b.buffer)
        if (d.size === 8) view.setFloat64(0, v, true)
        else view.setFloat32(0, v, true)
        writeBytes(s, d.offset, b)
        continue
      }
      let v: bigint
      try {
        const r = parseExpr(d.toks, 0, { symbol: finalSymbol, dot: vaOf(baseOf(d.section) + d.offset) })
        if (r.end < d.toks.length) {
          diags.error(d.stmt, d.toks[r.end]!.col, 'bad-expression', L(`多余的内容 "${d.toks[r.end]!.text}"`, `Unexpected "${d.toks[r.end]!.text}"`))
          continue
        }
        v = r.value
      } catch (e) {
        if (!(e instanceof ExprError)) throw e
        diags.error(d.stmt, e.col, e.undefinedSymbol ? 'undefined-symbol' : 'bad-expression', e.message, e.length)
        continue
      }
      const bits = BigInt(8 * d.size)
      if (d.size < 8 && (v >= 1n << bits || v < -(1n << (bits - 1n))))
        diags.warn(d.stmt, d.toks[0]!.col, 'truncated', L(`值 ${v} 超出 ${d.size} 字节，只保留低位`, `Value ${v} does not fit in ${d.size} bytes; only the low bits are kept`))
      const u = BigInt.asUintN(Number(bits), v)
      const bytes: number[] = []
      for (let k = 0; k < d.size; k++) bytes.push(Number((u >> BigInt(8 * k)) & 0xffn))
      writeBytes(s, d.offset, bytes)
    }
    for (const s of sections.values()) {
      for (const e of [...instructions.filter((r) => r.pool && r.section === s.id).map((r) => r.pool!)]) {
        if (e.value === null) continue
        const bytes: number[] = []
        const u = BigInt.asUintN(8 * e.size, e.value)
        for (let k = 0; k < e.size; k++) bytes.push(Number((u >> BigInt(8 * k)) & 0xffn))
        writeBytes(s, e.offset, bytes)
      }
    }
  }

  function encodePool(r: InstrRecord, s: SectionState, pc: number): number | null {
    const reg = r.toks[0]!
    const comma: Tok = { kind: 'punct', text: ',', col: reg.col }
    const num = (v: bigint): Tok => ({ kind: 'num', text: String(v), col: reg.col, value: v })
    const encode = (mnemonic: string, toks: Tok[]): number | null => {
      try {
        return encodeInstr(mnemonic, toks, { pc, symbol: finalSymbol }).word
      } catch (err) {
        if (!(err instanceof Mismatch)) throw err
        report(r, err)
        return null
      }
    }
    if (r.movz) return encode('movz', [reg, comma, num(r.movz.value), comma, { kind: 'ident', text: 'lsl', col: reg.col }, num(r.movz.shift)])
    const e = r.pool!
    let v = e.value
    if (v === null) {
      try {
        const x = parseExpr(e.toks, 0, { symbol: finalSymbol, dot: vaOf(pc) })
        if (x.end < e.toks.length) {
          diags.error(r.stmt, e.toks[x.end]!.col, 'bad-expression', L(`多余的内容 "${e.toks[x.end]!.text}"`, `Unexpected "${e.toks[x.end]!.text}"`))
          return null
        }
        v = x.value
      } catch (err) {
        if (!(err instanceof ExprError)) throw err
        diags.error(r.stmt, err.col, err.undefinedSymbol ? 'undefined-symbol' : 'bad-expression', err.message, err.length)
        return null
      }
      e.value = v
    }
    if (e.size === 4 && (v >= 1n << 32n || v < -(1n << 31n))) diags.warn(r.stmt, e.toks[0]?.col ?? r.mcol, 'truncated', L(`值超出 32 位，只保留低 32 位`, `The value does not fit in 32 bits; only the low 32 bits are kept`))
    return encode('ldr', [reg, comma, { kind: 'num', text: '', col: reg.col, value: vaOf(pool(e, s.id)) }])
  }

  function report(r: InstrRecord, e: Mismatch) {
    const t = e.pos >= 0 ? r.toks[e.pos] : undefined
    const col = e.col ?? (e.pos < 0 ? r.mcol : (t?.col ?? (r.toks.length ? r.toks[r.toks.length - 1]!.col + r.toks[r.toks.length - 1]!.text.length : r.mcol + r.mnemonic.length)))
    const length = e.length ?? (e.pos < 0 ? r.mnemonic.length : (t?.text.length ?? 1))
    diags.error(r.stmt, col, e.code, e.message, length)
  }

  function nameOf(va: bigint): string | null {
    const a = addrOf(va)
    if (a === null) return null
    for (const [name, at] of labels) if (at === a && !name.startsWith('\u0001')) return name
    for (const name of LIBC_FUNCTIONS) if (stubAddress(name) === a && usedLibc.has(name)) return name
    return null
  }

  // Consecutive instructions from one source line (a macro, or statements joined by ';') step together.
  programInstructions.sort((a, b) => a.addr - b.addr)
  for (let k = 0; k < programInstructions.length; ) {
    let n = 1
    const p = programInstructions[k]!
    while (k + n < programInstructions.length) {
      const q = programInstructions[k + n]!
      if (q.file !== p.file || q.line !== p.line || q.addr !== p.addr + 4 * n) break
      n++
    }
    for (let j = 0; j < n; j++) {
      programInstructions[k + j]!.part = j
      programInstructions[k + j]!.parts = n
    }
    k += n
  }

  const ok = diags.errors === 0
  diags.list.sort((a, b) => (a.file === b.file ? a.line - b.line || a.col - b.col : 0))
  if (!ok) return { ok, diagnostics: diags.list, program: null }

  const symbols: Record<string, number> = {}
  for (const [name, a] of labels) if (!name.startsWith('\u0001')) symbols[name] = a
  for (const name of usedLibc) symbols[name] = stubAddress(name)
  const image: Program['image'] = []
  for (const s of sections.values()) {
    if (s.id === 'bss' || s.id === 'discard' || s.size === 0) continue
    image.push({ addr: baseOf(s.id), bytes: s.bytes.slice(0, s.size) })
  }
  const entry = labels.get('_start') ?? labels.get('main') ?? textBase
  const program: Program = {
    isa: 'arm64',
    instructions: programInstructions,
    declarations,
    symbols,
    image,
    entry,
    sections: ORDER.filter((id) => sizeOf(id) > 0).map((id) => ({ name: SECTIONS[id].title, addr: bases[id], size: sizeOf(id) })),
  }
  return { ok, diagnostics: diags.list, program }
}

/** Every mnemonic and directive the editor highlights and completes. */
export { isMnemonic }
