/**
 * Encodings against LLVM (tests/arm64/golden/llvm, made by `npm run llvm-golden`):
 * our disassembly of each word must read like objdump's, our assembler must turn objdump's text back into
 * the same word, and across whole instruction classes we must agree on which words are unallocated.
 * Whole programs (prog-*.json) must give the same bytes in every section as clang's object file.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTables } from '../../src/isa/arm64/instructions/index'
import { decodeWord, disassemble, encodeInstr } from '../../src/isa/arm64/encoding/table'
import { Mismatch } from '../../src/isa/arm64/encoding/syntax'
import { tokenize } from '../../src/isa/arm64/lexer'
import { normalizeAsm, outOfScope, sameSveImm, unnamedSysreg } from './llvm-scope'
import { assemble } from '../../src/isa/arm64/assembler'

loadTables()
const DIR = join(__dirname, 'golden', 'llvm')
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))

/** Assemble one line on its own at an address; null when our assembler refuses it. */
function assembleAt(text: string, pc: number): number | string {
  const m = /^(\S+)\s*(.*)$/.exec(text.replace(/\/\/.*$/, '').replace(/<[^>]*>/g, '').trim())!
  try {
    return encodeInstr(m[1]!, tokenize(m[2]!), { pc, symbol: () => undefined }).word
  } catch (e) {
    if (e instanceof Mismatch) return e.message
    throw e
  }
}

const hex = (w: number) => '0x' + (w >>> 0).toString(16).padStart(8, '0')

describe('encodings match LLVM', () => {
  for (const file of files.filter((f) => !f.startsWith('asm-') && !f.startsWith('prog-'))) {
    it(file.replace('.json', ''), () => {
      const { cases } = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { cases: [string, number, string | null, (string | null)?][] }
      const classWide = file.startsWith('class-')
      const problems: string[] = []
      for (const [w, addr, text, canon] of cases) {
        const word = Number(w)
        const ours = disassemble(word, { pc: addr })
        if (text === null) {
          if (ours !== null) problems.push(`${w}: LLVM finds no instruction, we decode "${ours}"`)
          continue
        }
        if (outOfScope(text)) continue
        if (ours === null) {
          problems.push(`${w}: we find no instruction, LLVM decodes "${text}"`)
          continue
        }
        if (unnamedSysreg(ours, text)) continue
        if (normalizeAsm(ours) !== normalizeAsm(text) && !sameSveImm(ours, text)) problems.push(`${w}: we print "${ours}", LLVM "${text}"`)
        // A word LLVM accepts in a non-canonical form assembles to the canonical one; clang refuses to
        // assemble some (UNPREDICTABLE register choices), and then there is nothing to compare.
        if (canon === null) continue
        const back = assembleAt(text, addr)
        if (back !== (canon ? Number(canon) : word)) problems.push(`${w}: "${text}" assembles to ${typeof back === 'number' ? hex(back) : `an error: ${back}`}`)
        else if (decodeWord(word) === null) problems.push(`${w}: not decodable`)
      }
      expect(problems.slice(0, 40), `${problems.length} problems`).toEqual([])
    })
  }
})

describe('assembler matches clang', () => {
  for (const file of files.filter((f) => f.startsWith('asm-'))) {
    it(file.replace('.json', ''), () => {
      const { lines } = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { lines: [string, string | null][] }
      const problems: string[] = []
      lines.forEach(([line, w], i) => {
        const ours = assembleAt(line, i * 4)
        if (w === null) {
          if (typeof ours === 'number') problems.push(`"${line}": clang refuses it, we assemble ${hex(ours)}`)
        } else if (ours !== Number(w)) problems.push(`"${line}": clang ${w}, we ${typeof ours === 'number' ? hex(ours) : `refuse: ${ours}`}`)
      })
      expect(problems.slice(0, 40), `${problems.length} problems`).toEqual([])
    })
  }
})

describe('programs match clang', () => {
  const PROGRAMS = join(__dirname, '..', '..', 'scripts', 'llvm', 'programs')
  for (const file of files.filter((f) => f.startsWith('prog-'))) {
    it(file.replace('.json', ''), () => {
      const { sections } = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { sections: Record<string, string> }
      const name = file.replace(/^prog-/, '').replace('.json', '.s')
      const r = assemble({ name, text: readFileSync(join(PROGRAMS, name), 'utf8') })
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      const p = r.program!
      for (const [section, want] of Object.entries(sections)) {
        const at = p.sections!.find((s) => s.name === section)
        expect(at, section).toBeDefined()
        const chunk = p.image.find((c) => c.addr === at!.addr)!
        const ours = [...chunk.bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
        // Compare in 4-byte steps so a difference points at its offset.
        for (let i = 0; i < Math.max(ours.length, want.length); i += 8) expect(`${section}+0x${(i / 2).toString(16)}: ${ours.slice(i, i + 8)}`).toBe(`${section}+0x${(i / 2).toString(16)}: ${want.slice(i, i + 8)}`)
      }
    })
  }
})
