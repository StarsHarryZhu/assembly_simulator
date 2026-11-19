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

/** The line without its comment and surrounding blanks; comment characters inside quotes do not count. */
export function codeOf(line: string, commentChar: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (line.startsWith(commentChar, i)) return line.slice(0, i).trim()
  }
  return line.trim()
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
