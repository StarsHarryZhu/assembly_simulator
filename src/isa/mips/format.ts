/**
 * The editor's Format command for MIPS: lays a program out the way the example programs are written.
 *
 * - Section directives and program-level directives (`.macro`, `.eqv`, `.globl`, …) start in the first column.
 * - In code, labels stand alone in the first column and statements are indented by 4. A label followed by an
 *   instruction or macro call is moved to its own line (a label before a directive stays, because MARS aligns
 *   the directive's data before it defines the label).
 * - In data, label, directive and values form three columns. The label column is as wide as the longest label
 *   in the block (consecutive non-blank lines) needs, at least 8 and a multiple of 4.
 * - A mnemonic or directive is padded to 8 columns. Operands get one space after each comma, none before it
 *   and none inside parentheses; other runs of blanks become one space. Quoted text never changes, and an
 *   `.eqv` value keeps its exact text, because MARS compares that text when the name is defined again.
 * - Trailing comments start at column 32, or at the next multiple of 4 after longer code. A comment on its own
 *   line keeps the first column, or else takes the indentation of the next line of code.
 *
 * Only whitespace changes (moving a label adds a line break), so the program assembles exactly as before.
 * Lines whose meaning could depend on spacing are left as written: an unclosed quote, two labels on a line.
 * Formatting twice gives the same text as formatting once.
 */
import { commentStart } from '../../core/source'
import { DIRECTIVE_NAMES } from './lexer'

const INDENT = 4
const HEAD = 8
const COMMENT = 32

const SECTIONS = new Map<string, 'code' | 'data'>([
  ['.text', 'code'],
  ['.ktext', 'code'],
  ['.data', 'data'],
  ['.kdata', 'data'],
])
/** Directives that belong to the program rather than a segment: always in the first column. */
const PROGRAM_LEVEL = new Set(['.macro', '.end_macro', '.eqv', '.include', '.globl', '.extern', '.set'])

/** The characters the assembler skips between tokens (commas aside). */
const BLANK = new Set([' ', '\t', '\r', '\f'])
const LEADING = /^[ \t\r\f]+/
const TRAILING = /[ \t\r\f]+$/
const LABEL = /^([A-Za-z_.$][\w.$]*)[ \t\r\f]*:/
const HEAD_WORD = /^[^ \t\r\f,()"']+/

/** CJK and full-width characters take two columns in a monospace font. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u

/** Columns a string takes on screen. */
export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += WIDE.test(ch) ? 2 : 1
  return w
}

interface Parsed {
  /** blank: nothing; keep: a quote never closes (left as written); note: only a comment; statement: code. */
  kind: 'blank' | 'keep' | 'note' | 'statement'
  text: string
  /** A note that did not start in the first column. */
  indented: boolean
  /** The label defined on the line, with its colon. */
  labels: string
  head: string
  /** Normalised operands. */
  rest: string
  /** The operands open with "(" right after the head: a macro call such as print_int($t0). */
  attached: boolean
  comment: string
}

/** Index of the quote that closes the one at `i`, or -1. */
function closingQuote(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === s[i]) return j
  }
  return -1
}

/** Operands with one space after each comma, none before a comma or ")" or after "(", or null for an open quote. */
function normaliseOperands(s: string): string | null {
  let out = ''
  let gap = false
  let comma = false
  let open = false
  const write = (t: string) => {
    if (out && (comma || (gap && !open))) out += ' '
    out += t
    gap = comma = false
    open = t === '('
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (BLANK.has(c)) gap = true
    else if (c === ',' || c === ')') {
      out += c
      gap = open = false
      comma = c === ','
    } else if (c === '"' || c === "'") {
      const end = closingQuote(s, i)
      if (end < 0) return null
      write(s.slice(i, end + 1))
      i = end
    } else write(c)
  }
  return out
}

/** `.eqv NAME value`: one space after the name, the value exactly as written. */
function eqvOperands(s: string): string {
  const t = s.replace(LEADING, '').replace(TRAILING, '')
  const m = /^([^ \t\r\f]+)[ \t\r\f]+([^]*)$/.exec(t)
  return m ? `${m[1]} ${m[2]}` : t
}

function parse(text: string): Parsed {
  const line: Parsed = { kind: 'statement', text, indented: false, labels: '', head: '', rest: '', attached: false, comment: '' }
  const cut = commentStart(text, '#')
  line.comment = text.slice(cut).replace(TRAILING, '')
  let code = text.slice(0, cut).replace(LEADING, '').replace(TRAILING, '')
  if (!code) {
    line.kind = line.comment ? 'note' : 'blank'
    line.indented = cut > 0
    return line
  }
  const label = LABEL.exec(code)
  if (label) {
    line.labels = label[1] + ':'
    code = code.slice(label[0].length).replace(LEADING, '')
    // MARS takes one label per line and reads a second "name:" as an instruction: leave such a line alone.
    if (LABEL.test(code)) {
      line.kind = 'keep'
      line.text = text.replace(TRAILING, '')
      return line
    }
  }
  line.head = HEAD_WORD.exec(code)?.[0] ?? ''
  const after = code.slice(line.head.length)
  line.attached = !!line.head && after.startsWith('(')
  const rest = line.head.toLowerCase() === '.eqv' ? eqvOperands(after) : normaliseOperands(after)
  if (rest == null) {
    line.kind = 'keep'
    line.text = text.replace(TRAILING, '')
    return line
  }
  line.rest = rest
  return line
}

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(1, width - displayWidth(text)))
const indent = (n: number) => ' '.repeat(n)
const leading = (text: string) => text.length - text.replace(/^ +/, '').length

function statement(l: Parsed): string {
  if (!l.head || !l.rest) return l.head + l.rest
  return l.attached ? l.head + l.rest : pad(l.head, HEAD) + l.rest
}

function withComment(code: string, comment: string): string {
  if (!comment) return code
  if (!code) return comment
  const w = displayWidth(code)
  return code + ' '.repeat(Math.max(COMMENT, Math.ceil((w + 1) / 4) * 4) - w) + comment
}

/** Lay a MIPS source out in the house style; see the file comment. */
export function formatSource(text: string): string {
  const lines = text.split('\n').map(parse)
  const lower = (l: Parsed) => l.head.toLowerCase()
  const programLevel = (l: Parsed) => l.kind === 'statement' && (SECTIONS.has(lower(l)) || PROGRAM_LEVEL.has(lower(l)))

  // The segment each line is in (programs start in code), and the label column of each data block.
  let segment: 'code' | 'data' = 'code'
  const segments = lines.map((l) => (l.kind === 'statement' ? (segment = SECTIONS.get(lower(l)) ?? segment) : segment))
  const labelColumn = lines.map(() => HEAD)
  for (let i = 0; i < lines.length; ) {
    const inBlock = (k: number) => lines[k]!.kind !== 'blank' && segments[k] === 'data' && !programLevel(lines[k]!)
    if (!inBlock(i)) {
      i++
      continue
    }
    let end = i
    let widest = 0
    for (; end < lines.length && inBlock(end); end++) {
      const l = lines[end]!
      if (l.labels && (l.head || l.rest)) widest = Math.max(widest, displayWidth(l.labels))
    }
    const w = Math.max(HEAD, Math.ceil((widest + 1) / 4) * 4)
    for (let k = i; k < end; k++) labelColumn[k] = w
    i = end
  }

  // Each line becomes one line, or two when a code label is moved off its instruction. Notes come last,
  // because they take the indentation of the code after them.
  const out: (string[] | null)[] = lines.map((l, i) => {
    if (l.kind === 'blank') return ['']
    if (l.kind === 'keep') return [l.text]
    if (l.kind === 'note') return null
    const body = statement(l)
    if (!body) return [withComment(l.labels, l.comment)]
    if (programLevel(l)) return [withComment(l.labels ? `${l.labels} ${body}` : body, l.comment)]
    if (segments[i] === 'data') return [withComment(l.labels ? pad(l.labels, labelColumn[i]!) + body : indent(labelColumn[i]!) + body, l.comment)]
    if (!l.labels) return [withComment(indent(INDENT) + body, l.comment)]
    if (DIRECTIVE_NAMES.has(lower(l))) return [withComment(pad(l.labels, HEAD) + body, l.comment)]
    return [l.labels, withComment(indent(INDENT) + body, l.comment)]
  })
  const codeIndent = (from: number, step: number): number | null => {
    for (let k = from; k >= 0 && k < lines.length; k += step) {
      const kind = lines[k]!.kind
      if (kind === 'statement' || kind === 'keep') return leading(out[k]![0]!)
    }
    return null
  }
  lines.forEach((l, i) => {
    if (l.kind === 'note') out[i] = [indent(l.indented ? (codeIndent(i + 1, 1) ?? codeIndent(i - 1, -1) ?? 0) : 0) + l.comment]
  })
  return out.flatMap((o) => o!).join('\n')
}
