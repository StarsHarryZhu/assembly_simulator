/**
 * Two-pass MIPS assembler with MARS 4.5 semantics.
 *
 * Pre-pass: .include, .eqv substitution and macro expansion, producing a flat list of tokenized lines.
 * Pass 1:   labels, data directives, and the size of every instruction (pseudo forms have fixed sizes);
 *           labels used as data values are resolved at its end.
 * Pass 2:   symbol resolution in instructions and encoding.
 * As in MARS, pass 2 is skipped when pass 1 found errors.
 */
import { L, tx } from '../../core/i18n'
import type {
  AssembleOptions,
  AssembleResult,
  DataDeclaration,
  DataKind,
  Diagnostic,
  Program,
  ProgramInstruction,
  SourceFile,
} from '../../core/isa'
import { bitsFromDouble, bitsFromFloat, hex8 } from '../../core/format'
import { encode, render } from './encoding'
import { choose, describeSpec, FORMS_BY_NAME, type Form, type MatchError } from './forms'
import { BASIC_BY_NAME } from './instructions'
import type { InstrDef } from './instructions/types'
import { DIRECTIVE_NAMES, isLexical, lexicalErrors, splitSigns, tokenizeRaw, type Token } from './lexer'
import type { Emit, Rel } from './pseudo'

export const TEXT_BASE = 0x00400000
export const DATA_BASE = 0x10010000
export const EXTERN_BASE = 0x10000000
export const KTEXT_BASE = 0x80000000
export const KDATA_BASE = 0x90000000

export type MemoryRegion = 'text' | 'data' | 'ktext' | 'kdata' | 'mmio' | null

/**
 * Which region an access starting at `a` falls in, or null when nothing is mapped there. As in MARS's
 * default layout, each segment only backs 4 MB: text 0x00400000–0x007fffff, data 0x10000000–0x103fffff
 * (heap included), the stack 0x7fbffffd–0x7ffffffc, kernel text 0x80000000–0x803fffff, kernel data
 * 0x90000000–0x903fffff, and memory-mapped I/O 0xffff0000–0xfffffffe. Only the first byte is checked.
 */
export function memoryRegion(a: number): MemoryRegion {
  a >>>= 0
  if (a >= 0x00400000 && a < 0x00800000) return 'text'
  if (a >= 0x10000000 && a < 0x10400000) return 'data'
  if (a > 0x7fbffffc && a <= 0x7ffffffc) return 'data'
  if (a >= 0x80000000 && a < 0x80400000) return 'ktext'
  if (a >= 0x90000000 && a < 0x90400000) return 'kdata'
  if (a >= 0xffff0000 && a < 0xffffffff) return 'mmio'
  return null
}

/** The first address past the heap: sbrk fails once the heap would reach it, as in MARS. */
export const HEAP_LIMIT = 0x10400000

/** A tokenized source line after includes, .eqv and macros. */
interface Line {
  file: string
  line: number
  /** The text shown for this line (the macro call line for expanded macro bodies). */
  source: string
  tokens: Token[]
  /** Errors found while expanding a macro into this line, reported by pass 1 just before the line itself. */
  errors?: { col: number; code: string; message: string; length?: number }[]
}

type Segment = 'text' | 'data' | 'ktext' | 'kdata'

const DATA_DIRECTIVES = new Set(['.word', '.half', '.byte', '.ascii', '.asciiz', '.space', '.float', '.double', '.align'])
const KNOWN_DIRECTIVES = DIRECTIVE_NAMES
export const DIRECTIVES = [...KNOWN_DIRECTIVES].sort()

class Diags {
  list: Diagnostic[] = []
  error(line: Line | { file: string; line: number }, col: number, code: string, message: string, length?: number) {
    this.list.push({ severity: 'error', file: line.file, line: line.line, col, code, message, length })
  }
  warn(line: Line | { file: string; line: number }, col: number, code: string, message: string, length?: number) {
    this.list.push({ severity: 'warning', file: line.file, line: line.line, col, code, message, length })
  }
  get errors() {
    return this.list.filter((d) => d.severity === 'error').length
  }
}

/* ------------------------------------------------------------------ pre-pass */

interface Macro {
  name: string
  params: string[]
  body: { tokens: Token[]; text: string }[]
}

const isMnemonic = (word: string) => FORMS_BY_NAME.has(word.toLowerCase())

function preprocess(main: SourceFile, files: SourceFile[], diags: Diags): Line[] {
  const out: Line[] = []
  const eqv = new Map<string, Token[]>()
  /** Each .eqv value as written, since MARS lets a name be defined again only with the same text. */
  const eqvText = new Map<string, string>()
  /** .eqv names whose value has a character literal: MARS substitutes it without its closing quote. */
  const eqvChar = new Set<string>()
  const macros = new Map<string, Macro[]>()
  let macroSerial = 0

  // MARS substitutes the text and then reads the line again, so columns are those of the new text:
  // each replacement token keeps its offset in the .eqv value, and later tokens shift by the change in length.
  const substituteEqv = (tokens: Token[]): Token[] => {
    if (eqv.size === 0) return tokens
    const res: Token[] = []
    let shift = 0
    for (const t of tokens) {
      const rep = t.kind === 'ident' ? eqv.get(t.text) : undefined
      if (rep) {
        const start = rep[0]!.col
        for (const r of rep) res.push({ ...r, col: t.col + shift + r.col - start })
        shift += spanText(rep).length - t.text.length
      } else res.push(shift ? { ...t, col: t.col + shift } : t)
    }
    return res
  }

  const findMacro = (name: string, argc: number) => [...(macros.get(name) ?? [])].reverse().find((m) => m.params.length === argc) ?? null

  /** Parse "name args..." of a macro call: name(a, b) or name a, b. Returns null when it is not a call. */
  const macroCall = (tokens: Token[]): { macro: Macro; args: Token[][]; start: number } | null => {
    let i = 0
    while (i + 1 < tokens.length && tokens[i]!.kind === 'ident' && tokens[i + 1]!.kind === 'colon') i += 2
    const head = tokens[i]
    if (!head || head.kind !== 'ident' || !macros.has(head.text)) return null
    let rest = tokens.slice(i + 1)
    if (rest[0]?.kind === 'lparen' && rest[rest.length - 1]?.kind === 'rparen') rest = rest.slice(1, -1)
    const args = rest.map((t) => [t])
    const macro = findMacro(head.text, args.length)
    return macro ? { macro, args, start: i } : null
  }

  /** Handle ".eqv name value"; false (with an error reported) when it is not accepted. */
  const defineEqv = (here: { file: string; line: number }, raw: Token[]): boolean => {
    const first = raw[0]!
    const nameTok = raw[1]
    if (nameTok && raw.length === 2) {
      // MARS skips a name without a value, so the name stays undefined.
      diags.warn(here, first.col, 'eqv-ignored', L(`.eqv ${nameTok.text} 没有替换内容，已忽略`, `.eqv ${nameTok.text} has no replacement and is ignored`))
      return false
    }
    if (!nameTok || nameTok.kind !== 'ident' || raw.length < 3) {
      diags.error(here, first.col, 'bad-eqv', L('.eqv 的写法是：.eqv 名字 替换内容', '.eqv is written as: .eqv name replacement'))
      return false
    }
    const lower = nameTok.text.toLowerCase()
    if (MNEMONICS.includes(lower) || KNOWN_DIRECTIVES.has(lower)) {
      // MARS refuses to redefine an instruction or directive through .eqv.
      diags.error(here, first.col, 'bad-eqv', L(`.eqv 不能用指令或伪操作的名字 "${nameTok.text}"`, `.eqv cannot use the instruction or directive name "${nameTok.text}"`))
      return false
    }
    // A word MARS cannot read was already reported (see lexicalErrors).
    if (raw.slice(2).some(isLexical)) return false
    const bad = raw.slice(2).find((t) => t.kind === 'bad' || t.kind === 'marg')
    if (bad) {
      // A macro parameter is not substituted inside .eqv in MARS either: the name would stand for "%x" itself.
      diags.error(here, bad.col, 'bad-eqv', L(`.eqv 的替换内容里有无效的写法 "${bad.text}"`, `The .eqv replacement contains an invalid token "${bad.text}"`), bad.text.length)
      return false
    }
    if (raw.slice(2).some((t) => t.kind === 'ident' && t.text === nameTok.text)) {
      diags.error(here, first.col, 'bad-eqv', L(`.eqv 不能用 "${nameTok.text}" 替换它自己`, `.eqv cannot replace "${nameTok.text}" with itself`))
      return false
    }
    const value = spanText(raw.slice(2))
    const prev = eqvText.get(nameTok.text)
    if (prev !== undefined && prev !== value) {
      diags.error(here, nameTok.col, 'bad-eqv', L(`"${nameTok.text}" 已经用 .eqv 定义成了 "${prev}"，不能改成别的值`, `"${nameTok.text}" is already defined by .eqv as "${prev}" and cannot be given another value`), nameTok.text.length)
      return false
    }
    eqvText.set(nameTok.text, value)
    eqv.set(nameTok.text, substituteEqv(raw.slice(2)))
    if (raw.slice(2).some((t) => t.kind === 'int' && t.text[0] === "'")) eqvChar.add(nameTok.text)
    return true
  }

  const emitLine = (file: string, lineNo: number, source: string, substituted: Token[], active: Macro[]): void => {
    // Only now is the word before each sign final (see splitSigns); mnemonics are operators, macro names are not.
    const tokens = splitSigns(substituted, isMnemonic)
    if (tokens.length === 0) {
      out.push({ file, line: lineNo, source, tokens })
      return
    }
    const call = macroCall(tokens)
    if (call && active.includes(call.macro)) {
      const head = tokens[call.start]!
      // Reported at the outermost call, without a column, as MARS does.
      diags.error({ file, line: lineNo }, 0, 'macro-loop', L(`宏 "${head.text}" 在展开时又调用了自己（MARS 不允许宏递归）`, `Macro "${head.text}" calls itself while it is being expanded (MARS does not allow recursive macros)`), head.text.length)
      return
    }
    if (call) {
      // Labels before the call stay on their own line.
      if (call.start > 0) out.push({ file, line: lineNo, source, tokens: tokens.slice(0, call.start) })
      const serial = macroSerial++
      const local = new Set<string>()
      for (const b of call.macro.body) {
        const t = b.tokens
        for (let i = 0; i + 1 < t.length && t[i]!.kind === 'ident' && t[i + 1]!.kind === 'colon'; i += 2) local.add(t[i]!.text)
      }
      for (const b of call.macro.body) {
        // .eqv lines in a body took effect when the macro was defined, as in MARS.
        if (b.tokens[0]?.kind === 'dir' && b.tokens[0].text === '.eqv') continue
        const expanded: Token[] = []
        const errors: Line['errors'] = []
        for (const t of b.tokens) {
          if (t.kind === 'marg') {
            const idx = call.macro.params.indexOf(t.text)
            if (idx >= 0) {
              for (const a of call.args[idx]!) expanded.push({ ...a, col: t.col })
              continue
            }
            errors.push({ col: t.col, code: 'bad-macro', message: L(`宏 "${call.macro.name}" 没有参数 "${t.text}"`, `Macro "${call.macro.name}" has no parameter "${t.text}"`), length: t.text.length })
          }
          if (t.kind === 'ident' && local.has(t.text)) {
            expanded.push({ ...t, text: `${t.text}_M${serial}` })
            continue
          }
          expanded.push(t)
        }
        const first = out.length
        emitLine(file, lineNo, source, substituteEqv(retokenize(expanded)), [...active, call.macro])
        if (errors.length) {
          const at = out[first]
          if (at) at.errors = [...errors, ...(at.errors ?? [])]
          else out.push({ file, line: lineNo, source, tokens: [], errors })
        }
      }
      return
    }
    out.push({ file, line: lineNo, source, tokens })
  }

  /** Report a missing or unusable name after .macro. */
  const badMacroName = (here: { file: string; line: number }, raw: Token[]): boolean => {
    const nameTok = raw[1]
    if (!nameTok) diags.error(here, raw[0]!.col, 'bad-macro', L('.macro 后面要跟宏的名字', '.macro must be followed by the macro name'))
    else if (nameTok.kind !== 'ident' || isMnemonic(nameTok.text))
      diags.error(here, nameTok.col, 'bad-macro', L(`"${nameTok.text}" 不能用作宏的名字（不能是指令、寄存器、数字或伪操作）`, `"${nameTok.text}" cannot be a macro name (it must not be an instruction, register, number or directive)`), nameTok.text.length)
    else return false
    return true
  }

  const endMacroText = (here: { file: string; line: number }, dir: Token) =>
    diags.error(here, dir.col, 'bad-macro', L('.end_macro 后面不能再写别的内容', 'Nothing may follow .end_macro on its line'), dir.text.length)

  const visit = (file: SourceFile, depth: number): void => {
    const lines = file.text.split(/\r?\n/)
    let defining: Macro | null = null
    let defLine = 0
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!
      const lineNo = i + 1
      const here = { file: file.name, line: lineNo }
      const raw = tokenizeRaw(text)
      const first = raw[0]
      for (const e of lexicalErrors(text, raw))
        diags.error(here, e.col, 'lexical', L(`无法识别 "${e.text}"`, `Cannot read "${e.text}"`), e.text.length)
      if (eqvChar.size > 0 && first?.text !== '.eqv') {
        // MARS's substituted text has a broken character literal, which it cannot read.
        let shift = 0
        for (const t of raw) {
          const rep = t.kind === 'ident' ? eqv.get(t.text) : undefined
          if (!rep) continue
          if (eqvChar.has(t.text)) {
            // Only the first: the rest of the line is not read.
            diags.error(here, t.col + shift, 'lexical', L(`MARS 不能使用值是字符常量的 .eqv 名字 "${t.text}"`, `MARS cannot use the .eqv name "${t.text}", whose value is a character literal`), t.text.length)
            break
          }
          shift += spanText(rep).length - t.text.length
        }
      }

      if (defining) {
        if (first?.kind === 'dir' && first.text === '.end_macro' && raw.length > 1) {
          // MARS does not end the macro here: the line stays in the body and fails again at each call.
          endMacroText(here, first)
          defining.body.push({ tokens: raw, text })
        } else if (first?.kind === 'dir' && first.text === '.end_macro') {
          const list = macros.get(defining.name) ?? []
          list.push(defining)
          macros.set(defining.name, list)
          defining = null
        } else if (first?.kind === 'dir' && first.text === '.macro') {
          // MARS checks the name first.
          if (!badMacroName(here, raw)) diags.error(here, first.col, 'nested-macro', L('宏定义里不能再定义宏', 'A macro cannot be defined inside another macro'))
        } else {
          if (first?.kind === 'dir' && first.text === '.eqv') defineEqv(here, raw)
          defining.body.push({ tokens: raw, text })
        }
        continue
      }

      if (first?.kind === 'dir' && first.text === '.macro') {
        // As in MARS, after a bad name the lines up to .end_macro are assembled as ordinary code.
        if (badMacroName(here, raw)) continue
        const nameTok = raw[1]!
        const params: string[] = []
        for (const t of raw.slice(2)) {
          if (t.kind === 'marg') params.push(t.text)
          else if (t.kind !== 'lparen' && t.kind !== 'rparen')
            // MARS reports it and defines the macro without this parameter.
            diags.error(here, t.col, 'bad-macro', L(`宏参数 "${t.text}" 无效：参数要以 % 开头`, `Invalid macro parameter "${t.text}": parameters start with %`), t.text.length)
        }
        defining = { name: nameTok.text, params, body: [] }
        defLine = lineNo
        continue
      }
      if (first?.kind === 'dir' && first.text === '.end_macro') {
        if (raw.length > 1) endMacroText(here, first)
        else diags.error(here, first.col, 'bad-macro', L('.end_macro 前面没有对应的 .macro', '.end_macro without a matching .macro'))
        continue
      }
      if (first?.kind === 'dir' && first.text === '.eqv') {
        if (defineEqv(here, raw)) out.push({ file: file.name, line: lineNo, source: text, tokens: [] })
        continue
      }
      if (first?.kind === 'dir' && first.text === '.include') {
        const nameTok = raw[1]
        if (!nameTok || nameTok.kind !== 'str') {
          diags.error(here, first.col, 'bad-include', L('.include 后面要跟带引号的文件名', '.include must be followed by a quoted file name'))
          continue
        }
        const target = files.find((f) => f.name === nameTok.str)
        if (!target || depth > 8) {
          diags.error(here, nameTok.col, 'include', L(`读不到被包含的文件 "${nameTok.str}"（先在“文件”里添加它）`, `Cannot read the included file "${nameTok.str}" (add it under Files first)`), nameTok.text.length)
          continue
        }
        visit(target, depth + 1)
        continue
      }
      emitLine(file.name, lineNo, text, substituteEqv(raw), [])
    }
    if (defining) diags.error({ file: file.name, line: defLine }, 0, 'macro-unterminated', L('.macro 没有对应的 .end_macro', '.macro without a matching .end_macro'))
  }

  visit(main, 0)
  return out
}

/** Tokens as written, with the gaps between them kept (as spaces), for comparing .eqv values. */
function spanText(tokens: Token[]): string {
  let text = ''
  let end = tokens[0]?.col ?? 0
  for (const t of tokens) {
    text += ' '.repeat(Math.max(0, t.col - end)) + t.text
    end = t.col + t.text.length
  }
  return text
}

/** After macro substitution a "%x" argument may have become a register or number; re-classify by text. */
function retokenize(tokens: Token[]): Token[] {
  return tokens.map((t) => {
    if (t.kind !== 'ident' && t.kind !== 'marg') return t
    const again = tokenizeRaw(t.text)
    return again.length === 1 ? { ...again[0]!, col: t.col } : t
  })
}

/* ------------------------------------------------------------------ passes 1 and 2 */

interface PendingInstr {
  line: Line
  /** Column of the mnemonic. */
  col: number
  form: Form
  operands: Token[]
  addr: number
  size: number
  segment: Segment
}

interface WordFixup {
  line: Line
  token: Token
  addr: number
  size: 1 | 2 | 4
}

export function assemble(main: SourceFile, options: AssembleOptions = {}): AssembleResult {
  const diags = new Diags()
  const lines = preprocess(main, options.files ?? [], diags)
  // MARS handles .include and .eqv while it reads the source, before assembling anything: a mistake there
  // is the only error it reports.
  if (diags.list.some((d) => d.severity === 'error' && READING_ERRORS.has(d.code ?? '')))
    return { ok: false, diagnostics: diags.list.filter((d) => d.severity !== 'error' || READING_ERRORS.has(d.code ?? '')), program: null }
  // MARS meets macro definitions while it goes through the lines, so their mistakes are listed among
  // the other pass 1 errors in line order, and an unclosed .macro only at the end of pass 1.
  const early = diags.list.splice(0)

  const symbols = new Map<string, { addr: number; line: Line }>()
  const bytes = new Map<number, number>()
  const declarations: DataDeclaration[] = []
  const pending: PendingInstr[] = []
  const fixups: WordFixup[] = []
  /** Names given to .globl, which must be defined by the end of pass 1. */
  const globals: { line: Line; token: Token }[] = []

  const addr: Record<Segment, number> = { text: TEXT_BASE, data: DATA_BASE, ktext: KTEXT_BASE, kdata: KDATA_BASE }
  let externAddr = EXTERN_BASE
  let seg: Segment = 'text'
  let autoAlign = true
  /** The data directive that a line of bare values continues (MARS starts with .word). */
  let lastData = '.word'
  /** Set while such a continuation line is handled: it cannot use the "value : count" repeat. */
  let continuing = false
  /** Data labels waiting for the next data item; auto-alignment moves them along with it. */
  let waiting: { name: string; segment: Segment }[] = []

  const isData = (s: Segment) => s === 'data' || s === 'kdata'

  const define = (line: Line, tok: Token) => {
    const name = tok.text
    const prev = symbols.get(name)
    if (prev) {
      diags.error(line, tok.col, 'duplicate-label', L(`标签 "${name}" 已经定义过了（第 ${prev.line.line} 行）`, `Label "${name}" is already defined (line ${prev.line.line})`), name.length)
      return
    }
    symbols.set(name, { addr: addr[seg], line })
    if (isData(seg)) waiting.push({ name, segment: seg })
  }

  const alignTo = (n: number) => {
    const a = addr[seg]
    // MARS rounds up by n - (address % n) with a signed remainder, which is negative in kernel data
    // (0x90000000 and up): there an unaligned address moves a whole step further (0x90000001 -> 0x90000008).
    const r = (a | 0) % n
    const aligned = r === 0 ? a : a + n - r
    if (aligned !== a) {
      addr[seg] = aligned >>> 0
      for (const w of waiting) if (w.segment === seg && symbols.get(w.name)?.addr === a) symbols.get(w.name)!.addr = addr[seg]
    }
  }

  const declare = (line: Line, kind: DataKind, start: number, size: number, count: number) => {
    const label = waiting.find((w) => w.segment === seg && symbols.get(w.name)?.addr === start)?.name ?? null
    waiting = []
    declarations.push({ label, kind, addr: start >>> 0, size, count, file: line.file, line: line.line, segment: seg })
  }

  const putBytes = (at: number, value: number, n: number) => {
    for (let i = 0; i < n; i++) bytes.set((at + i) >>> 0, (value >>> (8 * i)) & 0xff)
  }


  /**
   * Data can only be written where MARS has data memory: the data segment, stack, kernel data or MMIO.
   * Like MARS, every item (every byte of a string) that misses is reported.
   */
  const checkData = (line: Line, tok: Token, at: number): boolean => {
    const r = memoryRegion(at)
    if (r === 'data' || r === 'kdata' || r === 'mmio') return true
    diags.error(
      line,
      tok.col,
      'bad-data-addr',
      L(`数据地址无效：${hex8(at)}（数据只能放在数据段、栈、内核数据段或内存映射 I/O 区域）`, `Invalid data address: ${hex8(at)} (data can only go in the data segment, the stack, kernel data or memory-mapped I/O)`),
      tok.text.length,
    )
    return false
  }

  /* ---------- pass 1 ---------- */
  for (const line of lines) {
    for (const e of line.errors ?? []) diags.error(line, e.col, e.code, e.message, e.length)
    let t = line.tokens
    // MARS allows at most one label per line; a second `name:` is handed to the instruction
    // matcher, which then reports "too many operands" at the same token MARS points at.
    if (t.length >= 2 && t[0]!.kind === 'ident' && t[1]!.kind === 'colon') {
      define(line, t[0]!)
      t = t.slice(2)
    }
    if (t.length === 0) continue
    const head = t[0]!
    const rest = t.slice(1)

    if (head.kind === 'dir') {
      directive(line, head, rest)
      continue
    }
    // In a data segment, a line that starts with a value or a label reference holds more values for the
    // last data directive, even across segment changes (MARS: ".word 1" then a line "2, 3").
    if (isData(seg) && (head.kind === 'int' || head.kind === 'real' || head.kind === 'str' || (head.kind === 'ident' && !head.text.startsWith('.') && !isMnemonic(head.text)))) {
      continuing = true
      directive(line, { kind: 'dir', text: lastData, col: head.col }, t)
      continuing = false
      continue
    }
    // A dotted word that is not a directive (".foo 1"): MARS skips the statement without a word.
    if (head.kind === 'ident' && head.text.startsWith('.')) {
      diags.warn(line, head.col, 'unknown-directive', L(`不认识的伪操作 ${head.text}，已忽略`, `Unknown directive ${head.text}, ignored`), head.text.length)
      continue
    }
    if (head.kind !== 'ident') {
      diags.error(line, head.col, 'unknown-op', L(`"${head.text}" 不是可识别的指令`, `"${head.text}" is not a recognized instruction`), head.text.length)
      continue
    }
    const name = head.text.toLowerCase()
    const picked = choose(name, rest)
    if (!picked) {
      diags.error(line, head.col, 'unknown-op', L(`"${head.text}" 不是可识别的指令`, `"${head.text}" is not a recognized instruction`), head.text.length)
      continue
    }
    if (picked.error) {
      reportMatch(line, head, picked.form, picked.error)
      continue
    }
    if (isData(seg)) {
      diags.error(line, head.col, 'instr-in-data', L('数据段（.data）里不能写指令，先写 .text', 'Instructions cannot appear in the data segment (.data); write .text first'), head.text.length)
      continue
    }
    const size = picked.form.basic ? 1 : picked.form.pseudo!.expand(dummyArgs(rest)).length
    pending.push({ line, col: head.col, form: picked.form, operands: rest, addr: addr[seg], size, segment: seg })
    addr[seg] = (addr[seg] + size * 4) >>> 0
  }

  function reportMatch(line: Line, head: Token, form: Form, e: MatchError) {
    if (e.code === 'too-few' || e.code === 'too-many') {
      diags.error(
        line,
        head.col,
        e.code,
        L(`"${head.text}" 的操作数${e.code === 'too-few' ? '太少' : '太多'}或格式不对。正确写法：${form.example}`, `Too ${e.code === 'too-few' ? 'few' : 'many'} or incorrectly formatted operands for "${head.text}". Expected: ${form.example}`),
        head.text.length,
      )
      return
    }
    const { token: tok, want } = e as Extract<MatchError, { code: 'bad-type' | 'out-of-range' }>
    if (e.code === 'out-of-range') diags.error(line, tok.col, e.code, L(`"${tok.text}" 超出范围：这里需要${describeSpec(want)}`, `"${tok.text}" is out of range: expected ${describeSpec(want)}`), tok.text.length)
    else diags.error(line, tok.col, e.code, L(`"${tok.text}" 的类型不对：这里需要${describeSpec(want)}`, `"${tok.text}" is of the wrong type: expected ${describeSpec(want)}`), tok.text.length)
  }

  /** The count of "value : count"; MARS rejects zero and negative counts. */
  function repeatCount(line: Line, count: Token): number {
    if (count.value! > 0) return count.value!
    diags.error(line, count.col, 'bad-repeat', L(`重复次数必须是正数，"${count.text}" 不是`, `The repeat count must be positive; "${count.text}" is not`), count.text.length)
    return 0
  }

  function directive(line: Line, head: Token, args: Token[]) {
    const d = head.text
    if (!KNOWN_DIRECTIVES.has(d)) {
      diags.warn(line, head.col, 'unknown-directive', L(`不认识的伪操作 ${d}，已忽略`, `Unknown directive ${d}, ignored`), d.length)
      return
    }
    if (d === '.text' || d === '.data' || d === '.ktext' || d === '.kdata') {
      seg = d.slice(1) as Segment
      if (isData(seg)) autoAlign = true
      if (args[0]?.kind === 'int') addr[seg] = args[0].value! >>> 0
      return
    }
    if (d === '.globl') {
      // MARS: at least one name, every argument a label, and each must be defined somewhere (checked after pass 1).
      if (!args.length) diags.error(line, head.col, 'bad-globl', L('.globl 后面至少要写一个标签', '.globl needs at least one label'), d.length)
      for (const a of args) {
        if (a.kind === 'ident') globals.push({ line, token: a })
        else {
          // MARS points at the directive and stops at the first argument that is not a label.
          diags.error(line, head.col, 'bad-globl', L(`.globl 的参数必须是标签，"${a.text}" 不是`, `.globl arguments must be labels; "${a.text}" is not`), d.length)
          break
        }
      }
      return
    }
    if (d === '.set') {
      diags.warn(line, head.col, 'set-ignored', L('.set 会被忽略', '.set is ignored'), d.length)
      return
    }
    if (d === '.extern') {
      const name = args[0]
      const size = args[1]
      if (!name || name.kind !== 'ident' || !size || size.kind !== 'int' || size.value! < 0) {
        diags.error(line, head.col, 'bad-extern', L('.extern 的写法是：.extern 标签 字节数', '.extern is written as: .extern label size'))
        return
      }
      if (!symbols.has(name.text)) {
        symbols.set(name.text, { addr: externAddr, line })
        declarations.push({ label: name.text, kind: 'space', addr: externAddr, size: size.value!, count: size.value!, file: line.file, line: line.line, segment: 'extern' })
        externAddr = (externAddr + size.value! + 3) & ~3
      }
      return
    }
    // Only a body line ".end_macro <text>" gets here, from a macro call; MARS reports it at each call.
    if (d === '.end_macro') return void diags.error(line, head.col, 'bad-macro', L('.end_macro 后面不能再写别的内容', 'Nothing may follow .end_macro on its line'), d.length)
    if (d === '.eqv' || d === '.macro' || d === '.include') return // handled in the pre-pass

    // A data directive names what later lines of bare values continue, even where it is itself an error.
    if (DATA_LISTS.has(d)) lastData = d
    if (!isData(seg)) {
      diags.error(line, head.col, 'dir-in-text', L(`"${d}" 不能出现在代码段（.text）里，先写 .data`, `"${d}" cannot appear in the text segment (.text); write .data first`), d.length)
      return
    }

    switch (d) {
      case '.align': {
        const n = args[0]
        if (!n || n.kind !== 'int' || n.value! < 0 || n.value! > 21) {
          diags.error(line, head.col, 'bad-align', L('.align 需要 0 到 21 的整数（按 2 的 n 次方字节对齐）', '.align needs an integer from 0 to 21 (aligns to 2^n bytes)'))
          return
        }
        if (n.value === 0) autoAlign = false
        else alignTo(1 << n.value!)
        return
      }
      case '.space': {
        const n = args[0]
        if (args.length > 1) {
          diags.error(line, head.col, 'bad-space', L('".space" 只能有一个参数（字节数）', '".space" takes exactly one operand (the number of bytes)'), d.length)
          return
        }
        if (!n || n.kind !== 'int' || n.value! < 0) {
          diags.error(line, head.col, 'space-negative', L('".space" 需要一个非负整数', '".space" needs a non-negative integer'))
          return
        }
        const start = addr[seg]
        addr[seg] = (addr[seg] + n.value!) >>> 0
        declare(line, 'space', start, n.value!, n.value!)
        return
      }
      case '.ascii':
      case '.asciiz': {
        const start = addr[seg]
        let count = 0
        for (const a of args) {
          if (a.kind !== 'str') {
            diags.error(line, a.col, 'bad-string', L(`"${a.text}" 不是带引号的字符串`, `"${a.text}" is not a quoted string`), a.text.length)
            continue
          }
          for (const ch of a.str!) {
            checkData(line, a, addr[seg])
            bytes.set(addr[seg], ch.charCodeAt(0) & 0xff)
            addr[seg] = (addr[seg] + 1) >>> 0
            count++
          }
          if (d === '.asciiz') {
            checkData(line, a, addr[seg])
            bytes.set(addr[seg], 0)
            addr[seg] = (addr[seg] + 1) >>> 0
            count++
          }
        }
        declare(line, d === '.ascii' ? 'ascii' : 'asciiz', start, count, count)
        return
      }
      case '.word':
      case '.half':
      case '.byte': {
        const size = d === '.word' ? 4 : d === '.half' ? 2 : 1
        // MARS fills in a label that is already defined right away, at the address it has at that moment,
        // so a label that this directive's alignment moves still counts at its old, unaligned address.
        const before = new Map(waiting.map((w) => [w.name, symbols.get(w.name)?.addr]))
        if (autoAlign && size > 1) alignTo(size)
        const start = addr[seg]
        let count = 0
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!
          let repeat = 1
          let hasRepeat = false
          if (!continuing && soleRepeat(args)) {
            repeat = repeatCount(line, args[i + 2]!)
            hasRepeat = true
            i += 2
          }
          if (a.kind === 'int') {
            const v = a.value!
            if (size < 4) {
              // MARS warns whenever the value does not fit the signed range, even for 0x81 in a .byte.
              const min = size === 1 ? -128 : -32768
              const max = size === 1 ? 127 : 32767
              if (v < min || v > max)
                diags.warn(line, a.col, 'truncated', L(`"${a.text}" 超出 ${d} 的有符号范围，只保留低 ${size * 8} 位`, `"${a.text}" is outside the signed range of ${d}; only the low ${size * 8} bits are kept`), a.text.length)
            }
            for (let r = 0; r < repeat; r++) {
              checkData(line, a, addr[seg])
              putBytes(addr[seg], v, size)
              addr[seg] = (addr[seg] + size) >>> 0
              count++
            }
          } else if (a.kind === 'ident' && !hasRepeat) {
            // MARS truncates a label to the low 8/16/32 bits of its address without a warning.
            checkData(line, a, addr[seg])
            const known = symbols.get(a.text)
            if (known) putBytes(addr[seg], before.get(a.text) ?? known.addr, size)
            else fixups.push({ line, token: a, addr: addr[seg], size })
            addr[seg] = (addr[seg] + size) >>> 0
            count++
          } else if (a.kind === 'ident') {
            diags.error(line, a.col, 'bad-data-value', L(`标签 "${a.text}" 不能带 ":重复次数"`, `Label "${a.text}" cannot have a ":count" repeat`), a.text.length)
          } else {
            diags.error(line, a.col, 'bad-data-value', L(`"${a.text}" 不是有效的整数或标签`, `"${a.text}" is not a valid integer or label`), a.text.length)
          }
        }
        declare(line, d.slice(1) as DataKind, start, count * size, count)
        return
      }
      case '.float':
      case '.double': {
        const size = d === '.float' ? 4 : 8
        if (autoAlign) alignTo(size)
        const start = addr[seg]
        let count = 0
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!
          let repeat = 1
          if (!continuing && soleRepeat(args)) {
            repeat = repeatCount(line, args[i + 2]!)
            i += 2
          }
          let v: number
          if (a.kind === 'int') {
            if (/^[-+]?(0[xX]|#)/.test(a.text)) {
              diags.error(line, a.col, 'bad-data-value', L(`"${a.text}" 不是有效的浮点数（浮点数不能用十六进制写法）`, `"${a.text}" is not a valid floating point constant (floats cannot be written in hexadecimal)`), a.text.length)
              continue
            }
            // MARS parses a float token as a decimal number, so ".float 010" is 10.0, not octal 8;
            // only a character literal keeps its integer value.
            v = a.text[0] === "'" ? a.value! : Number(a.text)
          } else if (a.kind === 'real') {
            // MARS rejects a leading '-' before Infinity/NaN (it reads '-' as a unary operator).
            if (a.text === '-Infinity' || a.text === '-NaN') {
              diags.error(line, a.col, 'bad-data-value', L(`"${a.text}" 不是有效的数字`, `"${a.text}" is not a valid number`), a.text.length)
              continue
            }
            v = a.real!
          } else {
            diags.error(line, a.col, 'bad-data-value', L(`"${a.text}" 不是有效的数字`, `"${a.text}" is not a valid number`), a.text.length)
            continue
          }
          if (size === 4 && !Number.isNaN(v) && (!Number.isFinite(v) || Math.abs(v) > 3.4028234663852886e38)) {
            diags.error(line, a.col, 'float-range', L(`"${a.text}" 超出单精度浮点数的范围`, `"${a.text}" is out of range for a single-precision float`), a.text.length)
            continue
          }
          for (let r = 0; r < repeat; r++) {
            // One error per value, as in MARS, even when both words of a double are out of bounds.
            const fits = checkData(line, a, addr[seg])
            if (size === 4) putBytes(addr[seg], bitsFromFloat(v), 4)
            else {
              if (fits) checkData(line, a, addr[seg] + 4)
              const [low, high] = bitsFromDouble(v)
              putBytes(addr[seg], low, 4)
              putBytes(addr[seg] + 4, high, 4)
            }
            addr[seg] = (addr[seg] + size) >>> 0
            count++
          }
        }
        declare(line, d.slice(1) as DataKind, start, count * size, count)
        return
      }
    }
  }

  for (const e of early) {
    const at = e.code === 'macro-unterminated' || e.file !== main.name ? -1 : diags.list.findIndex((d) => d.file === e.file && d.line > e.line)
    if (at < 0) diags.list.push(e)
    else diags.list.splice(at, 0, e)
  }

  for (const g of globals)
    if (!symbols.has(g.token.text))
      diags.error(g.line, g.token.col, 'bad-globl', L(`"${g.token.text}" 用 .globl 声明了，但程序里没有定义这个标签`, `"${g.token.text}" is declared with .globl but never defined`), g.token.text.length)

  const lookup = (line: Line, tok: Token): number | null => {
    const s = symbols.get(tok.text)
    if (!s) {
      diags.error(line, tok.col, 'undefined-symbol', L(`找不到符号 "${tok.text}"`, `Symbol "${tok.text}" not found`), tok.text.length)
      return null
    }
    return s.addr
  }

  // Labels used as data values are filled in at the end of pass 1, as in MARS: every unknown one is
  // reported, even after other errors, and then the instructions are left alone.
  for (const f of fixups) {
    const v = lookup(f.line, f.token)
    if (v != null) putBytes(f.addr, v, f.size)
  }

  if (diags.errors > 0) return { ok: false, diagnostics: diags.list, program: null }

  /* ---------- pass 2 ---------- */

  const labelAt = new Map<number, string>()
  for (const [name, s] of symbols) if (!labelAt.has(s.addr)) labelAt.set(s.addr, name)

  const instructions: ProgramInstruction[] = []
  // MARS goes through the instructions in order and stops at the first one that names an unknown symbol,
  // or at the next one once an error has been reported (a missing "$32" in an ld/sd expansion). Forms
  // it cannot expand fail only at the very end, and so only when it got through all of them.
  const cannot: PendingInstr[] = []
  let stopped = false
  for (const p of pending) {
    const values = operandValues(p, lookup)
    if (!values || diags.errors > 0) {
      stopped = true
      break
    }
    if (p.form.pseudo?.marsCannot) {
      cannot.push(p)
      continue
    }
    let emits: Emit[]
    if (p.form.basic) emits = [[p.form.name, ...values.flat]]
    else emits = p.form.pseudo!.expand({ r: values.r, v: values.v })
    if (emits.length !== p.size) {
      diags.error(p.line, 0, 'internal', L(`内部错误：${p.form.example} 展开后的长度和第一遍不一致`, `Internal error: the expansion of ${p.form.example} changed length between passes`))
      continue
    }
    emits.forEach((e, k) => {
      const at = (p.addr + k * 4) >>> 0
      const enc = encodeEmit(e, at, p.line, diags)
      if (!enc) return
      for (let i = 0; i < 4; i++) bytes.set((at + i) >>> 0, (enc.word >>> (8 * i)) & 0xff)
      instructions.push({
        addr: at,
        word: enc.word,
        basic: render(enc.def, enc.word, { addr: at, label: (a) => labelAt.get(a) ?? null }),
        file: p.line.file,
        line: p.line.line,
        source: p.line.source,
        part: k,
        parts: emits.length,
      })
    })
  }

  // Last, as MARS places the code in memory: every word must be word-aligned inside a text segment and
  // not taken yet (a basic instruction is reported at its mnemonic, the words of an expansion at column 1).
  // Forms MARS cannot expand fail here too, right after their first word.
  if (!stopped) {
    const occupied = new Map<number, Line>()
    for (const p of pending) {
      for (let k = 0; k < p.size; k++) {
        const a = (p.addr + 4 * k) >>> 0
        const r = memoryRegion(a)
        const prev = occupied.get(a)
        if ((a & 3) !== 0 || (r !== 'text' && r !== 'ktext'))
          diags.error(
            p.line,
            p.form.basic ? p.col : 1,
            'bad-text-addr',
            L(`代码段地址无效：${hex8(a)}（指令要按 4 字节对齐，放在 0x00400000–0x007ffffc 或 0x80000000–0x803ffffc）`, `Invalid text segment address: ${hex8(a)} (instructions must be word-aligned within 0x00400000–0x007ffffc or 0x80000000–0x803ffffc)`),
          )
        // MARS gives no column for this one.
        else if (prev) diags.error(p.line, 0, 'duplicate-text-addr', L(`代码段地址 ${hex8(a)} 已经被第 ${prev.line} 行的指令占用`, `Text segment address ${hex8(a)} is already occupied by line ${prev.line}`))
        else occupied.set(a, p.line)
        if (k === 0 && cannot.includes(p)) diags.error(p.line, 0, 'mars-cannot', tx(p.form.pseudo!.marsCannot!))
      }
    }
  }
  if (diags.errors > 0) return { ok: false, diagnostics: diags.list, program: null }

  instructions.sort((a, b) => a.addr - b.addr)
  const program: Program = {
    isa: 'mips32',
    instructions,
    declarations,
    symbols: Object.fromEntries([...symbols].map(([k, v]) => [k, v.addr])),
    image: toImage(bytes),
    entry: TEXT_BASE,
  }
  return { ok: true, diagnostics: diags.list, program }
}

/** Errors found while the source is read (.include, .eqv); MARS stops right after them. */
const READING_ERRORS: ReadonlySet<string> = new Set(['lexical', 'bad-eqv', 'include'])

/** Directives whose values a following line of bare values can continue. */
const DATA_LISTS: ReadonlySet<string> = new Set(['.word', '.half', '.byte', '.float', '.double', '.ascii', '.asciiz'])

/** "value : count" repeats a data value, but MARS reads it only when it is the directive's whole argument. */
function soleRepeat(args: Token[]): boolean {
  return args.length === 3 && args[1]!.kind === 'colon' && args[2]!.kind === 'int'
}

/** Placeholder operand values for sizing pseudo forms in pass 1 (sizes never depend on values). */
function dummyArgs(toks: Token[]) {
  const r: number[] = []
  const v: number[] = []
  for (const t of toks) {
    if (t.kind === 'reg' || t.kind === 'freg') r.push(t.value!)
    else if (t.kind === 'int' || t.kind === 'ident') v.push(t.kind === 'int' ? t.value! : 0)
  }
  return { r, v }
}

/** Operand tokens -> values. `flat` is in source order (for basic forms); r and v split them for pseudo forms. */
function operandValues(p: PendingInstr, lookup: (line: Line, tok: Token) => number | null) {
  const r: number[] = []
  const v: number[] = []
  const flat: number[] = []
  let ok = true
  for (const t of p.operands) {
    if (t.kind === 'reg' || t.kind === 'freg') {
      r.push(t.value!)
      flat.push(t.value!)
    } else if (t.kind === 'int') {
      v.push(t.value!)
      flat.push(t.value!)
    } else if (t.kind === 'ident') {
      const a = lookup(p.line, t)
      if (a == null) ok = false
      v.push(a ?? 0)
      flat.push(a ?? 0)
    }
  }
  // Basic "mem" operands are written offset(base) but bound as (offset, base): the token order already is.
  return ok ? { r, v, flat } : null
}

function argCount(d: InstrDef): number {
  return d.ops.reduce((n, op) => n + (op === 'mem' ? 2 : 1), 0)
}

export function basicDef(name: string, argc: number): InstrDef | null {
  return BASIC_BY_NAME.get(name)?.find((d) => argCount(d) === argc) ?? null
}

/** Bind one basic instruction's operands to fields and encode it at `at`. */
export function encodeEmit(e: Emit, at: number, line: { file: string; line: number }, diags?: Diags): { def: InstrDef; word: number } | null {
  const [name, ...args] = e
  const def = basicDef(name, args.length)
  if (!def) {
    diags?.error(line, 0, 'internal', L(`内部错误：没有 ${name}/${args.length} 这条真指令`, `Internal error: no basic instruction ${name}/${args.length}`))
    return null
  }
  const fields: Record<string, number> = {}
  let i = 0
  for (const op of def.ops) {
    const a = args[i++]!
    switch (op) {
      case 'mem':
        fields.imm = (a as number) & 0xffff
        fields.rs = args[i++] as number
        break
      case 'off': {
        let words: number
        if (typeof a === 'object') words = (a as Rel).rel
        else {
          const delta = ((a as number) - (at + 4)) | 0
          words = delta >> 2
          if (words < -32768 || words > 32767) diags?.error(line, 0, 'branch-range', L('分支目标太远：偏移超出 16 位范围，改用 j 跳转', 'Branch target too far: the offset does not fit in 16 bits; use j instead'))
        }
        fields.imm = words & 0xffff
        break
      }
      case 'tgt': {
        const target = (a as number) >>> 0
        // j and jal keep the top 4 bits of the next address, so the target must share them.
        if (((target ^ (at + 4)) & 0xf0000000) !== 0)
          diags?.error(line, 0, 'jump-range', L('跳转目标太远：j / jal 只能跳到同一个 256 MB 区域（地址最高 4 位相同）', 'Jump target out of range: j and jal only reach the same 256 MB region (the top 4 address bits must match)'))
        fields.target = (target >>> 2) & 0x3ffffff
        break
      }
      case 'c0':
        fields.rd = a as number
        break
      case 'sa':
        fields.shamt = (a as number) & 31
        break
      case 'cc':
        fields.cc = (a as number) & 7
        break
      case 'imm':
      case 'immu':
        fields.imm = (a as number) & 0xffff
        break
      case 'code':
        fields.code = (a as number) & 0xfffff
        break
      default:
        // A register pair (ld, sd, mtc1.d, mfc1.d) starting at $31 would need a $32, as MARS also says.
        // MARS gives the column of "$32" in the expanded instruction ("sw $32, ..."), not in the source.
        if ((a as number) > 31)
          diags?.error(
            line,
            i === 1 ? name.length + 2 : 0,
            'undefined-symbol',
            L(`这条伪指令要用一对相邻的寄存器，但 $31 后面没有寄存器（$${a as number} 不存在）`, `This pseudo-instruction needs a pair of registers, but there is no register after $31 ($${a as number} does not exist)`),
          )
        fields[op] = (a as number) & 31
    }
  }
  return { def, word: encode(def, fields) }
}

function toImage(bytes: Map<number, number>): { addr: number; bytes: Uint8Array }[] {
  const addrs = [...bytes.keys()].sort((a, b) => a - b)
  const chunks: { addr: number; bytes: Uint8Array }[] = []
  let start = -1
  let buf: number[] = []
  let prev = -2
  for (const a of addrs) {
    if (a !== prev + 1) {
      if (buf.length) chunks.push({ addr: start, bytes: Uint8Array.from(buf) })
      start = a
      buf = []
    }
    buf.push(bytes.get(a)!)
    prev = a
  }
  if (buf.length) chunks.push({ addr: start, bytes: Uint8Array.from(buf) })
  return chunks
}

/** Mnemonics the editor highlights and completes. */
export const MNEMONICS = [...FORMS_BY_NAME.keys()].sort()
