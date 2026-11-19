/**
 * Every folder keeps an AGENTS.md in the shape the project requires: the `# AGENTS.md` title, the four
 * numbered sections in order, a Contents list that names everything in the folder (and nothing that is
 * missing), and English only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP = new Set(['node_modules', 'dist'])
const HEADINGS = ['## 1. Role', '## 2. Constraints', '## 3. Contents', '## 4. Progress']

function folders(dir: string): string[] {
  const out = [dir]
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...folders(full))
  }
  return out
}

/** Splits the file into its sections by the `## ` headings. */
function sections(text: string): Map<string, string> {
  const map = new Map<string, string>()
  let current = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.trim()
      map.set(current, '')
    } else if (current) map.set(current, map.get(current) + line + '\n')
  }
  return map
}

/** `*.asm` style patterns are allowed for folders of many similar files. */
function matches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(name)
}

const CJK = /[　-〿㐀-鿿＀-￯]/

describe('AGENTS.md in every folder', () => {
  for (const dir of folders(ROOT)) {
    const rel = relative(ROOT, dir) || '.'
    it(rel, () => {
      const file = join(dir, 'AGENTS.md')
      expect(existsSync(file), `${rel} has no AGENTS.md`).toBe(true)
      const text = readFileSync(file, 'utf8')
      expect(text.split('\n')[0], 'title').toBe('# AGENTS.md')

      const found = text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.trim())
      expect(found, 'section headings').toEqual(HEADINGS)
      const body = sections(text)
      for (const h of HEADINGS) expect(body.get(h)!.trim().length, `${h} is empty`).toBeGreaterThan(20)

      expect(CJK.test(text), 'AGENTS.md must be English').toBe(false)
      expect(text.includes('../'), 'no paths outside the folder').toBe(false)

      // Contents: every entry exists, and every child is listed.
      const entries = [...body.get('## 3. Contents')!.matchAll(/^- `([^`]+)` — /gm)].map((m) => m[1]!)
      expect(entries.length, 'Contents lists entries as "- `name` — …"').toBeGreaterThan(0)
      const children = readdirSync(dir).filter((n) => !n.startsWith('.') && !SKIP.has(n))
      for (const e of entries) {
        expect(children.some((c) => matches(e, c)), `${rel}: Contents names "${e}", which does not exist`).toBe(true)
      }
      for (const c of children) {
        if (c === 'AGENTS.md' && rel !== '.') continue
        expect(entries.some((e) => matches(e, c)), `${rel}: "${c}" is missing from Contents`).toBe(true)
      }
    })
  }
})
