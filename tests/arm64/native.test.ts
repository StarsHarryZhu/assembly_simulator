/**
 * Behaviour against the real CPU (tests/arm64/golden/native, made by `npm run native-golden` on an Apple
 * silicon Mac): every case starts from the state its seed gives, runs one instruction in our machine, and
 * must end with the same registers, flags and buffer bytes, or fault where the CPU faulted.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArmMachine } from '../../src/isa/arm64/cpu'
import { applyState, caseProgram, SIM_BUF } from '../../scripts/native/cases'
import { BUF_SIZE, initialState } from '../../scripts/native/state'
import { ConsoleEnv } from '../helpers'

type Row = [string, string, number, number[], number[], string | null, number, Record<string, string>, [number, number][]]

const DIR = join(__dirname, 'golden', 'native')
/** As in scripts/native/harness.c: how far from the buffer a pointer is still shown as an offset. */
const NEAR = 0x10000n

describe('behaviour matches the CPU', () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    it(file.replace('.json', ''), () => {
      const { cases } = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { cases: Row[] }
      const problems: string[] = []
      for (const [text, word, seed, ptr, small, signal, nzcv, regs, memory] of cases) {
        const s = initialState(seed, ptr, small)
        const m = new ArmMachine(caseProgram(Number(word), s.memory), new ConsoleEnv())
        applyState(m, s, ptr)
        m.step()
        const halt = m.halted
        if (signal) {
          if (halt?.kind !== 'error' || halt.code !== signal) problems.push(`${text}: the CPU raised ${signal}, we ${halt?.kind === 'error' ? halt.code : 'did not fault'}`)
          continue
        }
        if (halt?.kind === 'error') {
          problems.push(`${text}: we fault (${halt.code}), the CPU does not`)
          continue
        }
        const value = (n: number) => {
          const v = BigInt(m.readRegister(n))
          const off = v - BigInt(SIM_BUF)
          return ptr.includes(n) && off >= -NEAR && off <= NEAR ? `p${off}` : v.toString(16)
        }
        const before = (n: number) => (ptr.includes(n) ? `p${s.x[n]}` : s.x[n]!.toString(16))
        for (let n = 0; n < 31; n++) {
          const want = regs[n] ?? before(n)
          if (value(n) !== want) problems.push(`${text} (seed ${seed}): x${n} = ${value(n)}, the CPU ${want}`)
        }
        const flags = [33, 34, 35, 36].reduce((a, id) => (a << 1) | Number(m.readRegister(id)), 0)
        if (flags !== nzcv) problems.push(`${text} (seed ${seed}): NZCV = ${flags.toString(2).padStart(4, '0')}, the CPU ${nzcv.toString(2).padStart(4, '0')}`)
        const changed = new Map(memory)
        for (let b = 0; b < BUF_SIZE; b++) {
          const want = changed.get(b) ?? s.memory[b]!
          const got = m.readByte(SIM_BUF + b)
          if (got !== want) {
            problems.push(`${text} (seed ${seed}): buffer[${b}] = ${got}, the CPU ${want}`)
            break
          }
        }
      }
      expect(problems.slice(0, 30), `${problems.length} problems`).toEqual([])
    })
  }
})
