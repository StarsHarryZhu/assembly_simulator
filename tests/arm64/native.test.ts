/**
 * Behaviour against the real CPU (tests/arm64/golden/native, made by `npm run native-golden` on an Apple
 * silicon Mac): every case starts from the state its seed gives (and the FPCR it records), runs one
 * instruction in our machine, and must end with the same general and vector registers, NZCV, FPSR and
 * buffer bytes, or fault where the CPU faulted. SVE fixtures (with `vl`) ran in streaming mode at that vector
 * length and compare the Z and P registers instead of V; SME fixtures (with `svl`) ran with ZA enabled too
 * and also compare ZA and ZT0. streaming.json is the mode probe (tests/arm64/streaming.test.ts).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArmMachine } from '../../src/isa/arm64/cpu'
import { applySmeState, applySveState, applyState, caseProgram, SIM_BUF, smeInputs, sveInputs } from '../../scripts/native/cases'
import { BUF_SIZE, initialState, vectorState } from '../../scripts/native/state'
import { FPSR_ID, P0, V0, Z0, ZA, ZT0 } from '../../src/isa/arm64/registers'
import { ConsoleEnv } from '../helpers'
import type { MachineOptions } from '../../src/core/isa'

type Row = [string, string, number, number[], number[], string | null, number, Record<string, string>, [number, number][], number, Record<string, string>, number]
/** An SVE row has the Z registers where Row has V, then the predicates, then FPSR. */
type SveRow = [...Row, number?, Record<string, string>?, (string | null)?]
/** Memory changes: `[offset, byte]`, or in SME fixtures `[offset, hex]` runs. */
type Change = [number, number | string]

/** NATIVE_DIR replays a deeper run made elsewhere (see scripts/native-golden.mjs). */
const DIR = process.env.NATIVE_DIR ?? join(__dirname, 'golden', 'native')
/** As in scripts/native/harness.c: how far from the buffer a pointer is still shown as an offset. */
const NEAR = 0x10000n

describe('behaviour matches the CPU', () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'streaming.json')) {
    it(file.replace('.json', ''), () => {
      const fixture = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { cases: Row[]; vl?: number; svl?: number }
      const { cases, svl } = fixture
      const vl = fixture.vl ?? svl
      const problems: string[] = []
      for (const [text, word, seed, ptr, small, signal, nzcv, regs, memory, fpcr, vregs, fpsr, pregs, zaRows, zt0] of cases as SveRow[]) {
        // SVE and SME rows: [.., fpcr, zregs, pregs, fpsr(, zarows, zt0)]; the others: [.., fpcr, vregs, fpsr].
        const sveFpsr = vl ? (pregs as unknown as number) : fpsr
        const zp = vl ? (fpsr as unknown as Record<string, string>) : {}
        const sme = svl ? smeInputs(seed, ptr, small, svl) : null
        const inputs = sme ?? (vl ? sveInputs(seed, ptr, small, vl) : null)
        const s = inputs ? inputs.state : initialState(seed, ptr, small)
        const vs = vectorState(seed)
        const settings: MachineOptions | undefined = svl ? { settings: { svl: svl * 8 } } : vl ? { settings: { vl: vl * 8 } } : undefined
        const m = new ArmMachine(caseProgram(Number(word), s.memory), new ConsoleEnv(), settings)
        if (sme) applySmeState(m, s, ptr, sme.sve, sme.za, fpcr)
        else if (inputs) applySveState(m, s, ptr, inputs.sve, fpcr)
        else applyState(m, s, ptr, vs, fpcr)
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
        const fpcrNote = fpcr ? ` [FPCR ${fpcr.toString(16)}]` : ''
        if (inputs) {
          for (let n = 0; n < 32; n++) {
            const want = vregs[n] ?? inputs.sve.z[n]!.toString(16)
            const got = BigInt(m.readRegister(Z0 + n)).toString(16)
            if (got !== want) problems.push(`${text} (seed ${seed})${fpcrNote}: z${n} = ${got.padStart(vl! * 2, '0')}, the CPU ${want.padStart(vl! * 2, '0')}`)
          }
          for (let n = 0; n < 16; n++) {
            const want = zp[n] ?? inputs.sve.p[n]!.toString(16)
            const got = BigInt(m.readRegister(P0 + n)).toString(16)
            if (got !== want) problems.push(`${text} (seed ${seed}): p${n} = ${got.padStart(vl! / 4, '0')}, the CPU ${want.padStart(vl! / 4, '0')}`)
          }
        } else
          for (let n = 0; n < 32; n++) {
            const want = vregs[n] ?? vs.v[n]!.toString(16)
            const got = BigInt(m.readRegister(V0 + n)).toString(16)
            if (got !== want) problems.push(`${text} (seed ${seed})${fpcrNote}: v${n} = ${got.padStart(32, '0')}, the CPU ${want.padStart(32, '0')}`)
          }
        if (sme) {
          const hex = (b: Uint8Array) => BigInt('0x' + [...b].reverse().map((x) => x.toString(16).padStart(2, '0')).join('')).toString(16)
          const za = m.readRegisterBytes(ZA)
          for (let r = 0; r < svl!; r++) {
            const want = zaRows?.[r] ?? hex(sme.za.za.subarray(r * svl!, (r + 1) * svl!))
            const got = hex(za.subarray(r * svl!, (r + 1) * svl!))
            if (got !== want) problems.push(`${text} (seed ${seed})${fpcrNote}: ZA row ${r} = ${got.padStart(svl! * 2, '0')}, the CPU ${want.padStart(svl! * 2, '0')}`)
          }
          const wantZt = zt0 ?? hex(sme.za.zt0)
          const gotZt = hex(m.readRegisterBytes(ZT0))
          if (gotZt !== wantZt) problems.push(`${text} (seed ${seed}): zt0 = ${gotZt}, the CPU ${wantZt}`)
        }
        const gotFpsr = Number(m.readRegister(FPSR_ID))
        if (gotFpsr !== sveFpsr) problems.push(`${text} (seed ${seed})${fpcrNote}: FPSR = ${gotFpsr.toString(16)}, the CPU ${sveFpsr.toString(16)}`)
        const changed = new Map<number, number>()
        for (const [at, v] of memory as unknown as Change[]) {
          if (typeof v === 'number') changed.set(at, v)
          else for (let k = 0; k < v.length / 2; k++) changed.set(at + k, parseInt(v.slice(2 * k, 2 * k + 2), 16))
        }
        for (let b = 0; b < s.memory.length; b++) {
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
