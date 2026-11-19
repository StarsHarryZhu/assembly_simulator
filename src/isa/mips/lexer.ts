/**
 * Line tokenizer. Token classes follow the MARS assembler, because operand matching depends on them:
 * an integer's class is decided by its value (0..31, 32..65535, -32768..-1, everything else).
 */
import { parseFpr, parseGpr } from './registers'

export type TokKind =
  | 'ident' // label, mnemonic, macro name, .eqv name
  | 'dir' // .word
  | 'reg' // $t0, $8
  | 'freg' // $f0
  | 'int'
  | 'real'
  | 'str'
  | 'lparen'
  | 'rparen'
  | 'plus'
  | 'colon'
  | 'marg' // %name inside a macro
  | 'bad'

/** MARS integer classes. */
export type IntClass = 'i5' | 'i16u' | 'i16' | 'i32'

export interface Token {
  kind: TokKind
  text: string
  /** 1-based column of the first character. */
  col: number
  /** Integer value (int32) for 'int'; register number for 'reg'/'freg'. */
  value?: number
  /** Parsed value for 'real' (double). */
  real?: number
  /** Decoded contents for 'str'. */
  str?: string
  intClass?: IntClass
  /** Set for 'reg' when written as a number ($8) rather than a name ($t0). */
  numeric?: boolean
}

export function classifyInt(v: number): IntClass {
  if (v >= 0 && v <= 31) return 'i5'
  if (v >= 0 && v <= 65535) return 'i16u'
  if (v >= -32768 && v <= 32767) return 'i16'
  return 'i32'
}

/**
 * Java Integer.decode plus MARS's fallback for 8-digit hex: "010" is octal, "0xFFFFFFFF" is -1,
 * "-0x8000" is -32768. Returns null for anything else.
 */
export function parseInteger(text: string): number | null {
  let s = text
  let neg = false
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-'
    s = s.slice(1)
  }
  if (s === '') return null
  let radix = 10
  if (/^0[xX]/.test(s)) {
    radix = 16
    s = s.slice(2)
  } else if (s[0] === '#') {
    radix = 16
    s = s.slice(1)
  } else if (s.length > 1 && s[0] === '0') {
    radix = 8
    s = s.slice(1)
  }
  const digits = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/
  if (!digits.test(s)) return null
  const big = BigInt((radix === 16 ? '0x' : radix === 8 ? '0o' : '') + s)
  const value = neg ? -big : big
  if (value >= -2147483648n && value <= 2147483647n) return Number(value)
  // MARS accepts exactly 8 hex digits as a 32-bit two's complement pattern.
  if (!neg && radix === 16 && s.length === 8) return Number(BigInt.asIntN(32, value))
  // ... and unsigned decimal up to 0xFFFFFFFF as the same bit pattern (2147483648 -> -2147483648).
  // MARS silently wraps anything larger modulo 2^32; we reject that instead of hiding the overflow.
  if (!neg && radix === 10 && value <= 4294967295n) return Number(BigInt.asIntN(32, value))
  return null
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
}

function unescape(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '\\' && i + 1 < body.length) {
      const next = body[i + 1]!
      if (next in ESCAPES) {
        out += ESCAPES[next]
        i++
        continue
      }
    }
    out += ch
  }
  return out
}

const REAL = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$|^[+-]?(?:Infinity|NaN)$/

const isIdentStart = (c: string) => /[A-Za-z_.$]/.test(c)
const isIdentChar = (c: string) => /[A-Za-z0-9_.$]/.test(c)

/**
 * A '+' starts a signed number only where an operand may start: at the beginning of the line,
 * after a comma or '(', or directly after a directive. Elsewhere it is the binary plus operator
 * (",$zero,+5" is +5, while "label +4" keeps its plus token and still matches the label+constant
 * pseudo forms).
 */
function atOperandStart(line: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && (line[j] === ' ' || line[j] === '\t')) j--
  if (j < 0) return true
  const prev = line[j]!
  if (prev === ',' || prev === '(') return true
  let k = j
  while (k >= 0 && isIdentChar(line[k]!)) k--
  return /^\.[A-Za-z_]/.test(line.slice(k + 1, j + 1))
}

function wordToken(text: string, col: number): Token {
  if (text[0] === '$') {
    const g = parseGpr(text)
    if (g >= 0) return { kind: 'reg', text, col, value: g, numeric: /^\$\d+$/.test(text) }
    const f = parseFpr(text)
    if (f >= 0) return { kind: 'freg', text, col, value: f }
    return { kind: 'ident', text, col }
  }
  if (text[0] === '.' && /^\.[A-Za-z_]/.test(text)) return { kind: 'dir', text: text.toLowerCase(), col }
  const n = parseInteger(text)
  if (n != null) return { kind: 'int', text, col, value: n, intClass: classifyInt(n) }
  if (REAL.test(text)) return { kind: 'real', text, col, real: Number(text) }
  if (/^[-+]?[0-9]/.test(text)) return { kind: 'bad', text, col }
  return { kind: 'ident', text, col }
}

/** Tokenize one line. Comments are dropped; commas and whitespace separate tokens. */
export function tokenize(line: string): Token[] {
  const out: Token[] = []
  let i = 0
  const n = line.length
  while (i < n) {
    const c = line[i]!
    const col = i + 1
    if (c === '#') break
    if (c === ' ' || c === '\t' || c === ',' || c === '\r' || c === '\f') {
      i++
      continue
    }
    if (c === '(') {
      out.push({ kind: 'lparen', text: c, col })
      i++
      continue
    }
    if (c === ')') {
      out.push({ kind: 'rparen', text: c, col })
      i++
      continue
    }
    if (c === ':') {
      out.push({ kind: 'colon', text: c, col })
      i++
      continue
    }
    if (c === '+') {
      // A signed number (+5, +1.5) at an operand start; otherwise the plus operator.
      const signed = atOperandStart(line, i) && /[0-9.]/.test(line[i + 1] ?? '')
      if (!signed) {
        out.push({ kind: 'plus', text: c, col })
        i++
        continue
      }
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && line[j] !== '"') {
        if (line[j] === '\\') j++
        j++
      }
      const body = line.slice(i + 1, Math.min(j, n))
      out.push({ kind: 'str', text: line.slice(i, Math.min(j + 1, n)), col, str: unescape(body) })
      i = j + 1
      continue
    }
    if (c === "'") {
      // Character literal: 'a', '\n'. MARS turns it into an integer.
      const m = /^'(\\.|[^'\\])'/.exec(line.slice(i))
      if (m) {
        const ch = unescape(m[1]!)
        const v = ch.charCodeAt(0)
        out.push({ kind: 'int', text: m[0], col, value: v, intClass: classifyInt(v) })
        i += m[0].length
        continue
      }
      out.push({ kind: 'bad', text: "'", col })
      i++
      continue
    }
    if (c === '%') {
      let j = i + 1
      while (j < n && isIdentChar(line[j]!)) j++
      out.push({ kind: 'marg', text: line.slice(i, j), col })
      i = j
      continue
    }
    // A word: identifier, register, directive, or number (numbers may carry a sign and an exponent).
    let j = i
    if (c === '-' || c === '+') j++
    while (j < n) {
      const d = line[j]!
      if (isIdentChar(d)) {
        j++
        continue
      }
      // exponent sign inside a real number: 1.5e-3
      if ((d === '-' || d === '+') && /[eE]$/.test(line.slice(i, j)) && /^[-+]?\d/.test(line.slice(i, j))) {
        j++
        continue
      }
      break
    }
    if (j === i || (c === '-' && j === i + 1)) {
      out.push({ kind: 'bad', text: c, col })
      i++
      continue
    }
    const text = line.slice(i, j)
    if (!isIdentStart(text[0]!) && !/^[-+]?[0-9]/.test(text) && text[0] !== '-') {
      out.push({ kind: 'bad', text, col })
    } else out.push(wordToken(text, col))
    i = j
  }
  return out
}
