/**
 * The editor's Format command for AArch64 (GNU as syntax): lays a program out the way the example programs
 * are written.
 *
 * - Section directives (`.text`, `.data`, `.section …`) and program-level directives (`.global`, `.equ`,
 *   `.macro`, `name = value`, …) start in the first column.
 * - In code, labels stand alone in the first column and statements are indented by 4; a label followed by an
 *   instruction is moved to its own line. In data, label, directive and values form three columns; the
 *   label column is as wide as the block's longest label needs, at least 8 and a multiple of 4.
 * - A mnemonic or directive is padded to 8 columns. Operands get one space after each comma, none before it
 *   and none just inside brackets and braces; other runs of blanks become one space. Quoted text never changes.
 * - Trailing `//` comments start at column 40, or at the next multiple of 4 after longer code. A comment on
 *   its own line keeps the first column, or else takes the indentation of the next line of code.
 *
 * Only whitespace changes (moving a label adds a line break). Lines whose meaning could depend on layout are
 * left as written: block comments, several statements joined by `;`, an unclosed quote, two labels on a line.
 */

const INDENT = 4
const HEAD = 8
const COMMENT = 40

const SECTIONS = new Map<string, 'code' | 'data'>([
  ['.text', 'code'],
  ['.data', 'data'],
  ['.bss', 'data'],
  ['.rodata', 'data'],
])
const SECTION_LIKE = new Set(['.section', '.pushsection', '.popsection', '.previous'])
const PROGRAM_LEVEL = new Set(['.global', '.globl', '.equ', '.set', '.equiv', '.eqv', '.macro', '.endm', '.purgem', '.include', '.extern', '.type', '.size', '.arch', '.arch_extension', '.local', '.weak', '.hidden', '.end'])

const LABEL = /^([A-Za-z_.$][\w.$]*|\d+)[ \t]*:/
const HEAD_WORD = /^[^ \t,"'[\]{}()]+/
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u

function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += WIDE.test(ch) ? 2 : 1
  return w
}

interface Line {
  kind: 'blank' | 'keep' | 'note' | 'statement'
  text: string
  indented: boolean
  labels: string
  head: string
  rest: string
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

/** Where a `//` comment starts outside quotes; -1 for an unclosed quote. Also reports `;` and `/*`. */
function scan(s: string): { comment: number; separator: boolean; block: boolean } | null {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '"' || (c === "'" && s[i + 2] === "'")) {
      const end = closingQuote(s, i)
      if (end < 0) return null
      i = end
    } else if (c === '/' && s[i + 1] === '/') return { comment: i, separator: false, block: false }
    else if (c === '/' && s[i + 1] === '*') return { comment: s.length, separator: false, block: true }
    else if (c === ';') return { comment: s.length, separator: true, block: false }
  }
  return { comment: s.length, separator: false, block: false }
}

/** Operands with one space after each comma and none just inside brackets; null for an unclosed quote. */
function normaliseOperands(s: string): string | null {
  let out = ''
  let gap = false
  let comma = false
  let open = false
  const write = (t: string) => {
    if (out && (comma || (gap && !open))) out += ' '
    out += t
    gap = comma = false
    open = t === '[' || t === '{' || t === '('
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') gap = true
    else if (c === ',' || c === ']' || c === '}' || c === ')') {
      out += c
      gap = open = false
      comma = c === ','
    } else if (c === '"' || (c === "'" && s[i + 2] === "'")) {
      const end = closingQuote(s, i)
      if (end < 0) return null
      write(s.slice(i, end + 1))
      i = end
    } else write(c)
  }
  return out
}

function parse(text: string, inBlock: boolean): { line: Line; inBlock: boolean } {
  const keep = (): { line: Line; inBlock: boolean } => ({ line: { kind: 'keep', text: text.replace(/[ \t\r\f]+$/, ''), indented: false, labels: '', head: '', rest: '', comment: '' }, inBlock })
  if (inBlock) {
    const close = text.indexOf('*/')
    inBlock = close < 0 || text.indexOf('/*', close) >= 0
    return keep()
  }
  const line: Line = { kind: 'statement', text, indented: false, labels: '', head: '', rest: '', comment: '' }
  const trimmed = text.replace(/^[ \t\r\f]+/, '')
  if (trimmed.startsWith('#')) {
    line.kind = 'note'
    line.comment = trimmed.replace(/[ \t\r\f]+$/, '')
    line.indented = trimmed.length < text.length
    return { line, inBlock }
  }
  const sc = scan(text)
  if (!sc || sc.separator) return keep()
  if (sc.block) {
    const open = text.indexOf('/*')
    const close = text.indexOf('*/', open + 2)
    return { ...keep(), inBlock: close < 0 }
  }
  line.comment = text.slice(sc.comment).replace(/[ \t\r\f]+$/, '')
  let code = text.slice(0, sc.comment).trim()
  if (!code) {
    line.kind = line.comment ? 'note' : 'blank'
    line.indented = sc.comment > 0 && /^[ \t]/.test(text)
    return { line, inBlock }
  }
  const label = LABEL.exec(code)
  if (label) {
    line.labels = label[1] + ':'
    code = code.slice(label[0].length).trim()
    if (LABEL.test(code)) return keep()
  }
  line.head = HEAD_WORD.exec(code)?.[0] ?? ''
  const rest = normaliseOperands(code.slice(line.head.length))
  if (rest == null) return keep()
  line.rest = rest
  return { line, inBlock }
}

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(1, width - displayWidth(text)))
const indent = (n: number) => ' '.repeat(n)
const leading = (text: string) => text.length - text.replace(/^ +/, '').length

function statement(l: Line): string {
  if (!l.head || !l.rest) return l.head + l.rest
  // `name = value` keeps one space either side of the =.
  if (l.rest.startsWith('=')) return `${l.head} ${l.rest}`
  return pad(l.head, HEAD) + l.rest
}

function withComment(code: string, comment: string): string {
  if (!comment) return code
  if (!code) return comment
  const w = displayWidth(code)
  return code + ' '.repeat(Math.max(COMMENT, Math.ceil((w + 1) / 4) * 4) - w) + comment
}

/** Lay an AArch64 source out in the house style; see the file comment. */
export function formatSource(text: string): string {
  let inBlock = false
  const lines = text.split('\n').map((t) => {
    const r = parse(t, inBlock)
    inBlock = r.inBlock
    return r.line
  })
  const lower = (l: Line) => l.head.toLowerCase()
  const sectionOf = (l: Line): 'code' | 'data' | null => {
    const h = lower(l)
    if (SECTIONS.has(h)) return SECTIONS.get(h)!
    if (h === '.section' || h === '.pushsection') {
      const name = l.rest.split(',')[0]!.trim()
      const flags = l.rest.split(',')[1] ?? ''
      return /^\.(k?text)/.test(name) || flags.includes('x') ? 'code' : 'data'
    }
    return null
  }
  const programLevel = (l: Line) => l.kind === 'statement' && (SECTIONS.has(lower(l)) || SECTION_LIKE.has(lower(l)) || PROGRAM_LEVEL.has(lower(l)) || l.rest.startsWith('='))

  let segment: 'code' | 'data' = 'code'
  const segments = lines.map((l) => (l.kind === 'statement' ? (segment = sectionOf(l) ?? segment) : segment))
  const labelColumn = lines.map(() => HEAD)
  for (let i = 0; i < lines.length; ) {
    const inData = (k: number) => lines[k]!.kind !== 'blank' && segments[k] === 'data' && !programLevel(lines[k]!)
    if (!inData(i)) {
      i++
      continue
    }
    let end = i
    let widest = 0
    for (; end < lines.length && inData(end); end++) {
      const l = lines[end]!
      if (l.labels && l.head) widest = Math.max(widest, displayWidth(l.labels))
    }
    const w = Math.max(HEAD, Math.ceil((widest + 1) / 4) * 4)
    for (let k = i; k < end; k++) labelColumn[k] = w
    i = end
  }

  const out: (string[] | null)[] = lines.map((l, i) => {
    if (l.kind === 'blank') return ['']
    if (l.kind === 'keep') return [l.text]
    if (l.kind === 'note') return null
    const body = statement(l)
    if (!body) return [withComment(l.labels, l.comment)]
    if (programLevel(l)) return [withComment(l.labels ? `${l.labels} ${body}` : body, l.comment)]
    if (segments[i] === 'data') return [withComment(l.labels ? pad(l.labels, labelColumn[i]!) + body : indent(labelColumn[i]!) + body, l.comment)]
    if (!l.labels) return [withComment(indent(INDENT) + body, l.comment)]
    // A label before data in a code section (a string kept with the code) stays on its line.
    if (l.head.startsWith('.')) return [withComment(pad(l.labels, HEAD) + body, l.comment)]
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
