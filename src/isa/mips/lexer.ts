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

/**
 * The directives MARS knows. Any other word that starts with a dot (".L1") is an identifier, as in
 * MARS: it can name a label and be used as an operand.
 */
export const DIRECTIVE_NAMES: ReadonlySet<string> = new Set([
  '.word',
  '.half',
  '.byte',
  '.ascii',
  '.asciiz',
  '.space',
  '.float',
  '.double',
  '.align',
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
 * Java Integer.decode plus MARS's fallbacks: "010" is octal but "08" is decimal 8, "0xFFFFFFFF" is -1,
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
  if (!digits.test(s)) {
    // MARS reads a leading zero that does not start an octal number ("08", "0189") as decimal.
    if (radix !== 8 || neg || !/^[0-9]+$/.test(s)) return null
    radix = 10
  }
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
      // An unknown escape ("\q", "\101", "\x41") keeps only the character after the backslash, as in MARS.
      const next = body[i + 1]!
      out += ESCAPES[next] ?? next
      i++
      continue
    }
    out += ch
  }
  return out
}

/**
 * num / den (both positive) rounded once, ties to even, to a binary format with `bits` significant
 * bits and exponents emin..emax (subnormals below emin, Infinity above emax).
 */
function roundRatio(num: bigint, den: bigint, bits: number, emin: number, emax: number): number {
  if (num === 0n) return 0
  let e = num.toString(2).length - den.toString(2).length
  // Now 2^(e-1) < num/den < 2^(e+1); make it 2^e <= num/den < 2^(e+1).
  if (e >= 0 ? num < den << BigInt(e) : num << BigInt(-e) < den) e--
  if (e > emax) return Infinity
  e = Math.max(e, emin)
  const shift = bits - 1 - e
  const n = shift >= 0 ? num << BigInt(shift) : num
  const d = shift >= 0 ? den : den << BigInt(-shift)
  let q = n / d
  const r2 = 2n * (n - q * d)
  if (r2 > d || (r2 === d && (q & 1n) === 1n)) q++
  // q < 2^53, so this product is exact; a carry out of the top bit may still overflow the format.
  const v = Number(q) * 2 ** -shift
  return v >= 2 ** emax * 2 ? Infinity : v
}

const SINGLE = [24, -126, 127] as const
const DOUBLE = [53, -1022, 1023] as const

/**
 * Java's Float/Double.parseFloat: decimal or exponent forms, NaN, Infinity, an optional f/d suffix, and
 * hexadecimal floating point (0x1.8p3 = 12.0), whose binary exponent is required. Like Java, a float is
 * rounded straight from the text: rounding to a double first and then to a float can land on the wrong
 * side of a halfway point (3.4028235677973366e38 is the largest float, not Infinity). MARS reads real
 * literals in the source the same way (as doubles), so ".float 1.5f" and ".double 0x1p3" are fine.
 */
export function parseJavaReal(t: string, single = false): number | null {
  if (/^[+-]?(NaN|Infinity)$/.test(t)) return Number(t)
  const [bits, emin, emax] = single ? SINGLE : DOUBLE
  const hexFloat = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)[fFdD]?$/.exec(t)
  if (hexFloat) {
    const [, sign, whole = '', frac = '', exp] = hexFloat
    if (!whole && !frac) return null
    const mantissa = BigInt('0x' + (whole + frac || '0'))
    const scale = Number(exp) - 4 * frac.length
    const top = mantissa.toString(2).length + scale
    let v: number
    if (mantissa === 0n || top < emin - bits - 1) v = 0
    else if (top > emax + 2) v = Infinity
    else v = scale >= 0 ? roundRatio(mantissa << BigInt(scale), 1n, bits, emin, emax) : roundRatio(mantissa, 1n << BigInt(-scale), bits, emin, emax)
    return sign === '-' ? -v : v
  }
  const dec = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?[fFdD]?$/.exec(t)
  if (!dec || !(dec[2] || dec[3])) return null
  // JavaScript reads decimal text as a correctly rounded double.
  const d = Number(t.replace(/[fFdD]$/, ''))
  if (!single) return d
  const f = Math.fround(d)
  // Only a double that is exactly halfway between two floats can round the wrong way; it is finite and
  // inside the float range, so the exact decimal value stays a modest BigInt.
  if (f === d || !Number.isFinite(d) || Math.abs(d) > 3.5e38 || Math.abs(d) < 1e-46) return f
  const [, sign, whole = '', frac = '', exp = '0'] = dec
  const digits = BigInt(whole + frac || '0')
  const scale = Number(exp) - frac.length
  const v = scale >= 0 ? roundRatio(digits * 10n ** BigInt(scale), 1n, bits, emin, emax) : roundRatio(digits, 10n ** BigInt(-scale), bits, emin, emax)
  return sign === '-' ? -v : v
}


// Letters of any script count, as in MARS (Java's Character.isLetter): "Ünï:" and "标签:" are labels.
const isIdentStart = (c: string) => /[\p{L}_.$]/u.test(c)
const isIdentChar = (c: string) => /[\p{L}\p{Nd}_.$]/u.test(c)

function wordToken(text: string, col: number): Token {
  if (text[0] === '$') {
    const g = parseGpr(text)
    if (g >= 0) return { kind: 'reg', text, col, value: g, numeric: /^\$\d+$/.test(text) }
    const f = parseFpr(text)
    if (f >= 0) return { kind: 'freg', text, col, value: f }
    return { kind: 'ident', text, col }
  }
  if (text[0] === '.' && DIRECTIVE_NAMES.has(text.toLowerCase())) return { kind: 'dir', text: text.toLowerCase(), col }
  const n = parseInteger(text)
  if (n != null) return { kind: 'int', text, col, value: n, intClass: classifyInt(n) }
  const real = parseJavaReal(text)
  if (real != null) return { kind: 'real', text, col, real }
  if (/^[-+]?[0-9]/.test(text)) return { kind: 'bad', text, col }
  return { kind: 'ident', text, col }
}

/**
 * Tokenize one line. Comments are dropped; commas and whitespace separate tokens. As in MARS, a sign
 * right after a label is the binary operator ("d0-1" is d0, "-", 1, which no form accepts, and "d0+1"
 * is d0, "+", 1), while anywhere else it belongs to the number ("4-1" is 4 and -1). Mnemonics count as
 * operators, not labels: by default the word that starts the statement is taken to be one.
 */
export function tokenize(line: string, isOperator?: (word: string) => boolean): Token[] {
  const raw = tokenizeRaw(line)
  return splitSigns(raw, isOperator ?? ((_, i) => i === statementHead(raw)))
}

/** Index of the statement's first word, after an optional "label:". */
function statementHead(tokens: Token[]): number {
  return tokens.length >= 2 && tokens[0]!.kind === 'ident' && tokens[1]!.kind === 'colon' ? 2 : 0
}

/**
 * Split the sign off a signed number that follows a label (an identifier that is not an operator).
 * Run it on the final tokens of a statement: after .eqv and macro substitution the word before a sign
 * may have changed ("N-1" with N = 5 is 5 and -1, as MARS substitutes text before tokenizing).
 */
export function splitSigns(tokens: Token[], isOperator: (word: string, index: number) => boolean): Token[] {
  let out: Token[] | null = null
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const prev = tokens[i - 1]
    if ((t.kind === 'int' || t.kind === 'real') && (t.text[0] === '-' || t.text[0] === '+') && prev?.kind === 'ident' && !isOperator(prev.text, i - 1)) {
      out ??= tokens.slice(0, i)
      out.push(t.text[0] === '+' ? { kind: 'plus', text: '+', col: t.col } : { kind: 'bad', text: '-', col: t.col }, wordToken(t.text.slice(1), t.col + 1))
    } else out?.push(t)
  }
  return out ?? tokens
}

/** Is this 'bad' token one MARS rejects while reading the source (rather than in an operand)? */
export function isLexical(t: Token): boolean {
  // A lone "-" is MARS's minus operator, and an unterminated string is our own (stricter) error.
  return t.kind === 'bad' && t.text !== '-' && t.text[0] !== '"'
}

/**
 * Words MARS cannot read at all: a malformed character literal, a word that starts with a digit but is no
 * number ("1L", "0x", "1e5x"), or one with a character outside the language ("a&b", "[5]", ";"). MARS
 * reports these before assembling anything, at the start of the word: its words run up to whitespace,
 * a comma, a parenthesis, a colon, a quote, a sign or a comment.
 */
export function lexicalErrors(line: string, tokens: Token[]): { col: number; text: string }[] {
  const out: { col: number; text: string }[] = []
  const delim = (c: string) => /[\s,():#"'+-]/.test(c)
  for (const t of tokens) {
    if (!isLexical(t)) continue
    if (t.text[0] === "'") {
      out.push({ col: t.col, text: t.text })
      continue
    }
    let a = t.col - 1
    while (a > 0 && !delim(line[a - 1]!)) a--
    let b = t.col - 1 + t.text.length
    while (b < line.length && !delim(line[b]!)) b++
    if (out[out.length - 1]?.col !== a + 1) out.push({ col: a + 1, text: line.slice(a, b) })
  }
  return out
}

/** Tokenize without deciding what a sign after a label means (see splitSigns). */
export function tokenizeRaw(line: string): Token[] {
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
    // A sign belongs to a number only when a digit follows at once ("-.5", "-x" and "- 1" are a lone sign).
    if ((c === '+' || c === '-') && !/[0-9]/.test(line[i + 1] ?? '')) {
      out.push(c === '+' ? { kind: 'plus', text: c, col } : { kind: 'bad', text: c, col })
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && line[j] !== '"') {
        if (line[j] === '\\') j++
        j++
      }
      // Without a closing quote MARS quietly drops the string's last character; here it is an error.
      if (j >= n) {
        out.push({ kind: 'bad', text: line.slice(i), col })
        i = n
        continue
      }
      out.push({ kind: 'str', text: line.slice(i, j + 1), col, str: unescape(line.slice(i + 1, j)) })
      i = j + 1
      continue
    }
    if (c === "'") {
      // Character literal: 'a', '\n', '\101'. MARS turns it into an integer. Unlike strings, it knows only
      // the escapes \n \t \r \b \f \0 \\ \' \" and three octal digits; '\q' and '\x41' are errors.
      // How much of the line MARS takes as the literal (observed): with fewer than two characters left, or
      // right after an empty '', the word simply runs on to the next separator; otherwise it ends at the
      // closing quote (not one after a backslash) or after at most six characters.
      const left = n - i - 1
      let j: number
      if (left < 2 || line[i + 1] === "'") {
        j = Math.min(n, i + (left < 2 ? 1 : 2))
        while (j < n && !/[\s,():#"']/.test(line[j]!)) j++
      } else if ((line[i + 2] === "'" && line[i + 1] !== '\\') || left === 2) j = i + 3
      else if (line[i + 3] === "'" || left === 3) j = i + 4
      else j = left < 5 ? i + 4 : line[i + 4] === "'" ? i + 5 : i + 6
      const text = line.slice(i, j)
      const m = /^'(\\[0-3][0-7][0-7]|\\[ntrbf0\\'"]|[^'\\])'$/.exec(text)
      if (m) {
        const body = m[1]!
        const v = /^\\\d{3}$/.test(body) ? parseInt(body.slice(1), 8) : unescape(body).charCodeAt(0)
        out.push({ kind: 'int', text, col, value: v, intClass: classifyInt(v) })
      } else out.push({ kind: 'bad', text, col })
      i = j
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
      // exponent sign inside a real number: 1.5e-3, or 0x1.8p-3 in hexadecimal
      const sofar = line.slice(i, j)
      const hexReal = /^[-+]?0[xX]/.test(sofar)
      if ((d === '-' || d === '+') && /^[-+]?\d/.test(sofar) && (hexReal ? /[pP]$/ : /[eE]$/).test(sofar)) {
        j++
        continue
      }
      break
    }
    if (j === i) {
      out.push({ kind: 'bad', text: c, col })
      i++
      continue
    }
    const text = line.slice(i, j)
    if (!isIdentStart(text[0]!) && !/^[-+]?[0-9]/.test(text)) {
      out.push({ kind: 'bad', text, col })
    } else out.push(wordToken(text, col))
    i = j
  }
  return out
}
