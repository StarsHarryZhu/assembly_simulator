/**
 * Floating-point edge cases found by running every FP encoding with edge-heavy operands (zeros, infinities,
 * NaNs, denormals, extremes, ties, conversion limits) under every FPCR mode on the M5 and comparing with our
 * machine. Each case is one instruction with the registers and FPCR the CPU ran it with, and the destination
 * and FPSR it produced.
 */
import { describe, expect, it } from 'vitest'
import { ArmMachine } from '../../src/isa/arm64/cpu'
import { disassemble } from '../../src/isa/arm64/encoding/table'
import { loadTables } from '../../src/isa/arm64/instructions/index'
import { FPCR_ID, FPSR_ID, V0 } from '../../src/isa/arm64/registers'
import { caseProgram, SIM_TEXT } from '../../scripts/native/cases'
import { ConsoleEnv } from '../helpers'

interface Edge {
  /** The instruction word and its text (checked against our disassembler). */
  word: number
  text: string
  fpcr: number
  /** SIMD&FP registers before, as 128-bit values. */
  v: Record<number, bigint>
  /** The destination register after and FPSR after, as the CPU left them. */
  rd: number
  want: bigint
  fpsr: number
}

const AH = 2
const FZ = 1 << 24

const CASES: Edge[] = [
  // FSQRT of a negative denormal is only an invalid operation: no input-denormal flag with AH = 1.
  { word: 0x1e21c020, text: 'fsqrt s0, s1', fpcr: AH, v: { 1: 0x80400000n }, rd: 0, want: 0xffc00000n, fpsr: 0x1 },
  { word: 0x1e21c020, text: 'fsqrt s0, s1', fpcr: AH, v: { 1: 0x00400000n }, rd: 0, want: 0x1fb504f3n, fpsr: 0x90 },
  { word: 0x1e21c020, text: 'fsqrt s0, s1', fpcr: 0, v: { 1: 0x80400000n }, rd: 0, want: 0x7fc00000n, fpsr: 0x1 },
  { word: 0x1e21c020, text: 'fsqrt s0, s1', fpcr: FZ, v: { 1: 0x80400000n }, rd: 0, want: 0x80000000n, fpsr: 0x80 },
  {
    word: 0x6ea1f820,
    text: 'fsqrt v0.4s, v1.4s',
    fpcr: 0x4480006,
    v: { 1: 0x7fc0000080400000b8b7351bbe99dd32n },
    rd: 0,
    want: 0x7fc00000ffc00000ffc00000ffc00000n,
    fpsr: 0x1,
  },
  // FDIV by zero never reports a denormal dividend; a zero, infinite or finite dividend over a denormal does.
  { word: 0x1e221820, text: 'fdiv s0, s1, s2', fpcr: AH, v: { 1: 0x007fc000n, 2: 0n }, rd: 0, want: 0x7f800000n, fpsr: 0x2 },
  { word: 0x1e221820, text: 'fdiv s0, s1, s2', fpcr: AH, v: { 1: 0x007fc000n, 2: 0x80000000n }, rd: 0, want: 0xff800000n, fpsr: 0x2 },
  { word: 0x1e221820, text: 'fdiv s0, s1, s2', fpcr: AH, v: { 1: 0n, 2: 1n }, rd: 0, want: 0n, fpsr: 0x80 },
  { word: 0x1e221820, text: 'fdiv s0, s1, s2', fpcr: AH, v: { 1: 0x7f800000n, 2: 1n }, rd: 0, want: 0x7f800000n, fpsr: 0x80 },
  { word: 0x1e221820, text: 'fdiv s0, s1, s2', fpcr: AH, v: { 1: 1n, 2: 0x7f800000n }, rd: 0, want: 0n, fpsr: 0x80 },
  { word: 0x1e221820, text: 'fdiv s0, s1, s2', fpcr: AH, v: { 1: 0x3f800000n, 2: 1n }, rd: 0, want: 0x7f800000n, fpsr: 0x94 },
  { word: 0x1e221820, text: 'fdiv s0, s1, s2', fpcr: FZ, v: { 1: 1n, 2: 0n }, rd: 0, want: 0x7fc00000n, fpsr: 0x81 },
  {
    word: 0x1e621820,
    text: 'fdiv d0, d1, d2',
    fpcr: 0x3000006,
    v: { 1: 0x000fffffffffffff000fffffffffffffn, 2: 0n },
    rd: 0,
    want: 0x000fffffffffffff7ff0000000000000n,
    fpsr: 0x2,
  },
  {
    word: 0x6e22fc20,
    text: 'fdiv v0.4s, v1.4s, v2.4s',
    fpcr: 0x5c00002,
    v: { 1: 0x007fc000c0200000408000005effffffn, 2: 0x00000000d7f5fe607fc000005f000001n },
    rd: 0,
    want: 0x7f80000027a682237fc000003f7ffffdn,
    fpsr: 0x12,
  },
]

describe('floating-point edge cases match the CPU', () => {
  loadTables()
  for (const c of CASES) {
    const regs = Object.entries(c.v)
      .map(([n, v]) => `v${n}=${v.toString(16)}`)
      .join(' ')
    it(`${c.text} [FPCR ${c.fpcr.toString(16)}] ${regs}`, () => {
      expect(disassemble(c.word, { pc: SIM_TEXT })).toBe(c.text)
      const m = new ArmMachine(caseProgram(c.word, new Uint8Array(16)), new ConsoleEnv())
      for (const [n, v] of Object.entries(c.v)) m.setRegister(V0 + Number(n), v)
      m.setRegister(FPCR_ID, BigInt(c.fpcr))
      m.step()
      expect(m.halted?.kind).not.toBe('error')
      expect((BigInt(m.readRegister(V0 + c.rd)) & ((1n << 128n) - 1n)).toString(16)).toBe(c.want.toString(16))
      expect(Number(m.readRegister(FPSR_ID)).toString(16)).toBe(c.fpsr.toString(16))
    })
  }
})
