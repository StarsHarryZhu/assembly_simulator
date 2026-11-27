/**
 * Tokens of GNU as for AArch64, as LLVM's integrated assembler reads them.
 *
 * Statements are split, and comments removed, before tokenizing (see splitStatements). Registers are plain
 * identifiers here: an operand type decides whether `x0` or `v1.4s` is the register it wants.
 */
import { L } from '../../core/i18n'
import { parseFloatBits } from './fpformat'
import { F64 } from './softfloat'

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
  /** bad: why; str: a bad escape inside it. */
  error?: string
}

const PUNCT2 = ['<<', '>>', '<=', '>=', '==', '!=', '<>', '&&', '||']
const PUNCT1 = '#,[]{}!()+-*/%&|^~:=<>@'
const IDENT_START = /[A-Za-z_.$]/
const IDENT_CHAR = /[A-Za-z0-9_.$]/

/**
 * One escape inside "..." (s[i] is the character after the backslash), as LLVM reads it: \b \f \n \r \t \"
 * \\, up to three octal digits (at most \377), or \x and any number of hex digits (the low byte is kept).
 * Anything else is an error.
 */
function escape(s: string, i: number): { bytes: number[]; next: number; error?: string } {
  const c = s[i]!
  const simple: Record<string, number> = { b: 8, f: 12, n: 10, r: 13, t: 9, '\\': 92, '"': 34 }
  if (c in simple) return { bytes: [simple[c]!], next: i + 1 }
  if (c === 'x' || c === 'X') {
    let j = i + 1
    while (j < s.length && /[0-9a-fA-F]/.test(s[j]!)) j++
    if (j === i + 1) return { bytes: [], next: j, error: L('\\x 后面要写十六进制数字', 'Expected hex digits after \\x') }
    return { bytes: [parseInt(s.slice(Math.max(i + 1, j - 2), j), 16)], next: j }
  }
  if (/[0-7]/.test(c)) {
    let j = i
    while (j < s.length && j < i + 3 && /[0-7]/.test(s[j]!)) j++
    const v = parseInt(s.slice(i, j), 8)
    if (v > 255) return { bytes: [], next: j, error: L(`八进制转义 \\${s.slice(i, j)} 超过了 \\377`, `Octal escape \\${s.slice(i, j)} is above \\377`) }
    return { bytes: [v], next: j }
  }
  return { bytes: [], next: i + 1, error: L(`不认识的转义 \\${c}（可以用 \\n \\t \\r \\b \\f \\" \\\\、八进制或 \\x）`, `Unknown escape \\${c} (use \\n \\t \\r \\b \\f \\" \\\\, octal or \\x)`) }
}

/** UTF-8 bytes of the characters from i up to the closing quote, and the first bad escape. */
function stringBody(s: string, i: number, quote: string): { bytes: number[]; next: number; closed: boolean; error?: string } {
  const bytes: number[] = []
  let error: string | undefined
  while (i < s.length) {
    const c = s[i]!
    if (c === quote) return { bytes, next: i + 1, closed: true, error }
    if (c === '\\' && i + 1 < s.length) {
      const e = escape(s, i + 1)
      bytes.push(...e.bytes)
      error ??= e.error
      i = e.next
      continue
    }
    const cp = s.codePointAt(i)!
    bytes.push(...new TextEncoder().encode(String.fromCodePoint(cp)))
    i += cp > 0xffff ? 2 : 1
  }
  return { bytes, next: i, closed: false, error }
}

/** Escapes in a character constant '\\c': these few, and otherwise the character itself ('\\0' is '0'). */
const CHAR_ESCAPES: Record<string, number> = { "'": 39, t: 9, n: 10, b: 8, f: 12, r: 13 }

/** A float literal starting a number: 1.5, 1., 2e3, 1e (exponent 0), .5 and hex floats 0x1.8p3. */
const FLOAT = /^(?:0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)[pP][-+]?\d+|\d+\.\d*(?:[eE][-+]?\d*)?|\d+[eE][-+]?\d*|\.\d+(?:[eE][-+]?\d*)?)(?![A-Za-z0-9_$])/

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
      // A bad escape is reported where the string's bytes are used.
      out.push({ kind: 'str', text: s.slice(i, b.next), col, bytes: b.bytes, error: b.error })
      i = b.next
      continue
    }
    if (c === "'") {
      // 'c' or '\\c', with the closing quote (LLVM; GNU as also takes 'c alone). Only ASCII fits.
      let j = i + 1
      let v: number | null = null
      if (j < s.length) {
        const escaped = s[j] === '\\' && j + 1 < s.length
        if (escaped) j++
        const ch = s[j]!
        v = escaped && ch in CHAR_ESCAPES ? CHAR_ESCAPES[ch]! : ch.charCodeAt(0)
        j++
      }
      if (v === null || v > 0x7f || s[j] !== "'") {
        const end = s.indexOf("'", i + 1)
        const text = end > i ? s.slice(i, end + 1) : s.slice(i)
        out.push({ kind: 'bad', text, col, error: L("字符常量要写成 'c'（一个 ASCII 字符，前后都有单引号）", "A character constant is written 'c' (one ASCII character between single quotes)") })
        i += text.length
        continue
      }
      out.push({ kind: 'num', text: s.slice(i, j + 1), col, value: BigInt(v) })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const rest = s.slice(i)
      // A numeric local label reference: 1b, 2f (lower case; 0b101 is binary).
      const local = /^(\d+)([bf])(?![A-Za-z0-9_.$])/.exec(rest)
      if (local) {
        out.push({ kind: 'local', text: local[0], col, value: BigInt(local[1]!), dir: local[2] as 'b' | 'f' })
        i += local[0].length
        continue
      }
      const fl = FLOAT.exec(rest)
      if (fl) {
        out.push({ kind: 'float', text: fl[0], col, fnum: floatNumber(fl[0]) })
        i += fl[0].length
        continue
      }
      if (c === '.') {
        // .5abc is an identifier.
        let j = i + 1
        while (j < s.length && IDENT_CHAR.test(s[j]!)) j++
        out.push({ kind: 'ident', text: s.slice(i, j), col })
        i = j
        continue
      }
      const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)([A-Za-z0-9_$]*)/.exec(rest)!
      if (m[2]) {
        out.push({ kind: 'bad', text: m[0], col, error: L(`数字写法不对：${m[0]}`, `Malformed number: ${m[0]}`) })
        i += m[0].length
        continue
      }
      const t = m[1]!
      let value: bigint
      if (/^0[0-7]+$/.test(t)) value = BigInt('0o' + t.slice(1))
      else if (/^0\d+$/.test(t)) {
        out.push({ kind: 'bad', text: t, col, error: L(`八进制数里不能有 8 或 9：${t}`, `Octal number with digit 8 or 9: ${t}`) })
        i += t.length
        continue
      } else value = BigInt(t)
      // Kept exact: expressions refuse values of more than 64 bits, .octa takes 128.
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

/** The double nearest a float literal (hex floats included). */
function floatNumber(text: string): number {
  const bits = parseFloatBits(text, F64)
  if (bits === null) return NaN
  const v = new DataView(new ArrayBuffer(8))
  v.setBigUint64(0, bits)
  return v.getFloat64(0)
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
