/**
 * Helpers for source text that are independent of any ISA's grammar beyond its comment character and
 * section directives.
 *
 * Example programs exist in every language with the same code on every line; only comments differ.
 * translateComments moves a source to another language line by line, so an example (even one the user
 * has since edited) follows the interface language without changing a single instruction or line number.
 */
import type { Locale } from './i18n'
import type { ExampleProgram } from './isa'

/** Where the line's comment starts (its length when there is none); comment characters inside quotes do not count. */
export function commentStart(line: string, commentChar: string): number {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (commentChar && line.startsWith(commentChar, i)) return i
  }
  return line.length
}

/** The line without its comment and surrounding blanks. */
export function codeOf(line: string, commentChar: string): string {
  return line.slice(0, commentStart(line, commentChar)).trim()
}

export interface TextChange {
  from: number
  to: number
  insert: string
}

const isBlank = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'

/**
 * The smallest edits that turn `before` into `after` when the two differ only in whitespace (a formatter's
 * output), or null when anything else differs. Each edit replaces one run of blanks, so a cursor or mark
 * between two visible characters stays between the same two characters.
 */
export function whitespaceChanges(before: string, after: string): TextChange[] | null {
  const changes: TextChange[] = []
  let i = 0
  let j = 0
  for (;;) {
    const i0 = i
    const j0 = j
    while (i < before.length && isBlank(before[i]!)) i++
    while (j < after.length && isBlank(after[j]!)) j++
    const a = before.slice(i0, i)
    const b = after.slice(j0, j)
    if (a !== b) {
      let p = 0
      while (p < a.length && p < b.length && a[p] === b[p]) p++
      let q = 0
      while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
      changes.push({ from: i0 + p, to: i - q, insert: b.slice(p, b.length - q) })
    }
    if (i === before.length || j === after.length) return i === before.length && j === after.length ? changes : null
    if (before[i] !== after[j]) return null
    i++
    j++
  }
}

/** True when both texts have the same lines of code, so swapping one for the other only changes comments. */
export function sameCode(a: string, b: string, commentChar: string): boolean {
  const x = a.split('\n')
  const y = b.split('\n')
  return x.length === y.length && x.every((l, i) => codeOf(l, commentChar) === codeOf(y[i]!, commentChar))
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches the indentation in front of a section directive (`.text`, `.data`, …). */
export function sectionIndent(sections: string[]): RegExp {
  return new RegExp(`^[ \\t]+(?=(?:${sections.map(escape).join('|')})(?![\\w.]))`, 'i')
}

/** Section directives start in the first column: they separate the blocks of a program. */
export function flushSections(text: string, sections: string[]): string {
  if (!sections.length) return text
  const re = sectionIndent(sections)
  return text
    .split('\n')
    .map((line) => line.replace(re, ''))
    .join('\n')
}

function lineMap(examples: ExampleProgram[], to: Locale, commentChar: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const ex of examples) {
    const target = ex.text[to].split('\n')
    for (const from of Object.keys(ex.text) as Locale[]) {
      const lines = ex.text[from].split('\n')
      if (lines.length !== target.length) continue
      lines.forEach((line, i) => {
        const goal = target[i]!
        if (line !== goal && codeOf(line, commentChar) === codeOf(goal, commentChar) && !map.has(line)) map.set(line, goal)
      })
    }
  }
  return map
}

/** Replace every line that comes from an example with the same line of that example in `to`. */
export function translateComments(text: string, examples: ExampleProgram[], to: Locale, commentChar: string): string {
  const map = lineMap(examples, to, commentChar)
  return text
    .split('\n')
    .map((line) => map.get(line) ?? line)
    .join('\n')
}
