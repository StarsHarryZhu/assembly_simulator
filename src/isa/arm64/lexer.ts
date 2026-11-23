/**
 * Tokens of GNU as for AArch64, as LLVM's integrated assembler reads them.
 *
 * Statements are split, and comments removed, before tokenizing (see splitStatements). Registers are plain
 * identifiers here: an operand type decides whether `x0` or `v1.4s` is the register it wants.
 */
import { L } from '../../core/i18n'

export type TokKind = 'ident' | 'num' | 'float' | 'str' | 'local' | 'punct' | 'bad'

export interface Tok {
  kind: TokKind
  /** As written (strings: with their quotes). */
  text: string
  /** 1-based column in the source line. */
  col: number
  /** num: the value; local: the label number. */
  value?: bigint
  /** float: the value. */
  fnum?: number
  /** local: `1b` looks back, `1f` forward. */
  dir?: 'b' | 'f'
  /** str: the bytes, escapes resolved. */
  bytes?: number[]
  /** bad: why. */
  error?: string
}

const PUNCT2 = ['<<', '>>', '<=', '>=', '==', '!=', '<>', '&&', '||']
const PUNCT1 = '#,[]{}!()+-*/%&|^~:=<>@'
const IDENT_START = /[A-Za-z_.$]/
const IDENT_CHAR = /[A-Za-z0-9_.$]/

/** Escapes inside "..." and '...'. Returns the byte values and the index after the escape. */
function escape(s: string, i: number): { bytes: number[]; next: number } {
  const c = s[i]!
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, e: 27, '\\': 92, '"': 34, "'": 39 }
  if (c in simple) return { bytes: [simple[c]!], next: i + 1 }
  if (c === 'x' || c === 'X') {
    let j = i + 1
    while (j < s.length && /[0-9a-fA-F]/.test(s[j]!)) j++
    const v = parseInt(s.slice(i + 1, j) || '0', 16)
    return { bytes: [v & 0xff], next: j }
  }
  if (/[0-7]/.test(c)) {
    let j = i
    while (j < s.length && j < i + 3 && /[0-7]/.test(s[j]!)) j++
    return { bytes: [parseInt(s.slice(i, j), 8) & 0xff], next: j }
  }
  return { bytes: [...new TextEncoder().encode(c)], next: i + 1 }
}

/** UTF-8 bytes of the characters from i up to the closing quote. */
function stringBody(s: string, i: number, quote: string): { bytes: number[]; next: number; closed: boolean } {
  const bytes: number[] = []
  while (i < s.length) {
    const c = s[i]!
    if (c === quote) return { bytes, next: i + 1, closed: true }
    if (c === '\\' && i + 1 < s.length) {
      const e = escape(s, i + 1)
      bytes.push(...e.bytes)
      i = e.next
      continue
    }
    const cp = s.codePointAt(i)!
    bytes.push(...new TextEncoder().encode(String.fromCodePoint(cp)))
    i += cp > 0xffff ? 2 : 1
  }
  return { bytes, next: i, closed: false }
}

/** Tokenize one statement (no comments). `offset` is the statement's start column minus one. */
export function tokenize(s: string, offset = 0): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    const col = offset + i + 1
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++
      continue
    }
    if (c === '"') {
      const b = stringBody(s, i + 1, '"')
      if (!b.closed) {
        out.push({ kind: 'bad', text: s.slice(i), col, error: L('字符串缺少结尾的引号', 'Unterminated string') })
        return out
      }
      out.push({ kind: 'str', text: s.slice(i, b.next), col, bytes: b.bytes })
      i = b.next
      continue
    }
    if (c === "'") {
      // 'a' (LLVM) or 'a (GNU as): a character's value.
      let j = i + 1
      let v = 0
      if (s[j] === '\\' && j + 1 < s.length) {
        const e = escape(s, j + 1)
        v = e.bytes[0] ?? 0
        j = e.next
      } else if (j < s.length) {
        const cp = s.codePointAt(j)!
        v = cp
        j += cp > 0xffff ? 2 : 1
      } else {
        out.push({ kind: 'bad', text: s.slice(i), col, error: L('字符常量不完整', 'Incomplete character constant') })
        return out
      }
      if (s[j] === "'") j++
      out.push({ kind: 'num', text: s.slice(i, j), col, value: BigInt(v) })
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      const rest = s.slice(i)
      // A numeric local label reference: 1b, 2f (but 0b101 is binary).
      const local = /^(\d+)([bfBF])(?![A-Za-z0-9_.$])/.exec(rest)
      if (local && !/^0[bB][01]/.test(rest)) {
        out.push({ kind: 'local', text: local[0], col, value: BigInt(local[1]!), dir: local[2]!.toLowerCase() as 'b' | 'f' })
        i += local[0].length
        continue
      }
      const fl = /^(\d+\.\d*([eE][-+]?\d+)?|\d+[eE][-+]?\d+)(?![A-Za-z0-9_$])/.exec(rest)
      if (fl) {
        out.push({ kind: 'float', text: fl[0], col, fnum: Number(fl[0]) })
        i += fl[0].length
        continue
      }
      const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)([A-Za-z0-9_$]*)/.exec(rest)!
      if (m[2]) {
        out.push({ kind: 'bad', text: m[0], col, error: L(`数字写法不对：${m[0]}`, `Malformed number: ${m[0]}`) })
        i += m[0].length
        continue
      }
      const t = m[1]!
      let value: bigint
      if (/^0[oO]/.test(t)) value = BigInt('0o' + t.slice(2))
      else if (/^0[0-7]+$/.test(t)) value = BigInt('0o' + t.slice(1))
      else if (/^0\d+$/.test(t)) {
        out.push({ kind: 'bad', text: t, col, error: L(`八进制数里不能有 8 或 9：${t}`, `Octal number with digit 8 or 9: ${t}`) })
        i += t.length
        continue
      } else value = BigInt(t)
      out.push({ kind: 'num', text: t, col, value })
      i += t.length
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < s.length && IDENT_CHAR.test(s[j]!)) j++
      out.push({ kind: 'ident', text: s.slice(i, j), col })
      i = j
      continue
    }
    const two = s.slice(i, i + 2)
    if (PUNCT2.includes(two)) {
      out.push({ kind: 'punct', text: two, col })
      i += 2
      continue
    }
    if (PUNCT1.includes(c)) {
      out.push({ kind: 'punct', text: c, col })
      i++
      continue
    }
    out.push({ kind: 'bad', text: c, col, error: L(`不认识的字符 "${c}"`, `Unexpected character "${c}"`) })
    i++
  }
  return out
}

/** One statement of a source line: its text and where it starts. */
export interface Statement {
  /** The statement with comments blanked out; columns match the source line. */
  text: string
  /** 1-based column of the first character of `text`. */
  col: number
}

/**
 * Split a line into statements and blank out its comments: `//` to the end of the line, `#` as the first
 * text of a line, and `/* … *\/` (which may continue from the previous line: `inBlock`). `;` separates
 * statements. Quotes are respected. Returns the statements and whether a block comment is still open.
 */
export function splitStatements(line: string, inBlock: boolean): { statements: Statement[]; inBlock: boolean } {
  const chars = line.split('')
  const cuts: number[] = []
  let end = line.length
  let quote = ''
  if (!inBlock && /^\s*#/.test(line)) return { statements: [], inBlock }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (inBlock) {
      if (line.startsWith('*/', i)) {
        chars[i] = chars[i + 1] = ' '
        i++
        inBlock = false
      } else chars[i] = ' '
      continue
    }
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"') quote = c
    else if (c === "'") {
      // A character constant: skip the next character (or escape) and an optional closing quote.
      i += line[i + 1] === '\\' ? 2 : 1
      if (line[i + 1] === "'") i++
    } else if (line.startsWith('//', i)) {
      end = i
      break
    } else if (line.startsWith('/*', i)) {
      chars[i] = chars[i + 1] = ' '
      i++
      inBlock = true
    } else if (c === ';') cuts.push(i)
  }
  const statements: Statement[] = []
  let from = 0
  for (const to of [...cuts, end]) {
    const text = chars.slice(from, to).join('')
    if (text.trim()) statements.push({ text, col: from + 1 })
    from = to + 1
  }
  return { statements, inBlock }
}
