/**
 * GNU as (AArch64) assembler, following LLVM's integrated assembler where the two differ.
 *
 * One pass walks the statements in order: it expands .include, macros, .rept/.irp and .if, keeps the
 * location counter of every section, defines labels and .equ symbols, sizes data and reserves literal-pool
 * entries (every instruction is 4 bytes, so nothing waits for later). A second pass evaluates operands with
 * every symbol known, encodes the instructions and writes the data.
 *
 * Symbols set with .set, .equ or `=` may be set again. As in LLVM, a use sees the definition in force at
 * that point (or, used before any definition, the first one that follows); each statement records its
 * place in the walk so pass 2 can tell.
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
import { ExprError, parseExpr, type ExprContext, type Rel } from './expr'
import { splitStatements, tokenize, type Tok } from './lexer'
import { loadTables } from './instructions/index'
import { disassemble, encodeInstr, isMnemonic } from './encoding/table'
import { Mismatch } from './encoding/syntax'
import { LIBC_FUNCTIONS, stubAddress } from './libc'
import { HEAP_BASE, KSTACK_TOP, KTEXT_BASE, pageUp } from './linux'
import { parseFloatBits } from './fpformat'
import { F32, F64, type Fmt } from './softfloat'

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
/** Macros may nest this deep (LLVM's limit), and expansions may produce this many statements in all. */
const MAX_NESTING = 20
const MAX_EXPANDED = 2_000_000

/* ------------------------------------------------------------------ directives */

const DATA_SIZES: Record<string, { size: number; kind: DataKind }> = {
  '.byte': { size: 1, kind: 'byte' },
  '.hword': { size: 2, kind: 'half' },
  '.short': { size: 2, kind: 'half' },
  '.value': { size: 2, kind: 'half' },
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

const CONDITIONALS = new Set([
  '.if', '.ifdef', '.ifndef', '.ifnotdef', '.ifeq', '.ifne', '.ifgt', '.ifge', '.iflt', '.ifle', '.ifc', '.ifnc', '.ifeqs', '.ifnes',
  '.ifb', '.ifnb', '.else', '.elseif', '.endif',
])

export const DIRECTIVES = [
  ...Object.keys(DATA_SIZES),
  '.text', '.data', '.bss', '.rodata', '.section', '.pushsection', '.popsection', '.previous',
  '.ascii', '.asciz', '.string', '.float', '.single', '.double', '.octa', '.skip', '.space', '.zero', '.fill',
  '.align', '.p2align', '.balign', '.balignw', '.balignl', '.p2alignw', '.p2alignl', '.org', '.inst', '.ltorg', '.pool',
  '.equ', '.set', '.equiv', '.include', '.macro', '.endm', '.endmacro', '.exitm', '.purgem', '.rept', '.rep', '.irp', '.irpc', '.endr',
  ...CONDITIONALS,
  '.err', '.error', '.warning', '.print', '.end',
  ...IGNORED,
].sort()

/* ------------------------------------------------------------------ model */

/** A macro expansion or .rept/.irp/.irpc in progress: its statements end with a marker that points here. */
interface Instance {
  /** How many .if levels were open when it started (.exitm closes the ones it opened). */
  condDepth: number
}

interface Stmt {
  file: string
  line: number
  /** The source line shown for this statement (the macro call's line for a macro body). */
  source: string
  /** The statement text (comments blanked) and its first column. */
  text: string
  col: number
  /** Not a statement: the end of an instance's statements. */
  end?: Instance
}

interface SectionState {
  id: SectionId
  offset: number
  bytes: Uint8Array
  /** Bytes actually written (data), for the image. */
  size: number
  /** Literal-pool entries waiting for .ltorg or the end. */
  pool: PoolEntry[]
  /** Every entry this section has made, by value or symbol: later `ldr =` reuse them (as LLVM does, even past an .ltorg). */
  poolCache: Map<string, PoolEntry>
  /** Where the last instruction ended (to warn once about instructions off a 4-byte boundary). */
  instrEnd: number
}

interface PoolEntry {
  toks: Tok[]
  size: number
  /** Offset in the section, once placed. */
  offset: number
  stmt: Stmt
  value: bigint | null
  /** Where in the walk it was made (which symbol definitions it sees). */
  seq: number
}

interface InstrRecord {
  stmt: Stmt
  section: SectionId
  offset: number
  seq: number
  mnemonic: string
  /** Column of the mnemonic. */
  mcol: number
  toks: Tok[]
  /** For `ldr Rt, =value`: the pool entry, or the MOVZ it became. */
  pool: PoolEntry | null
  movz?: { value: bigint; shift: bigint } | null
  /** For .inst: the word. */
  inst?: number
}

interface DataRecord {
  stmt: Stmt
  section: SectionId
  offset: number
  seq: number
  size: number
  toks: Tok[]
  /** Literal bytes known in pass 1 (floats, .octa), little-endian. */
  bits?: bigint
  /**
   * Whether every symbol was already defined at the directive. LLVM checks the range of such values; a value
   * that waits for a later symbol is cut to size silently (we warn).
   */
  known?: boolean
}

/** A macro argument: the text it expands to (strings without their quotes), and its tokens. */
interface MacroArg {
  text: string
  toks: Tok[]
}

interface Macro {
  name: string
  params: { name: string; dflt: MacroArg | null; required: boolean; vararg: boolean }[]
  body: Stmt[]
  /** Expansions so far (`\+`). */
  count: number
}

/** One definition of a .set/.equ/= symbol: a constant, or an expression evaluated when used. */
interface VarDef {
  seq: number
  value: bigint | null
  toks: Tok[]
  section: SectionId
  offset: number
  stmt: Stmt
}

/** A symbol's value and what it is relative to. */
interface SymVal {
  value: bigint
  rel: Rel
}

const NO_REL: Rel = new Map()

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

const isPunct = (t: Tok | undefined, text: string) => !!t && t.kind === 'punct' && t.text === text

/**
 * The bits of a float literal in `fmt`, as LLVM reads .float and .double: an optional sign, then a decimal or
 * hex float, decimal digits (010 is ten), inf, infinity or nan (a quiet NaN with every payload bit set).
 */
function floatBits(toks: Tok[], fmt: Fmt): bigint | null {
  let i = 0
  let neg = false
  if (isPunct(toks[0], '-') || isPunct(toks[0], '+')) {
    neg = toks[0]!.text === '-'
    i++
  }
  const t = toks[i]
  if (!t || i !== toks.length - 1) return null
  const expAll = BigInt((1 << fmt.e) - 1) << BigInt(fmt.f)
  let bits: bigint | null
  if (t.kind === 'ident') {
    const w = t.text.toLowerCase()
    if (w === 'inf' || w === 'infinity') bits = expAll
    else if (w === 'nan') bits = expAll | ((1n << BigInt(fmt.f)) - 1n)
    else return null
  } else if (t.kind === 'float' || (t.kind === 'num' && /^\d+$/.test(t.text))) bits = parseFloatBits(t.text, fmt)
  else return null
  if (bits === null) return null
  return neg ? bits | (1n << BigInt(fmt.n - 1)) : bits
}

/** Whether a value fits `bytes` bytes as a signed or an unsigned number. */
const fits = (v: bigint, bytes: number) => bytes >= 8 || (v < 1n << BigInt(8 * bytes) && v >= -(1n << BigInt(8 * bytes - 1)))

/** Tokens that may join an argument across spaces in a macro call (`m 1 + 2` passes "1+2"). */
const MACRO_OPERATORS = new Set(['+', '-', '~', '/', '*', '==', '|', '||', '^', '&', '&&', '!', '!=', '<', '<=', '<<', '<>', '>', '>=', '>>'])
const isMacroOperator = (t: Tok) => (t.kind === 'punct' && MACRO_OPERATORS.has(t.text)) || (t.kind === 'ident' && t.text === '.')

/** Where a token starts in its statement's text. */
const at = (stmt: Stmt, t: Tok) => t.col - stmt.col

/**
 * One macro argument from toks[k], as LLVM splits them: it ends at a comma or, outside parentheses, at a space
 * that is not next to an operator. Strings lose their quotes; a vararg argument is the rest of the line as is.
 */
function macroArgument(toks: Tok[], k: number, stmt: Stmt, vararg: boolean): { arg: MacroArg; k: number; error?: { col: number; message: string } } {
  if (vararg) {
    if (k >= toks.length) return { arg: { text: '', toks: [] }, k }
    return { arg: { text: stmt.text.slice(at(stmt, toks[k]!)).trimEnd(), toks: toks.slice(k) }, k: toks.length }
  }
  const start = k
  let level = 0
  let text = ''
  let afterOperator = false
  const used: Tok[] = []
  while (k < toks.length) {
    const t = toks[k]!
    if (isPunct(t, '=')) return { arg: { text, toks: used }, k, error: { col: t.col, message: L('宏参数里不能有 =', 'Unexpected = in a macro argument') } }
    const prev = toks[k - 1]
    const space = k > start && !!prev && prev.col + prev.text.length < t.col
    if (level === 0) {
      if (isPunct(t, ',')) break
      if (isMacroOperator(t)) {
        text += t.text
        used.push(t)
        k++
        afterOperator = true
        continue
      }
      if (space && !afterOperator) break
    } else if (prev) text += stmt.text.slice(at(stmt, prev) + prev.text.length, at(stmt, t))
    afterOperator = false
    if (isPunct(t, '(')) level++
    else if (isPunct(t, ')') && level) level--
    text += t.kind === 'str' ? t.text.slice(1, -1) : t.text
    used.push(t)
    k++
  }
  if (level) return { arg: { text, toks: used }, k, error: { col: toks[start]?.col ?? stmt.col, message: L('宏参数里的括号不配对', 'Unbalanced parentheses in a macro argument') } }
  return { arg: { text, toks: used }, k }
}

/**
 * Substitute an instance's body text: `\param`, `\()` (nothing), `\@` (macro expansions so far, when
 * enabled) and `\+` (this macro's expansions so far). A backslash name that is not a parameter stays.
 */
function expandText(text: string, names: string[], values: string[], serial: number | null, count: number): string {
  if (!text.includes('\\')) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c !== '\\' || i + 1 === text.length) {
      out += c
      i++
      continue
    }
    const n = text[i + 1]!
    if (n === '@' && serial !== null) {
      out += serial
      i += 2
    } else if (n === '+') {
      out += count
      i += 2
    } else if (n === '(' && text[i + 2] === ')') i += 3
    else {
      let j = i + 1
      while (j < text.length && /[A-Za-z0-9_$.]/.test(text[j]!)) j++
      const name = text.slice(i + 1, j)
      const k = names.indexOf(name)
      out += k < 0 ? '\\' + name : values[k]!
      i = j
    }
  }
  return out
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
      s = { id, offset: 0, bytes: new Uint8Array(id === 'bss' || id === 'discard' ? 0 : 4096), size: 0, pool: [], poolCache: new Map(), instrEnd: -1 }
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

  /* ------------------------------------------------------------ symbols */

  /** Labels: internal addresses in a section, defined once. */
  const labels = new Map<string, number>()
  const labelSection = new Map<string, SectionId>()
  const labelSeq = new Map<string, number>()
  /** .set/.equ/= symbols: every definition, in order. */
  const vars = new Map<string, VarDef[]>()
  const definedAt = new Map<string, Stmt>()
  for (const [name, addr] of Object.entries(options.predefined ?? {})) {
    labels.set(name, addr)
    labelSeq.set(name, -1)
  }
  const localCounts = new Map<string, number>()
  /** The statement count of pass 1: a use at `seq` sees the definitions made before it. */
  let seq = 0
  const evaluating = new Set<VarDef>()
  let cycle = false
  /** While checking definitions at the end: symbols nobody defines count as outside symbols (an object file's). */
  let outside = false
  const usedLibc = new Set<string>()

  /** The definition of a variable in force at `when` (or the first one after it, for a use before any). */
  const varAt = (name: string, when: number): VarDef | undefined => {
    const defs = vars.get(name)
    if (!defs) return undefined
    let d: VarDef | undefined
    for (const x of defs) {
      if (x.seq > when) break
      d = x
    }
    return d ?? defs[0]
  }
  /**
   * Evaluation context for a statement at `when` placed at `dot` in `section`, tracking what values are
   * relative to; `libc` lets pass 2 resolve calls to the C library.
   */
  const contextAt = (when: number, dot: number, section: SectionId, libc = false): ExprContext => {
    let last: SymVal | undefined
    return {
      symbol: (name) => {
        last = lookup(name, when)
        if (!last && libc && LIBC_FUNCTIONS.includes(name)) {
          usedLibc.add(name)
          last = { value: vaOf(stubAddress(name)), rel: new Map([[`libc:${name}`, 1]]) }
        }
        if (!last && outside) last = { value: 0n, rel: new Map([[`?${name}`, 1]]) }
        return last?.value
      },
      relOf: () => last!.rel,
      dot: vaOf(dot),
      dotRel: section,
    }
  }
  /** A variable's value (an error inside its expression surfaces where it is used). */
  const varValue = (d: VarDef): SymVal | undefined => {
    if (d.value !== null) return { value: d.value, rel: NO_REL }
    if (evaluating.has(d)) {
      cycle = true
      return undefined
    }
    evaluating.add(d)
    try {
      const r = parseExpr(d.toks, 0, contextAt(d.seq - 0.5, baseOf(d.section) + d.offset, d.section))
      return { value: r.value, rel: r.rel }
    } catch (e) {
      if (e instanceof ExprError && e.undefinedSymbol) return undefined
      throw e
    } finally {
      evaluating.delete(d)
    }
  }
  /** A symbol's value as a statement at `when` sees it. */
  function lookup(name: string, when: number): SymVal | undefined {
    const l = labels.get(name)
    if (l !== undefined && (!vars.has(name) || labelSeq.get(name)! <= when)) {
      const sec = labelSection.get(name)
      return { value: vaOf(l), rel: sec ? new Map([[sec, 1]]) : NO_REL }
    }
    const d = varAt(name, when)
    return d ? varValue(d) : undefined
  }
  const symbol = (name: string) => lookup(name, seq)?.value
  /** Pass 2 (instruction operands) also knows the C library. */
  const finalSymbol =
    (when: number) =>
    (name: string): bigint | undefined => {
      const v = lookup(name, when)
      if (v !== undefined) return v.value
      if (LIBC_FUNCTIONS.includes(name)) {
        usedLibc.add(name)
        return vaOf(stubAddress(name))
      }
      return undefined
    }
  /** Whether a name is defined now (a variable only when its value can be worked out). */
  const isDefined = (name: string) => {
    if (labels.has(name)) return true
    try {
      return vars.has(name) && symbol(name) !== undefined
    } catch {
      return false
    }
  }
  /** Whether an expression is a constant now: no address in it, every symbol a constant defined before. */
  const isConstant = (toks: Tok[], when: number): boolean =>
    toks.every((k) => {
      if (k.kind !== 'ident') return true
      if (k.text === '.' || k.text.startsWith('\u0001')) return false
      if (labels.has(k.text) && (!vars.has(k.text) || labelSeq.get(k.text)! <= when)) return false
      const d = vars.get(k.text)?.filter((x) => x.seq <= when).pop()
      return !vars.has(k.text) || (d !== undefined && d.value !== null)
    })

  const here = () => baseOf(cur.id) + cur.offset

  const exprError = (stmt: Stmt, e: ExprError, what: string) =>
    diags.error(stmt, e.col, e.undefinedSymbol ? 'undefined-symbol' : 'bad-expression', e.undefinedSymbol ? L(`${what}：符号 "${e.undefinedSymbol}" 在这里还没有定义（这个值要在汇编时就确定）`, `${what}: symbol "${e.undefinedSymbol}" is not defined yet (the value must be known here)`) : `${what}: ${e.message}`, e.length)

  /**
   * Evaluate an expression now, with what it is relative to. `absolute` refuses values that depend on where a
   * section is placed (a label's address, rather than a difference of two labels in one section), as LLVM
   * does for counts and conditions.
   */
  const evalRel = (toks: Tok[], stmt: Stmt, what: string, absolute: boolean, col: number): { value: bigint; rel: Rel } | null => {
    if (!toks.length) {
      diags.error(stmt, col, 'bad-expression', L(`${what}：这里缺少表达式`, `${what}: expected an expression`))
      return null
    }
    try {
      const r = parseExpr(toks, 0, contextAt(seq, here(), cur.id))
      if (r.end < toks.length) {
        diags.error(stmt, toks[r.end]!.col, 'bad-expression', L(`${what}：多余的内容 "${toks[r.end]!.text}"`, `${what}: unexpected "${toks[r.end]!.text}"`))
        return null
      }
      if (absolute && r.rel.size) {
        diags.error(stmt, toks[0]!.col, 'bad-expression', L(`${what}：这里要一个确定的数，不能依赖标签的地址（两个同段标签的差可以）`, `${what}: expected an absolute value, not one that depends on a label's address (a difference of two labels in one section is fine)`))
        return null
      }
      return r
    } catch (e) {
      if (e instanceof ExprError) {
        exprError(stmt, e, what)
        return null
      }
      throw e
    }
  }
  const evalNow = (toks: Tok[], stmt: Stmt, what: string, absolute = false, col = stmt.col): bigint | null => evalRel(toks, stmt, what, absolute, col)?.value ?? null

  /**
   * Whether a value in `section` is one a relocation could hold (LLVM's rule): a constant, a symbol plus a
   * constant, or that minus a label of the same section (a PC-relative value).
   */
  const relocatable = (rel: Rel, section: SectionId): boolean => {
    if (!rel.size) return true
    const plus = [...rel].filter(([, c]) => c === 1)
    const minus = [...rel].filter(([, c]) => c === -1)
    return plus.length === 1 && (minus.length === 0 || (minus.length === 1 && minus[0]![0] === section))
  }
  const notRelocatable = (stmt: Stmt, col: number) =>
    diags.error(stmt, col, 'bad-expression', L('这个值放不进程序：只能是常数、标签加减常数，或者再减去本段的一个标签', 'This value cannot be stored: write a constant, a label plus or minus a constant, or that minus a label of this section'))

  /* ------------------------------------------------------------ sections */

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

  /** .bss holds no bytes: only zeros may be written there. */
  const bssZero = (stmt: Stmt, col: number, nonzero: boolean): boolean => {
    if (cur.id !== 'bss' || !nonzero) return true
    diags.error(stmt, col, 'bss-data', L('.bss 段只能放 0（用 .skip 留空间，有初值的数据放 .data）', 'The .bss section holds only zeros (reserve space with .skip; data with values goes in .data)'))
    return false
  }

  const isCodeSection = (id: SectionId) => id === 'text' || id === 'ktext'

  const declarations: DataDeclaration[] = []
  const declarationAt: { section: SectionId; offset: number }[] = []
  let lastLabel: { name: string; addr: number } | null = null
  const declare = (stmt: Stmt, kind: DataKind, addr: number, size: number, count: number) => {
    if (isCodeSection(cur.id) || cur.id === 'discard') return
    const label = lastLabel && lastLabel.addr === addr ? lastLabel.name : null
    declarations.push({ label, kind, addr, size, count, file: stmt.file, line: stmt.line, segment: cur.id })
    declarationAt.push({ section: cur.id, offset: addr - baseOf(cur.id) })
  }

  /** Place a section's waiting literal-pool entries here, each aligned to its size (zero padding). */
  const flushPool = (s: SectionState) => {
    for (const e of s.pool) {
      const off = Math.ceil(s.offset / e.size) * e.size
      if (!reserve(s, off + e.size, e.stmt, e.stmt.col)) return
      e.offset = off
      s.offset = off + e.size
    }
    s.pool = []
  }

  /**
   * Pad to a multiple of `bytes`. In code, with no fill given, the padding is zeros up to a 4-byte boundary
   * and then NOPs. Otherwise it is copies of the `size`-byte fill value, after zeros for any bytes short of
   * a whole copy (.balignw and .balignl; LLVM's object file is inconsistent there, writing only the copies
   * while its labels count the whole padding).
   */
  const align = (stmt: Stmt, col: number, bytes: number, fill: bigint | null, max: number | null, size = 1) => {
    const pad = (bytes - (cur.offset % bytes)) % bytes
    if (pad === 0 || (max !== null && pad > max)) return
    if (!bssZero(stmt, col, !!fill) || !reserve(cur, cur.offset + pad, stmt, col)) return
    const end = cur.offset + pad
    if (fill === null && isCodeSection(cur.id)) {
      for (let o = cur.offset + (pad % 4); o + 4 <= end; o += 4) writeBytes(cur, o, [NOP & 0xff, (NOP >> 8) & 0xff, (NOP >> 16) & 0xff, NOP >>> 24])
    } else if (fill) {
      const u = BigInt.asUintN(8 * size, fill)
      for (let o = cur.offset + (pad % size); o < end; o += size) for (let b = 0; b < size; b++) writeBytes(cur, o + b, [Number((u >> BigInt(8 * b)) & 0xffn)])
    }
    cur.offset = end
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

  const instructions: InstrRecord[] = []
  const datas: DataRecord[] = []
  const macros = new Map<string, Macro>()
  /** Macro expansions so far (`\@`). */
  let macroSerial = 0
  let expanded = 0
  /** .if nesting: whether each level is active, whether a branch has been taken, and whether .else was seen. */
  const conds: { active: boolean; taken: boolean; parent: boolean; inElse: boolean }[] = []
  const active = () => conds.length === 0 || conds[conds.length - 1]!.active
  /** Macro expansions and .rept/.irp/.irpc in progress, innermost last. */
  const instances: Instance[] = []
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

  /** Statements still to read, the next one last. */
  const pending: Stmt[] = readFile(main.name, main.text).reverse()
  const pushFront = (list: Stmt[]) => {
    for (let k = list.length - 1; k >= 0; k--) pending.push(list[k]!)
  }
  const includeDepth = new Map<string, number>()

  /** Run an instance: its statements, then its end marker. */
  const instantiate = (body: Stmt[], at: Stmt) => {
    expanded += body.length
    const inst: Instance = { condDepth: conds.length }
    instances.push(inst)
    pushFront([...body, { ...at, text: '', end: inst }])
  }
  /** Leave the innermost instance: drop what is left of it. */
  const exitInstance = () => {
    const inst = instances[instances.length - 1]!
    for (;;) {
      const s = pending.pop()
      if (!s || s.end === inst) break
    }
    instances.pop()
  }

  /** The first word of a statement, as written (block ends are matched case-sensitively, as in LLVM). */
  const firstWord = (s: Stmt) => /^\s*([A-Za-z_.$][A-Za-z0-9_.$]*)(.*)$/.exec(s.text)
  /** Collect a block's body up to its end directive, with nesting. */
  const collectBlock = (opens: string[], closes: string[], start: Stmt, what: string): Stmt[] | null => {
    const body: Stmt[] = []
    let depth = 1
    while (pending.length) {
      const s = pending.pop()!
      if (s.end) {
        pending.push(s)
        break
      }
      const m = firstWord(s)
      const word = m?.[1] ?? ''
      if (opens.includes(word)) depth++
      else if (closes.includes(word) && --depth === 0) {
        if (m![2]!.trim()) {
          diags.error(s, s.col + s.text.indexOf(word) + word.length, 'bad-directive', L(`${word} 后面不能再写别的`, `Unexpected text after ${word}`))
          return null
        }
        return body
      }
      body.push(s)
    }
    diags.error(start, start.col, 'unterminated-block', L(`缺少结束的 ${what}`, `Missing the closing ${what}`))
    return null
  }

  while (pending.length && !ended) {
    const stmt = pending.pop()!
    if (stmt.end) {
      const k = instances.lastIndexOf(stmt.end)
      if (k >= 0) instances.length = k
      continue
    }
    seq++
    let toks = tokenize(stmt.text, stmt.col - 1)
    if (!toks.length) continue

    // Inside a false .if only the conditional directives count.
    if (!active()) {
      const d = toks[0]!.kind === 'ident' ? toks[0]!.text.toLowerCase() : ''
      if (CONDITIONALS.has(d)) handleConditional(stmt, toks[0]!, toks.slice(1), d)
      continue
    }
    const bad = toks.find((t) => t.kind === 'bad')
    if (bad) {
      diags.error(stmt, bad.col, 'bad-token', bad.error!, bad.text.length)
      continue
    }

    // Labels: name: (also numeric local labels 1:)
    let i = 0
    while (i + 1 < toks.length && (toks[i]!.kind === 'ident' || toks[i]!.kind === 'num') && isPunct(toks[i + 1], ':')) {
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
    const head = toks[0]!
    const d0 = head.kind === 'ident' ? head.text.toLowerCase() : ''
    if (CONDITIONALS.has(d0)) {
      handleConditional(stmt, head, toks.slice(1), d0)
      continue
    }
    if (head.kind !== 'ident') {
      diags.error(stmt, head.col, 'syntax', L(`这里应该是指令或伪操作，而不是 "${head.text}"`, `Expected an instruction or directive, not "${head.text}"`), head.text.length)
      continue
    }
    // name = value (before macros, as in LLVM: `m = 5` sets m even when m is a macro).
    if (isPunct(toks[1], '=') && !isMnemonic(head.text)) {
      const value = resolveLocals(toks.slice(2), stmt)
      if (value) defineVar(head.text, value, stmt, head, false)
      continue
    }
    // Macro calls, .macro, .irp and .irpc take their arguments as text (1f stays "1f").
    const macro = macros.get(head.text)
    if (macro) {
      expandMacro(macro, stmt, head, toks.slice(1))
      continue
    }
    if (d0 === '.macro') {
      defineMacro(stmt, head, toks.slice(1))
      continue
    }
    if (d0 === '.irp' || d0 === '.irpc') {
      repeat(stmt, d0, head, toks.slice(1))
      continue
    }
    const args = resolveLocals(toks.slice(1), stmt)
    if (!args) continue
    if (d0.startsWith('.')) directive(stmt, d0, head, args)
    else instruction(stmt, head, args)
  }

  /** Numeric local references (1b, 1f) as the names of the labels they mean; null after an error. */
  function resolveLocals(toks: Tok[], stmt: Stmt): Tok[] | null {
    if (!toks.some((t) => t.kind === 'local')) return toks
    const out = toks.slice()
    for (const [k, t] of toks.entries()) {
      if (t.kind !== 'local') continue
      const key = String(t.value)
      const n = localCounts.get(key) ?? 0
      if (t.dir === 'b' && n === 0) {
        diags.error(stmt, t.col, 'undefined-symbol', L(`前面没有局部标签 ${key}:`, `No local label ${key}: before this`), t.text.length)
        return null
      }
      out[k] = { kind: 'ident', text: `\u0001L${key}_${t.dir === 'b' ? n : n + 1}`, col: t.col }
    }
    return out
  }

  if (conds.length) diags.error({ file: main.name, line: 1 }, 0, 'unterminated-if', L('有 .if 缺少对应的 .endif', 'An .if is missing its .endif'))
  // A symbol's final definition that refers to itself (directly or through others) can never be worked
  // out; nor can one that subtracts or computes with a symbol nobody defines (LLVM reports both even when
  // the symbol is never used, since it goes into the object file's symbol table).
  for (const defs of vars.values()) {
    const d = defs[defs.length - 1]!
    if (d.value !== null) continue
    cycle = false
    outside = true
    let message: string | null = null
    try {
      varValue(d)
    } catch (e) {
      if (!(e instanceof ExprError)) throw e
      message = e.message
    } finally {
      outside = false
    }
    if (cycle) diags.error(d.stmt, d.stmt.col, 'cyclic-symbol', L('符号的定义绕回到了它自己', 'This symbol is defined in terms of itself'))
    else if (message !== null) diags.error(d.stmt, d.stmt.col, 'bad-expression', message)
  }

  function defineLabel(name: string, stmt: Stmt, t: Tok) {
    if (labels.has(name)) {
      const first = definedAt.get(name)
      diags.error(stmt, t.col, 'duplicate-label', L(`标签 "${name}" 重复定义${first ? `（第一次在第 ${first.line} 行）` : ''}`, `Label "${name}" is already defined${first ? ` (first on line ${first.line})` : ''}`), t.text.length)
      return
    }
    if (isMnemonic(name) && !name.startsWith('\u0001')) diags.warn(stmt, t.col, 'label-is-mnemonic', L(`标签 "${name}" 和指令同名，容易看错`, `Label "${name}" has the name of an instruction`), t.text.length)
    labels.set(name, here())
    labelSection.set(name, cur.id)
    labelSeq.set(name, seq)
    definedAt.set(name, stmt)
    if (!name.startsWith('\u0001')) lastLabel = { name, addr: here() }
  }

  /** .set, .equ, .equiv and `=`: a new definition of the name from here on. */
  function defineVar(name: string, toks: Tok[], stmt: Stmt, t: Tok, once: boolean) {
    if (labels.has(name) || (once && vars.has(name))) {
      diags.error(stmt, t.col, 'duplicate-label', L(`符号 "${name}" 已经定义过了`, `Symbol "${name}" is already defined`), t.text.length)
      return
    }
    if (!toks.length) {
      diags.error(stmt, t.col, 'bad-directive', L(`符号 "${name}" 缺少值`, `Symbol "${name}" needs a value`))
      return
    }
    const def: VarDef = { seq, value: null, toks, section: cur.id, offset: cur.offset, stmt }
    try {
      const r = parseExpr(toks, 0, { symbol: (n) => lookup(n, seq - 0.5)?.value, dot: vaOf(here()) })
      if (r.end < toks.length) {
        diags.error(stmt, toks[r.end]!.col, 'bad-expression', L(`多余的内容 "${toks[r.end]!.text}"`, `Unexpected "${toks[r.end]!.text}"`))
        return
      }
      // An address is final only after layout: keep the expression and evaluate it when used.
      if (isConstant(toks, seq - 0.5)) def.value = r.value
    } catch (e) {
      if (!(e instanceof ExprError)) throw e
      // Refers to something defined later (evaluated when used); anything else is an error now.
      if (!e.undefinedSymbol) {
        diags.error(stmt, e.col, 'bad-expression', e.message, e.length)
        return
      }
    }
    const defs = vars.get(name)
    if (defs) defs.push(def)
    else vars.set(name, [def])
    definedAt.set(name, stmt)
  }

  function handleConditional(stmt: Stmt, head: Tok, args: Tok[], dir: string) {
    const parent = active()
    const top = conds[conds.length - 1]
    const err = (code: string, zh: string, en: string, t: Tok = head) => diags.error(stmt, t.col, code, L(zh, en), t.text.length)
    if (dir === '.endif') {
      if (!conds.pop()) err('bad-directive', '.endif 没有对应的 .if', '.endif without .if')
      return
    }
    if (dir === '.else' || dir === '.elseif') {
      if (!top || top.inElse) return err('bad-directive', `${dir} 前面要有 .if 或 .elseif`, `${dir} must follow an .if or .elseif`)
      if (dir === '.else') {
        top.active = top.parent && !top.taken
        top.taken = true
        top.inElse = true
      } else if (!top.parent || top.taken) top.active = false
      else {
        const toks = resolveLocals(args, stmt)
        top.active = !!toks && (evalNow(toks, stmt, '.elseif', true, head.col) ?? 0n) !== 0n
        top.taken = top.active
      }
      return
    }
    const push = (on: boolean) => conds.push({ active: on, taken: on || !parent, parent, inElse: false })
    if (!parent) return push(false)
    const rest = (k: number) => {
      if (args.length > k) {
        err('bad-directive', `${dir} 后面多了 "${args[k]!.text}"`, `${dir}: unexpected "${args[k]!.text}"`, args[k])
        return false
      }
      return true
    }
    const after = (t: Tok) => stmt.text.slice(at(stmt, t) + t.text.length)
    switch (dir) {
      case '.ifdef':
      case '.ifndef':
      case '.ifnotdef': {
        const t = args[0]
        if (!t || t.kind !== 'ident' || t.text === '.') {
          err('bad-directive', `${dir} 后面要写一个符号名`, `${dir} takes a symbol name`)
          return push(false)
        }
        if (!rest(1)) return push(false)
        return push(isDefined(t.text) === (dir === '.ifdef'))
      }
      case '.ifc':
      case '.ifnc': {
        // Raw text on either side of the first comma, trimmed (quotes and all).
        const comma = args.findIndex((t) => isPunct(t, ','))
        if (comma < 0) {
          err('bad-directive', `${dir} 的写法是：${dir} 文字1, 文字2`, `${dir} is written: ${dir} text1, text2`)
          return push(false)
        }
        const a = stmt.text.slice(at(stmt, head) + head.text.length, at(stmt, args[comma]!)).trim()
        const b = after(args[comma]!).trim()
        return push((a === b) === (dir === '.ifc'))
      }
      case '.ifeqs':
      case '.ifnes': {
        const [a, c, b] = args
        if (a?.kind !== 'str' || !isPunct(c, ',') || b?.kind !== 'str') {
          err('bad-directive', `${dir} 的写法是：${dir} "字符串1", "字符串2"`, `${dir} is written: ${dir} "string1", "string2"`)
          return push(false)
        }
        if (!rest(3)) return push(false)
        return push((a.text.slice(1, -1) === b.text.slice(1, -1)) === (dir === '.ifeqs'))
      }
      case '.ifb':
      case '.ifnb':
        return push((after(head).trim() === '') === (dir === '.ifb'))
    }
    const toks = resolveLocals(args, stmt)
    const v = toks && evalNow(toks, stmt, dir, true, head.col)
    if (v === null) return push(false)
    const on = dir === '.if' || dir === '.ifne' ? v !== 0n : dir === '.ifeq' ? v === 0n : dir === '.ifgt' ? v > 0n : dir === '.ifge' ? v >= 0n : dir === '.iflt' ? v < 0n : v <= 0n
    push(on)
  }

  /** Arguments of a macro call (or of .irp/.irpc when `m` is null), as LLVM reads them. */
  function macroArguments(m: Macro | null, toks: Tok[], stmt: Stmt): (MacroArg | null)[] | null {
    const params = m?.params ?? []
    const n = params.length
    const values: (MacroArg | null)[] = new Array(n).fill(null)
    const hasVararg = n > 0 && params[n - 1]!.vararg
    const fail = (t: Tok | undefined, zh: string, en: string) => {
      diags.error(stmt, t?.col ?? stmt.col, 'macro-args', L(zh, en))
      return null
    }
    let named = false
    let k = 0
    for (let p = 0; !n || p < n; p++) {
      let name: Tok | null = null
      if (toks[k]?.kind === 'ident' && isPunct(toks[k + 1], '=')) {
        name = toks[k]!
        k += 2
        named = true
      }
      if (named && !name) return fail(toks[k], '按名字给的参数后面不能再按位置给参数', 'Positional arguments cannot follow named ones')
      const r = macroArgument(toks, k, stmt, hasVararg && p === n - 1)
      if (r.error) return fail({ kind: 'punct', text: '', col: r.error.col }, r.error.message, r.error.message)
      k = r.k
      let index = p
      if (name) {
        index = params.findIndex((q) => q.name === name.text)
        if (index < 0) return fail(name, `宏 ${m?.name ?? ''} 没有叫 ${name.text} 的参数`, `Macro ${m?.name ?? ''} has no parameter named ${name.text}`)
      }
      if (r.arg.toks.length) {
        while (values.length <= index) values.push(null)
        values[index] = r.arg
      }
      if (k >= toks.length) {
        let ok = true
        params.forEach((q, j) => {
          if (values[j]) return
          if (q.required) {
            diags.error(stmt, stmt.col, 'macro-args', L(`宏 ${m!.name} 缺少参数 ${q.name}`, `Macro ${m!.name} needs argument ${q.name}`))
            ok = false
          }
          values[j] = q.dflt
        })
        return ok ? values : null
      }
      if (isPunct(toks[k], ',')) k++
    }
    return fail(toks[k], `宏 ${m!.name} 只有 ${n} 个参数，这里给多了`, `Macro ${m!.name} takes ${n} arguments; more are given here`)
  }

  function expandMacro(m: Macro, stmt: Stmt, head: Tok, args: Tok[]) {
    if (instances.length >= MAX_NESTING || expanded > MAX_EXPANDED) {
      diags.error(stmt, head.col, 'macro-depth', L(`宏最多嵌套 ${MAX_NESTING} 层（可能是无限递归）`, `Macros cannot nest more than ${MAX_NESTING} levels deep (endless recursion?)`))
      return
    }
    const values = macroArguments(m, args, stmt)
    if (!values) return
    if (!m.params.length && values.length) {
      diags.error(stmt, head.col, 'macro-args', L(`宏 ${m.name} 没有参数`, `Macro ${m.name} takes no arguments`))
      return
    }
    const names = m.params.map((p) => p.name)
    const texts = values.map((v) => v?.text ?? '')
    const body = m.body.map((s) => ({ file: stmt.file, line: stmt.line, source: stmt.source, text: expandText(s.text, names, texts, macroSerial, m.count), col: stmt.col }))
    m.count++
    macroSerial++
    instantiate(body, stmt)
  }

  /** .macro name[,] param[:req|:vararg][=default] … (the body follows, up to .endm). */
  function defineMacro(stmt: Stmt, head: Tok, args: Tok[]) {
    const fail = (t: Tok | undefined, zh: string, en: string) => diags.error(stmt, t?.col ?? head.col, 'bad-directive', L(zh, en))
    const nameTok = args[0]
    if (nameTok?.kind !== 'ident') return fail(nameTok ?? head, '.macro 后面要写宏的名字', '.macro needs a name')
    const name = nameTok.text
    let k = 1
    if (isPunct(args[k], ',')) k++
    const params: Macro['params'] = []
    while (k < args.length) {
      const last = params[params.length - 1]
      if (last?.vararg) return fail(args[k], `:vararg 参数 ${last.name} 必须是最后一个`, `The :vararg parameter ${last.name} must be the last one`)
      const p = args[k]!
      if (p.kind !== 'ident') return fail(p, `这里应该是参数名，而不是 "${p.text}"`, `Expected a parameter name, not "${p.text}"`)
      if (params.some((q) => q.name === p.text)) return fail(p, `宏 ${name} 有两个参数都叫 ${p.text}`, `Macro ${name} has two parameters named ${p.text}`)
      k++
      const param: Macro['params'][number] = { name: p.text, dflt: null, required: false, vararg: false }
      if (isPunct(args[k], ':')) {
        const q = args[++k]
        if (q?.text === 'req') param.required = true
        else if (q?.text === 'vararg') param.vararg = true
        else return fail(q, `参数 ${p.text} 的限定只能是 :req 或 :vararg`, `Parameter ${p.text} may only be :req or :vararg`)
        k++
      }
      if (isPunct(args[k], '=')) {
        const r = macroArgument(args, k + 1, stmt, false)
        if (r.error) return diags.error(stmt, r.error.col, 'bad-directive', r.error.message)
        if (r.arg.toks.length) param.dflt = r.arg
        k = r.k
      }
      params.push(param)
      if (isPunct(args[k], ',')) k++
    }
    const body = collectBlock(['.macro'], ['.endm', '.endmacro'], stmt, '.endm')
    if (!body) return
    if (macros.has(name)) return fail(nameTok, `宏 ${name} 已经定义过了（先 .purgem）`, `Macro ${name} is already defined (.purgem it first)`)
    macros.set(name, { name, params, body, count: 0 })
  }

  /** .rept, .irp and .irpc: a body repeated, the latter two with a parameter. */
  function repeat(stmt: Stmt, d: string, head: Tok, args: Tok[]) {
    const fail = (t: Tok | undefined, zh: string, en: string) => diags.error(stmt, t?.col ?? head.col, 'bad-directive', L(zh, en))
    const collect = () => collectBlock(['.rep', '.rept', '.irp', '.irpc'], ['.endr'], stmt, '.endr')
    if (d === '.rept' || d === '.rep') {
      const n = evalNow(args, stmt, d, true, head.col)
      if (n === null) return
      if (n < 0n) return fail(args[0], `${d} 的次数不能是负数`, `${d} count is negative`)
      const body = collect()
      if (!body) return
      if (expanded + Number(n) * body.length > MAX_EXPANDED) return fail(head, `${d} 展开得太多了`, `${d} expands to too many statements`)
      const out: Stmt[] = []
      for (let k = 0; k < Number(n); k++) for (const s of body) out.push({ ...s, file: stmt.file, line: stmt.line, source: stmt.source, col: stmt.col, text: expandText(s.text, [], [], null, k) })
      return instantiate(out, stmt)
    }
    const param = args[0]
    if (param?.kind !== 'ident') return fail(param, `${d} 后面要写参数名`, `${d} needs a parameter name`)
    if (!isPunct(args[1], ',')) return fail(args[1], `${d} 的参数名后面要有逗号`, `${d} needs a comma after the parameter name`)
    const values = macroArguments(null, args.slice(2), stmt)
    if (!values) return
    let items: string[]
    if (d === '.irpc') {
      const only = values[0]
      if (values.length !== 1 || only?.toks.length !== 1) return fail(args[2] ?? head, '.irpc 后面要写一个词或一个字符串', '.irpc takes one word or string')
      const t = only.toks[0]!
      items = [...(t.kind === 'str' ? t.text.slice(1, -1) : t.text)]
    } else items = values.map((v) => v?.text ?? '')
    const body = collect()
    if (!body) return
    if (expanded + items.length * body.length > MAX_EXPANDED) return fail(head, `${d} 展开得太多了`, `${d} expands to too many statements`)
    const out: Stmt[] = []
    items.forEach((v, k) => {
      for (const s of body) out.push({ ...s, file: stmt.file, line: stmt.line, source: stmt.source, col: stmt.col, text: expandText(s.text, [param.text], [v], macroSerial, k) })
    })
    instantiate(out, stmt)
  }

  function directive(stmt: Stmt, d: string, head: Tok, args: Tok[]) {
    const argText = stmt.text.slice(head.col - stmt.col + head.text.length).trim()
    const err = (code: string, zh: string, en: string, t: Tok = head) => diags.error(stmt, t.col, code, L(zh, en), t.text.length)
    const exprList = (): Tok[][] => {
      const out: Tok[][] = []
      let part: Tok[] = []
      let depth = 0
      for (const t of args) {
        if (isPunct(t, '(')) depth++
        if (isPunct(t, ')')) depth--
        if (isPunct(t, ',') && depth === 0) {
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
    const message = () => (args[0]?.kind === 'str' ? args[0].text.slice(1, -1) : null)

    if (IGNORED.has(d)) return
    const data = DATA_SIZES[d]
    if (data) {
      const list = exprList()
      if (list.some((p) => !p.length)) return err('bad-directive', `${d} 后面要写一个或多个值，用逗号分隔`, `${d} takes one or more values separated by commas`)
      if (!list.length) return
      const addr = here()
      if (!reserve(cur, cur.offset + data.size * list.length, stmt, head.col)) return
      for (const p of list) {
        let known = true
        if (data.size < 8)
          try {
            parseExpr(p, 0, contextAt(seq, here(), cur.id))
          } catch (e) {
            if (!(e instanceof ExprError)) throw e
            known = !e.undefinedSymbol
          }
        datas.push({ stmt, section: cur.id, offset: cur.offset, seq, size: data.size, toks: p, known })
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
        // Strings separated by commas; .ascii also takes strings side by side ("a" "b").
        const addr = here()
        let total = 0
        let k = 0
        while (k < args.length) {
          const t = args[k]!
          if (t.kind !== 'str') return err('bad-directive', `${d} 只接受用双引号括起来的字符串`, `${d} takes double-quoted strings`, t)
          if (t.error) return err('bad-string', t.error, t.error, t)
          const bytes = [...t.bytes!, ...(d === '.ascii' ? [] : [0])]
          if (!bssZero(stmt, t.col, bytes.some((b) => b)) || !reserve(cur, cur.offset + bytes.length, stmt, head.col)) return
          writeBytes(cur, cur.offset, bytes)
          cur.offset += bytes.length
          total += bytes.length
          k++
          if (k < args.length && d === '.ascii' && args[k]!.kind === 'str') continue
          if (k < args.length && (!isPunct(args[k], ',') || k + 1 === args.length)) return err('bad-directive', `${d} 的字符串之间用逗号分隔`, `${d}: separate the strings with commas`, args[k])
          k++
        }
        if (total) declare(stmt, d === '.ascii' ? 'ascii' : 'asciiz', addr, total, total)
        return
      }
      case '.float':
      case '.single':
      case '.double': {
        const list = exprList()
        const size = d === '.double' ? 8 : 4
        const addr = here()
        if (list.some((p) => !p.length)) return err('bad-directive', `${d} 后面要写一个或多个数，用逗号分隔`, `${d} takes one or more numbers separated by commas`)
        if (!list.length) return
        if (!reserve(cur, cur.offset + size * list.length, stmt, head.col)) return
        for (const p of list) {
          const bits = floatBits(p, size === 8 ? F64 : F32)
          if (bits === null) return err('bad-directive', `${d} 只接受浮点数（如 1.5、-2e3、0x1.8p1、inf、nan）`, `${d} takes floating-point numbers (such as 1.5, -2e3, 0x1.8p1, inf or nan)`, p[0] ?? head)
          if (!bssZero(stmt, p[0]!.col, bits !== 0n)) return
          datas.push({ stmt, section: cur.id, offset: cur.offset, seq, size, toks: p, bits })
          cur.offset += size
        }
        declare(stmt, size === 8 ? 'double' : 'float', addr, size * list.length, list.length)
        return
      }
      case '.octa': {
        // One integer of up to 128 bits each (no expressions, as in LLVM).
        const list = exprList()
        const addr = here()
        if (list.some((p) => p.length !== 1 || p[0]!.kind !== 'num' || p[0]!.value! >= 1n << 128n))
          return err('bad-directive', '.octa 的每个值是一个不超过 128 位的整数', '.octa takes integers of at most 128 bits', list.find((p) => p.length !== 1 || p[0]!.kind !== 'num')?.[0] ?? head)
        if (!list.length || !reserve(cur, cur.offset + 16 * list.length, stmt, head.col)) return
        for (const p of list) {
          if (!bssZero(stmt, p[0]!.col, p[0]!.value !== 0n)) return
          datas.push({ stmt, section: cur.id, offset: cur.offset, seq, size: 16, toks: p, bits: p[0]!.value! })
          cur.offset += 16
        }
        declare(stmt, 'dword', addr, 16 * list.length, 2 * list.length)
        return
      }
      case '.skip':
      case '.space':
      case '.zero': {
        const list = exprList()
        const n = list[0] ? evalNow(list[0], stmt, d, true, head.col) : one(d)
        if (n === null) return
        if (n < 0n || n > 0x10000000n) return err('bad-directive', `${d} 的大小 ${n} 不合理`, `${d} size ${n} is out of range`)
        const fill = list[1] ? evalNow(list[1], stmt, d, true, head.col) : 0n
        if (fill === null) return
        const addr = here()
        if (!bssZero(stmt, head.col, n > 0n && (fill & 0xffn) !== 0n) || !reserve(cur, cur.offset + Number(n), stmt, head.col)) return
        if (fill & 0xffn) writeBytes(cur, cur.offset, new Uint8Array(Number(n)).fill(Number(fill & 0xffn)))
        cur.offset += Number(n)
        if (n > 0n) declare(stmt, 'space', addr, Number(n), Number(n))
        return
      }
      case '.fill': {
        // .fill repeat[, size[, value]]: as in LLVM, a negative repeat or size does nothing, a size above 8
        // counts as 8, and each copy is the value's low 4 bytes followed by zeros.
        const list = exprList()
        const rep = list[0] ? evalNow(list[0], stmt, d, true, head.col) : one(d)
        const size = list[1] ? evalNow(list[1], stmt, d, true, head.col) : 1n
        const value = list[2] ? evalNow(list[2], stmt, d, true, head.col) : 0n
        if (rep === null || size === null || value === null) return
        if (rep < 0n || size < 0n) {
          diags.warn(stmt, head.col, 'fill-ignored', L('.fill 的次数或大小是负数，什么也不放', '.fill with a negative repeat count or size does nothing'))
          return
        }
        if (rep > 0x10000000n) return err('bad-directive', '.fill 的次数不合理', '.fill repeat count is out of range')
        const sz = Number(size > 8n ? 8n : size)
        const addr = here()
        const bytes: number[] = []
        for (let b = 0; b < sz; b++) bytes.push(b < 4 ? Number((value >> BigInt(8 * b)) & 0xffn) : 0)
        if (!bssZero(stmt, head.col, rep > 0n && bytes.some((b) => b)) || !reserve(cur, cur.offset + Number(rep) * sz, stmt, head.col)) return
        for (let k = 0; k < Number(rep); k++) {
          writeBytes(cur, cur.offset, bytes)
          cur.offset += sz
        }
        if (rep > 0n && sz > 0) declare(stmt, sz === 8 ? 'dword' : sz === 4 ? 'word' : sz === 2 ? 'half' : 'byte', addr, Number(rep) * sz, Number(rep))
        return
      }
      case '.align':
      case '.p2align':
      case '.p2alignw':
      case '.p2alignl':
      case '.balign':
      case '.balignw':
      case '.balignl': {
        // On AArch64 .align is a power of two, like .p2align; the w and l forms fill with 2- and 4-byte values.
        const list = exprList()
        const n = list[0]?.length ? evalNow(list[0], stmt, d, true, head.col) : one(d)
        if (n === null) return
        const size = d.endsWith('w') ? 2 : d.endsWith('l') ? 4 : 1
        let bytes: number
        if (d.startsWith('.b')) {
          if (n < 0n || (n & (n - 1n)) !== 0n || n > 1n << 32n) return err('bad-directive', `${d} 要写 2 的幂（字节数）`, `${d} takes a power of two (bytes)`)
          bytes = Math.max(1, Number(n))
        } else {
          if (n < 0n || n > 31n) return err('bad-directive', `${d} 要写 0 到 31 之间的指数`, `${d} takes an exponent from 0 to 31`)
          bytes = 2 ** Number(n)
        }
        // The fill may be left out only before a maximum (.p2align 3,,4).
        if (list.length > 3 || (list.length === 2 && !list[1]!.length) || (list.length === 3 && !list[2]!.length))
          return err('bad-directive', `${d} 的写法是：${d} 对齐[, 填充值[, 最多跳过的字节数]]`, `${d} is written: ${d} alignment[, fill[, maximum bytes to skip]]`)
        const fill = list[1]?.length ? evalNow(list[1], stmt, d, true, head.col) : null
        if (list[1]?.length && fill === null) return
        let max = list[2]?.length ? evalNow(list[2], stmt, d, true, head.col) : null
        if (list[2]?.length && max === null) return
        if (max !== null && max < 1n) return err('bad-directive', `${d} 的最多跳过字节数要至少是 1`, `${d}: the maximum number of bytes to skip must be at least 1`)
        if (max !== null && max >= BigInt(bytes)) max = null
        align(stmt, head.col, bytes, fill, max === null ? null : Number(max), size)
        return
      }
      case '.org': {
        // .org offset[, fill]: an offset in this section, or an expression with a label of this section.
        const list = exprList()
        if (!list[0]?.length) return err('bad-directive', '.org 缺少参数', '.org needs an argument')
        const r = evalRel(list[0], stmt, '.org', false, head.col)
        if (r === null) return
        const fill = list[1] ? evalNow(list[1], stmt, '.org', true, head.col) : 0n
        if (fill === null) return
        let target: number
        if (!r.rel.size) target = Number(r.value)
        else if (r.rel.size === 1 && r.rel.get(cur.id) === 1) target = Number(BigInt(addrOf(BigInt.asUintN(64, r.value)) ?? -1) - BigInt(baseOf(cur.id)))
        else return err('bad-directive', '.org 要写这一段里的偏移，或者这一段里的标签加减偏移', '.org takes an offset in this section, or a label of this section plus or minus an offset')
        if (target < cur.offset) return err('bad-directive', '.org 不能往回移动', '.org cannot move backwards')
        if (!bssZero(stmt, head.col, target > cur.offset && (fill & 0xffn) !== 0n) || !reserve(cur, target, stmt, head.col)) return
        if (fill & 0xffn) writeBytes(cur, cur.offset, new Uint8Array(target - cur.offset).fill(Number(fill & 0xffn)))
        cur.offset = target
        return
      }
      case '.inst': {
        if (!isCodeSection(cur.id)) return err('instruction-in-data', '.inst 只能写在代码段（.text）里', '.inst belongs in a code section (.text)')
        // Constants only (LLVM's rule): no labels, no `.`, nothing defined later.
        for (const p of exprList()) {
          if (!p.length || !isConstant(p, seq)) return err('bad-expression', '.inst 要写一个常数（不能用标签或后面才定义的符号）', '.inst takes a constant (no labels or symbols defined later)', p[0] ?? head)
          const v = evalNow(p, stmt, '.inst')
          if (v === null) return
          if (!reserve(cur, cur.offset + 4, stmt, head.col)) return
          misaligned(stmt, head)
          instructions.push({ stmt, section: cur.id, offset: cur.offset, seq, mnemonic: '.inst', mcol: head.col, toks: p, pool: null, inst: Number(BigInt.asUintN(32, v)) })
          cur.offset += 4
          cur.instrEnd = cur.offset
        }
        return
      }
      case '.ltorg':
      case '.pool':
        return flushPool(cur)
      case '.equ':
      case '.set':
      case '.equiv': {
        const name = args[0]
        if (!name || name.kind !== 'ident' || !isPunct(args[1], ',')) return err('bad-directive', `${d} 的写法是：${d} 名字, 值`, `${d} is written: ${d} name, value`)
        return defineVar(name.text, args.slice(2), stmt, name, d === '.equiv')
      }
      case '.include': {
        const name = args[0]?.kind === 'str' ? new TextDecoder().decode(new Uint8Array(args[0].bytes!)) : argText
        const text = files.get(name)
        if (text === undefined) return err('include', `找不到要包含的文件 "${name}"（先在“文件”面板里添加）`, `Cannot find the included file "${name}" (add it in the Files panel first)`)
        const depth = (includeDepth.get(name) ?? 0) + 1
        if (depth > 20) return err('include', `文件 "${name}" 被循环包含`, `File "${name}" includes itself`)
        includeDepth.set(name, depth)
        pushFront(readFile(name, text))
        return
      }
      case '.purgem': {
        const name = args[0]?.text ?? ''
        if (!macros.delete(name)) return err('bad-directive', `没有叫 ${name} 的宏`, `There is no macro named ${name}`, args[0] ?? head)
        return
      }
      case '.exitm':
      case '.endm':
      case '.endmacro':
      case '.endr':
        // Inside a macro or repetition these end it early (.exitm also closes the .if levels it opened).
        if (!instances.length) return err('bad-directive', `${d} 不在宏或重复块里`, `${d} outside a macro or repetition`)
        if (d === '.exitm') conds.length = Math.min(conds.length, instances[instances.length - 1]!.condDepth)
        return exitInstance()
      case '.rept':
      case '.rep':
        return repeat(stmt, d, head, args)
      case '.err':
        return err('user-error', '遇到了 .err', '.err encountered')
      case '.error': {
        const m = message()
        return err('user-error', m ?? '遇到了 .error', m ?? '.error encountered')
      }
      case '.warning': {
        const m = message()
        diags.warn(stmt, head.col, 'user-warning', m ?? L('遇到了 .warning', '.warning encountered'))
        return
      }
      case '.print':
        if (message() === null) return err('bad-directive', '.print 后面要写一个字符串', '.print needs a string')
        return
      case '.end':
        if (args.length) return err('bad-directive', '.end 后面不能再写别的', 'Unexpected text after .end', args[0])
        ended = true
        return
    }
    err('unknown-directive', `不认识的伪操作 "${head.text}"`, `Unknown directive "${head.text}"`)
  }

  /** Warn once when instructions start off a 4-byte boundary (LLVM puts them there all the same). */
  function misaligned(stmt: Stmt, head: Tok) {
    if (cur.offset % 4 && cur.instrEnd !== cur.offset)
      diags.warn(stmt, head.col, 'misaligned-instruction', L('这条指令没有按 4 字节对齐（前面的数据长度不是 4 的倍数）；执行到这里会出错，前面加 .balign 4', 'This instruction is not 4-byte aligned (the data before it is not a multiple of 4 bytes long); running it faults, so put .balign 4 before it'), head.text.length)
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
    if (!reserve(cur, cur.offset + 4, stmt, head.col)) return
    misaligned(stmt, head)
    let pool: PoolEntry | null = null
    let movz: InstrRecord['movz'] = null
    if (/^ldr$/i.test(head.text) && args[0]?.kind === 'ident' && isPunct(args[1], ',') && isPunct(args[2], '=')) {
      const size = /^(x([0-9]|[12][0-9]|30)|xzr|lr|fp|ip[01])$/i.test(args[0].text) ? 8 : 4
      const toks = args.slice(3)
      // As in LLVM: a constant known right here (no address in it) that one MOVZ can make becomes that MOVZ
      // (judged on its 64-bit value); anything else goes in the literal pool, one entry per value or symbol.
      const known = isConstant(toks, seq) ? constantNow(toks) : null
      if (known !== null) {
        let u = BigInt.asUintN(64, known)
        if (size === 4 && !fits(known, 4) && !fits(u, 4)) {
          diags.error(stmt, toks[0]?.col ?? head.col, 'bad-operands', L('这个值放不进 32 位寄存器', 'The value does not fit in a 32-bit register'))
          return
        }
        let sh = 0n
        while (u > 0xffffn && (u & 0xffffn) === 0n) {
          u >>= 16n
          sh += 16n
        }
        if (u <= 0xffffn && sh <= (size === 8 ? 48n : 16n)) movz = { value: u, shift: sh }
      }
      if (!movz) {
        const key = known !== null ? `${size}:=${known}` : toks.length === 1 && toks[0]!.kind === 'ident' && toks[0]!.text !== '.' ? `${size}:${toks[0]!.text}#${vars.get(toks[0]!.text)?.length ?? 0}` : null
        pool = (key && cur.poolCache.get(key)) || null
        if (!pool) {
          pool = { toks, size, offset: -1, stmt, value: known, seq }
          cur.pool.push(pool)
          if (key) cur.poolCache.set(key, pool)
        }
      }
    }
    instructions.push({ stmt, section: cur.id, offset: cur.offset, seq, mnemonic: head.text, mcol: head.col, toks: args, pool, movz })
    cur.offset += 4
    cur.instrEnd = cur.offset
  }

  /** The value of an expression with no address in it, if every symbol it uses is known here. */
  function constantNow(toks: Tok[]): bigint | null {
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
  const poolAddr = (e: PoolEntry, sec: SectionId) => baseOf(sec) + e.offset
  const le = (v: bigint, size: number) => {
    const u = BigInt.asUintN(8 * size, v)
    const bytes: number[] = []
    for (let k = 0; k < size; k++) bytes.push(Number((u >> BigInt(8 * k)) & 0xffn))
    return bytes
  }

  // Pass 2 runs even after errors, so one assembly reports every line that is wrong.
  {
    for (const r of instructions) {
      const s = sections.get(r.section)!
      const pc = baseOf(r.section) + r.offset
      const ctx = { pc, symbol: finalSymbol(r.seq) }
      let word: number | null = null
      if (r.inst !== undefined) word = r.inst
      else if (r.pool || r.movz) {
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
      if (d.bits !== undefined) {
        writeBytes(s, d.offset, le(d.bits, d.size))
        continue
      }
      let v: bigint
      let rel: Rel = NO_REL
      try {
        const r = parseExpr(d.toks, 0, contextAt(d.seq, baseOf(d.section) + d.offset, d.section, true))
        if (r.end < d.toks.length) {
          diags.error(d.stmt, d.toks[r.end]!.col, 'bad-expression', L(`多余的内容 "${d.toks[r.end]!.text}"`, `Unexpected "${d.toks[r.end]!.text}"`))
          continue
        }
        if (!relocatable(r.rel, d.section)) {
          notRelocatable(d.stmt, d.toks[0]!.col)
          continue
        }
        v = r.value
        rel = r.rel
      } catch (e) {
        if (!(e instanceof ExprError)) throw e
        diags.error(d.stmt, e.col, e.undefinedSymbol ? 'undefined-symbol' : 'bad-expression', e.message, e.length)
        continue
      }
      // As in LLVM, a value that fits neither signed nor unsigned is an error, unless it waited for a later
      // symbol (then only its low bytes are kept).
      if (!fits(v, d.size)) {
        if (rel.size || d.known) {
          diags.error(d.stmt, d.toks[0]!.col, 'out-of-range', L(`值 ${v} 放不进 ${d.size} 个字节`, `The value ${v} does not fit in ${d.size} bytes`))
          continue
        }
        diags.warn(d.stmt, d.toks[0]!.col, 'truncated', L(`值 ${v} 超出 ${d.size} 字节，只保留低位`, `Value ${v} does not fit in ${d.size} bytes; only the low bits are kept`))
      }
      if (d.section === 'bss' && v !== 0n) {
        diags.error(d.stmt, d.toks[0]!.col, 'bss-data', L('.bss 段只能放 0（有初值的数据放 .data）', 'The .bss section holds only zeros (data with values goes in .data)'))
        continue
      }
      writeBytes(s, d.offset, le(v, d.size))
    }
    for (const s of sections.values()) {
      for (const e of new Set(instructions.filter((r) => r.pool && r.section === s.id).map((r) => r.pool!))) {
        if (e.value !== null) writeBytes(s, e.offset, le(e.value, e.size))
      }
    }
  }

  function encodePool(r: InstrRecord, s: SectionState, pc: number): number | null {
    const reg = r.toks[0]!
    const comma: Tok = { kind: 'punct', text: ',', col: reg.col }
    const num = (v: bigint): Tok => ({ kind: 'num', text: String(v), col: reg.col, value: v })
    const encode = (mnemonic: string, toks: Tok[]): number | null => {
      try {
        return encodeInstr(mnemonic, toks, { pc, symbol: finalSymbol(r.seq) }).word
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
        const x = parseExpr(e.toks, 0, contextAt(e.seq, pc, r.section, true))
        if (x.end < e.toks.length) {
          diags.error(r.stmt, e.toks[x.end]!.col, 'bad-expression', L(`多余的内容 "${e.toks[x.end]!.text}"`, `Unexpected "${e.toks[x.end]!.text}"`))
          return null
        }
        if (!relocatable(x.rel, r.section)) {
          notRelocatable(r.stmt, e.toks[0]?.col ?? r.mcol)
          return null
        }
        v = x.value
      } catch (err) {
        if (!(err instanceof ExprError)) throw err
        diags.error(r.stmt, err.col, err.undefinedSymbol ? 'undefined-symbol' : 'bad-expression', err.message, err.length)
        return null
      }
      if (!fits(v, e.size)) {
        diags.error(r.stmt, e.toks[0]?.col ?? r.mcol, 'bad-operands', L('这个值放不进 32 位寄存器', 'The value does not fit in a 32-bit register'))
        return null
      }
      e.value = v
    }
    return encode('ldr', [reg, comma, { kind: 'num', text: '', col: reg.col, value: vaOf(poolAddr(e, s.id)) }])
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
