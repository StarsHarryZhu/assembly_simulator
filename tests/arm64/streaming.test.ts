/**
 * PSTATE.SM and PSTATE.ZA against the M5 (tests/arm64/golden/native/streaming.json, made by
 * `npm run native-golden`): sample words of every FP, Neon, SVE and SME encoding ran in the four SVCR
 * states, and an instruction must raise SIGILL in exactly the states where our NEED bits forbid it.
 *
 * The M5 has SVE only in Streaming SVE mode, so SVE encodings are compared there only; MOVT is absent from
 * it altogether.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTables } from '../../src/isa/arm64/instructions/index'
import { decodeWord, disassemble, NEED, needsOf } from '../../src/isa/arm64/encoding/table'

loadTables()
const { cases } = JSON.parse(readFileSync(join(process.env.NATIVE_DIR ?? join(__dirname, 'golden', 'native'), 'streaming.json'), 'utf8')) as { cases: [string, string, (string | null)[]][] }
const ABSENT = new Set(['movt-x', 'movt-zt0'])
const SVE_GROUPS = new Set(['sve', 'sve2', 'sveperm', 'svepred', 'svefp', 'sveload'])

describe('Streaming SVE mode and ZA match the M5', () => {
  it('raises SIGILL in the same SVCR states', () => {
    const problems: string[] = []
    for (const [id, w, signals] of cases) {
      if (ABSENT.has(id)) continue
      const word = Number(w)
      const d = decodeWord(word)
      if (!d || d.instr.spec.id !== id) {
        problems.push(`${w}: decodes as ${d?.instr.spec.id ?? 'nothing'}, not ${id}`)
        continue
      }
      const needs = needsOf(d.instr.spec, d.fields)
      const sveOnly = SVE_GROUPS.has(d.instr.spec.group) || (d.instr.spec.feature ?? '').startsWith('sve')
      for (let state = 0; state < 4; state++) {
        const sm = state & 1
        const za = state & 2
        if (sveOnly && !sm) continue
        const ours = !!((needs & NEED.streaming && !sm) || (needs & NEED.nonStreaming && sm) || (needs & (NEED.za | NEED.zt0) && !za))
        const cpu = signals[state] === 'sigill'
        if (ours !== cpu) problems.push(`${disassemble(word, { pc: 0 })} (${id}) with SM=${sm} ZA=${za ? 1 : 0}: the M5 ${cpu ? 'raises SIGILL' : 'runs it'}, we ${ours ? 'refuse it' : 'run it'}`)
      }
    }
    expect(problems.slice(0, 40), `${problems.length} problems`).toEqual([])
  })
})
