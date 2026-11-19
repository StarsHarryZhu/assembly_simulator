/**
 * Two-pass MIPS assembler with MARS 4.5 semantics.
 *
 * Pre-pass: .include, .eqv substitution and macro expansion, producing a flat list of tokenized lines.
 * Pass 1:   labels, data directives, and the size of every instruction (pseudo forms have fixed sizes).
 * Pass 2:   symbol resolution and encoding.
 * As in MARS, pass 2 is skipped when pass 1 found errors.
 */
import { L } from '../../core/i18n'
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
import { bitsFromDouble, bitsFromFloat } from '../../core/format'
import { encode, render } from './encoding'
import { choose, describeSpec, FORMS_BY_NAME, type Form, type MatchError } from './forms'
import { BASIC_BY_NAME } from './instructions'
import type { InstrDef } from './instructions/types'
import { tokenize, type Token } from './lexer'
import type { Emit, Rel } from './pseudo'

export const TEXT_BASE = 0x00400000
export const DATA_BASE = 0x10010000
export const EXTERN_BASE = 0x10000000
export const KTEXT_BASE = 0x80000000
export const KDATA_BASE = 0x90000000

/** A tokenized source line after includes, .eqv and macros. */
interface Line {
  file: string
  line: number
  /** The text shown for this line (the macro call line for expanded macro bodies). */
  source: string
  tokens: Token[]
}

type Segment = 'text' | 'data' | 'ktext' | 'kdata'

const DATA_DIRECTIVES = new Set(['.word', '.half', '.byte', '.ascii', '.asciiz', '.space', '.float', '.double', '.align'])
const KNOWN_DIRECTIVES = new Set([
  ...DATA_DIRECTIVES,
  '.text',
  '.data',
  '.ktext',
  '.kdata',
  '.globl',
  '.extern',
  '.eqv',
  '.macro',
  '.end_macro',
  '.include',
  '.set',
])
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

function preprocess(main: SourceFile, files: SourceFile[], diags: Diags): Line[] {
  const out: Line[] = []
  const eqv = new Map<string, Token[]>()
  const macros = new Map<string, Macro[]>()
  let macroSerial = 0

  const substituteEqv = (tokens: Token[]): Token[] => {
    if (eqv.size === 0) return tokens
    const res: Token[] = []
    for (const t of tokens) {
      const rep = t.kind === 'ident' ? eqv.get(t.text) : undefined
      if (rep) for (const r of rep) res.push({ ...r, col: t.col })
      else res.push(t)
    }
    return res
  }

  const findMacro = (name: string, argc: number) => macros.get(name)?.find((m) => m.params.length === argc) ?? null

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

  const emitLine = (file: string, lineNo: number, source: string, tokens: Token[], depth: number): void => {
    if (tokens.length === 0) {
      out.push({ file, line: lineNo, source, tokens })
      return
    }
    const call = macroCall(tokens)
    if (call && depth < 32) {
      // Labels before the call stay on their own line.
      if (call.start > 0) out.push({ file, line: lineNo, source, tokens: tokens.slice(0, call.start) })
      const serial = macroSerial++
      const local = new Set<string>()
      for (const b of call.macro.body) {
        const t = b.tokens
        for (let i = 0; i + 1 < t.length && t[i]!.kind === 'ident' && t[i + 1]!.kind === 'colon'; i += 2) local.add(t[i]!.text)
      }
      for (const b of call.macro.body) {
        const expanded: Token[] = []
        for (const t of b.tokens) {
          if (t.kind === 'marg') {
            const idx = call.macro.params.indexOf(t.text)
            if (idx >= 0) {
              for (const a of call.args[idx]!) expanded.push({ ...a, col: t.col })
              continue
            }
          }
          if (t.kind === 'ident' && local.has(t.text)) {
            expanded.push({ ...t, text: `${t.text}_M${serial}` })
            continue
          }
          expanded.push(t)
        }
        emitLine(file, lineNo, source, substituteEqv(retokenize(expanded)), depth + 1)
      }
      return
    }
    out.push({ file, line: lineNo, source, tokens })
  }

  const visit = (file: SourceFile, depth: number): void => {
    const lines = file.text.split(/\r?\n/)
    let defining: Macro | null = null
    let defLine = 0
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!
      const lineNo = i + 1
      const here = { file: file.name, line: lineNo }
      const raw = tokenize(text)
      const first = raw[0]

      if (defining) {
        if (first?.kind === 'dir' && first.text === '.end_macro') {
          const list = macros.get(defining.name) ?? []
          list.push(defining)
          macros.set(defining.name, list)
          defining = null
        } else if (first?.kind === 'dir' && first.text === '.macro') {
          diags.error(here, first.col, 'nested-macro', L('宏定义里不能再定义宏', 'A macro cannot be defined inside another macro'))
        } else defining.body.push({ tokens: raw, text })
        continue
      }

      if (first?.kind === 'dir' && first.text === '.macro') {
        const nameTok = raw[1]
        if (!nameTok || nameTok.kind !== 'ident') {
          diags.error(here, first.col, 'bad-macro', L('.macro 后面要跟宏的名字', '.macro must be followed by the macro name'))
          continue
        }
        const params = raw.slice(2).filter((t) => t.kind === 'marg').map((t) => t.text)
        defining = { name: nameTok.text, params, body: [] }
        defLine = lineNo
        continue
      }
      if (first?.kind === 'dir' && first.text === '.end_macro') {
        diags.error(here, first.col, 'bad-macro', L('.end_macro 前面没有对应的 .macro', '.end_macro without a matching .macro'))
        continue
      }
      if (first?.kind === 'dir' && first.text === '.eqv') {
        const nameTok = raw[1]
        if (!nameTok || nameTok.kind !== 'ident' || raw.length < 3) {
          diags.error(here, first.col, 'bad-eqv', L('.eqv 的写法是：.eqv 名字 替换内容', '.eqv is written as: .eqv name replacement'))
          continue
        }
        const lower = nameTok.text.toLowerCase()
        if (MNEMONICS.includes(lower) || KNOWN_DIRECTIVES.has(lower)) {
          // MARS refuses to redefine an instruction or directive through .eqv.
          diags.error(here, first.col, 'bad-eqv', L(`.eqv 不能用指令或伪操作的名字 "${nameTok.text}"`, `.eqv cannot use the instruction or directive name "${nameTok.text}"`))
          continue
        }
        eqv.set(nameTok.text, substituteEqv(raw.slice(2)))
        out.push({ file: file.name, line: lineNo, source: text, tokens: [] })
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
      emitLine(file.name, lineNo, text, substituteEqv(raw), 0)
    }
    if (defining) diags.error({ file: file.name, line: defLine }, 0, 'macro-unterminated', L('.macro 没有对应的 .end_macro', '.macro without a matching .end_macro'))
  }

  visit(main, 0)
  return out
}

/** After macro substitution a "%x" argument may have become a register or number; re-classify by text. */
function retokenize(tokens: Token[]): Token[] {
  return tokens.map((t) => {
    if (t.kind !== 'ident' && t.kind !== 'marg') return t
    const again = tokenize(t.text)
    return again.length === 1 ? { ...again[0]!, col: t.col } : t
  })
}

/* ------------------------------------------------------------------ passes 1 and 2 */

interface PendingInstr {
  line: Line
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

  const symbols = new Map<string, { addr: number; line: Line }>()
  const bytes = new Map<number, number>()
  const declarations: DataDeclaration[] = []
  const pending: PendingInstr[] = []
  const fixups: WordFixup[] = []

  const addr: Record<Segment, number> = { text: TEXT_BASE, data: DATA_BASE, ktext: KTEXT_BASE, kdata: KDATA_BASE }
  let externAddr = EXTERN_BASE
  let seg: Segment = 'text'
  let autoAlign = true
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
    const aligned = (a + n - 1) & ~(n - 1)
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

  /* ---------- pass 1 ---------- */
  for (const line of lines) {
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
    pending.push({ line, form: picked.form, operands: rest, addr: addr[seg], size, segment: seg })
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
    if (d === '.globl') return
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
    if (d === '.eqv' || d === '.macro' || d === '.end_macro' || d === '.include') return // handled in the pre-pass

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
            bytes.set(addr[seg], ch.charCodeAt(0) & 0xff)
            addr[seg] = (addr[seg] + 1) >>> 0
            count++
          }
          if (d === '.asciiz') {
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
        if (autoAlign && size > 1) alignTo(size)
        const start = addr[seg]
        let count = 0
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!
          let repeat = 1
          let hasRepeat = false
          if (args[i + 1]?.kind === 'colon' && args[i + 2]?.kind === 'int') {
            repeat = Math.max(0, args[i + 2]!.value!)
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
              putBytes(addr[seg], v, size)
              addr[seg] = (addr[seg] + size) >>> 0
              count++
            }
          } else if (a.kind === 'ident' && !hasRepeat) {
            // MARS truncates a label to the low 8/16/32 bits of its address without a warning.
            fixups.push({ line, token: a, addr: addr[seg], size })
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
          if (args[i + 1]?.kind === 'colon' && args[i + 2]?.kind === 'int') {
            repeat = Math.max(0, args[i + 2]!.value!)
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
            if (size === 4) putBytes(addr[seg], bitsFromFloat(v), 4)
            else {
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

  if (diags.errors > 0) return { ok: false, diagnostics: diags.list, program: null }

  /* ---------- pass 2 ---------- */
  const lookup = (line: Line, tok: Token): number | null => {
    const s = symbols.get(tok.text)
    if (!s) {
      diags.error(line, tok.col, 'undefined-symbol', L(`找不到符号 "${tok.text}"`, `Symbol "${tok.text}" not found`), tok.text.length)
      return null
    }
    return s.addr
  }

  for (const f of fixups) {
    const v = lookup(f.line, f.token)
    if (v != null) putBytes(f.addr, v, f.size)
  }

  const labelAt = new Map<number, string>()
  for (const [name, s] of symbols) if (!labelAt.has(s.addr)) labelAt.set(s.addr, name)

  const instructions: ProgramInstruction[] = []
  for (const p of pending) {
    const values = operandValues(p, lookup)
    if (!values) continue
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
      case 'tgt':
        fields.target = ((a as number) >>> 2) & 0x3ffffff
        break
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
