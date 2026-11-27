/**
 * Findings of the deep checks against the M5 and LLVM that the committed fixtures happen not to sample:
 * the CPU's choices for CONSTRAINED UNPREDICTABLE register combinations of loads and stores, should-be-zero
 * bits that the CPU and LLVM both ignore, WHILEWR/WHILERW on addresses across the top of the address space,
 * SVE FABS/FNEG with FPCR.AH, FEAT_WFxT and the "bti r" spelling. Every expected value is what the M5 did.
 */
import { describe, expect, it } from 'vitest'
import { loadTables } from '../../src/isa/arm64/instructions/index'
import { disassemble, encodeInstr } from '../../src/isa/arm64/encoding/table'
import { tokenize } from '../../src/isa/arm64/lexer'
import { ArmMachine } from '../../src/isa/arm64/cpu'
import { FPCR_ID, P0, V0, Z0 } from '../../src/isa/arm64/registers'
import { caseProgram, SIM_BUF } from '../../scripts/native/cases'
import { ConsoleEnv } from '../helpers'

loadTables()

const PATTERN = () => Uint8Array.from({ length: 256 }, (_, b) => (b * 7 + 3) & 255)
const flags = (m: ArmMachine) => [33, 34, 35, 36].reduce((a, id) => (a << 1) | Number(m.readRegister(id)), 0)
const setFlags = (m: ArmMachine, nzcv: number) => [33, 34, 35, 36].forEach((id, i) => m.setRegister(id, (nzcv >> (3 - i)) & 1))
const asm = (line: string) => {
  const [m, ...rest] = line.split(' ')
  return encodeInstr(m!, tokenize(rest.join(' ')), { pc: 0x400000, symbol: () => undefined }).word >>> 0
}

/** One word on the case machine: x0 points 64 bytes into a patterned buffer, x1 and x2 hold markers. */
function run(word: number, vl?: number) {
  const m = new ArmMachine(caseProgram(word, PATTERN()), new ConsoleEnv(), vl ? { settings: { vl } } : undefined)
  m.setRegister(0, BigInt(SIM_BUF + 64))
  m.setRegister(1, 0x1111111111111111n)
  m.setRegister(2, 0x2222222222222222n)
  return m
}

const pair = (opc: number, V: number, form: number, L: number, rt2: number, rn: number, rt: number) =>
  ((opc << 30) | (0b101 << 27) | (V << 26) | (form << 23) | (L << 22) | (2 << 15) | (rt2 << 10) | (rn << 5) | rt) >>> 0
const single = (size: number, opc: number, idx: number, rn: number, rt: number) =>
  ((size << 30) | (0b111 << 27) | (opc << 22) | ((1 << size) << 12) | (idx << 10) | (rn << 5) | rt) >>> 0

describe('UNPREDICTABLE loads and stores, as the M5 resolves them', () => {
  it('raises SIGILL for a pair load naming one register twice, in every form and size', () => {
    const kinds = [[0, 0], [2, 0], [1, 0], [0, 1], [1, 1], [2, 1]] // W, X, LDPSW, S, D, Q
    for (const [opc, V] of kinds)
      for (const form of [0, 1, 2, 3]) {
        if (opc === 1 && V === 0 && form === 0) continue // no LDNPSW
        const word = pair(opc!, V!, form, 1, 1, 0, 1)
        const m = run(word)
        m.step()
        expect(m.halted?.kind === 'error' && m.halted.code, disassemble(word, { pc: 0x400000 }) ?? word.toString(16)).toBe('sigill')
        expect(m.readByte(SIM_BUF + 64)).toBe(PATTERN()[64])
      }
  })

  it('raises SIGILL for writeback to a base that is also transferred, loads and stores alike', () => {
    const words: number[] = []
    for (const [opc, L] of [[0, 0], [0, 1], [2, 0], [2, 1], [1, 1]])
      for (const form of [1, 3]) words.push(pair(opc!, 0, form, L!, 1, 0, 0), pair(opc!, 0, form, L!, 0, 0, 1))
    for (const size of [0, 1, 2, 3])
      for (const idx of [1, 3]) for (const opc of size === 3 ? [0, 1] : [0, 1, 2]) words.push(single(size, opc, idx, 0, 0))
    for (const word of words) {
      const m = run(word)
      m.step()
      expect(m.halted?.kind === 'error' && m.halted.code, disassemble(word, { pc: 0x400000 }) ?? word.toString(16)).toBe('sigill')
      expect(BigInt(m.readRegister(0))).toBe(BigInt(SIM_BUF + 64))
    }
    // The same encodings without the overlap run.
    for (const word of [pair(2, 0, 3, 1, 2, 0, 1), pair(2, 0, 3, 0, 2, 0, 1), single(3, 1, 1, 0, 1), single(0, 0, 3, 0, 1)]) {
      const m = run(word)
      m.step()
      expect(m.halted?.kind, disassemble(word, { pc: 0x400000 }) ?? '').toBe('dropped-off')
    }
  })

  it('fails an exclusive store whose status register overlaps, storing nothing', () => {
    for (const word of [0xc8017c01, 0xc8007c01, 0xc8210801, 0xc8220801, 0xc8208801]) {
      const m = run(word >>> 0)
      m.step()
      expect(m.halted?.kind, word.toString(16)).toBe('dropped-off')
      expect(Array.from({ length: 256 }, (_, b) => m.readByte(SIM_BUF + b))).toEqual([...PATTERN()])
    }
  })
})

describe('should-be-zero bits are ignored, as by the M5 and LLVM', () => {
  it('compares with zero whatever Rm holds', () => {
    expect(disassemble(0x1e3a2028, { pc: 0x400000 })).toBe('fcmp s1, #0.0')
    expect(asm('fcmp s1, #0.0')).toBe(0x1e202028)
    const one = run(0x1e3a2028)
    one.setRegister(V0 + 1, 0x3f800000n)
    one.step()
    expect(flags(one)).toBe(0b0010)
    const neg = run(0x1e652058)
    neg.setRegister(V0 + 2, 0xbff0000000000000n)
    neg.step()
    expect(flags(neg)).toBe(0b1000)
  })

  it('inverts the carry whatever CRm of CFINV holds', () => {
    expect(disassemble(0xd500441f, { pc: 0x400000 })).toBe('cfinv')
    expect(asm('cfinv')).toBe(0xd500401f)
    const m = run(0xd5004f1f)
    setFlags(m, 0b0010)
    m.step()
    expect(flags(m)).toBe(0)
  })
})

describe('instructions the deep LLVM survey found', () => {
  it('has WFET and WFIT, which continue at once', () => {
    expect(disassemble(0xd503101c, { pc: 0x400000 })).toBe('wfet x28')
    expect(disassemble(0xd503103c, { pc: 0x400000 })).toBe('wfit x28')
    expect(asm('wfet x3')).toBe(0xd5031003)
    const m = run(0xd5031020)
    m.step()
    expect(m.halted?.kind).toBe('dropped-off')
    expect(BigInt(m.readRegister(0))).toBe(BigInt(SIM_BUF + 64))
  })

  it('accepts "bti r" for BTI without targets and prints it as bti', () => {
    expect(asm('bti r')).toBe(0xd503241f)
    expect(disassemble(0xd503241f, { pc: 0x400000 })).toBe('bti')
  })
})

describe('SVE details the M5 showed', () => {
  // whilewr p0.d, x0, x1 and whilerw p0.d, x0, x1
  const WHILEWR = 0x25e13000
  const WHILERW = 0x25e13010

  it('treats the pointers of WHILEWR and WHILERW as unsigned addresses', () => {
    const go = (word: number, x0: bigint, x1: bigint) => {
      const m = run(word, 512)
      m.setRegister(0, x0)
      m.setRegister(1, x1)
      m.step()
      return [BigInt(m.readRegister(P0)).toString(16), flags(m).toString(2).padStart(4, '0')]
    }
    // Xn = 2^64 − 31, Xm = 0: unsigned, Xm − Xn is negative, so every element is true (the M5's result);
    // the other two follow the same unsigned rule (signed, they would give all true and three elements).
    expect(go(WHILEWR, 0xffffffffffffffe1n, 0n)).toEqual(['101010101010101', '1000'])
    expect(go(WHILEWR, 0x1000n, 0x1010n)).toEqual(['101', '1010'])
    expect(go(WHILERW, 0x7ffffffffffffff8n, 0x8000000000000008n)).toEqual(['101', '1010'])
  })

  it('leaves NaNs alone in FABS and FNEG when FPCR.AH is 1', () => {
    // fabs z0.h, p0/m, z1.h and fneg z0.h, p0/m, z1.h at a 128-bit vector length.
    const lanes = [0xffff, 0xfc03, 0x8001, 0xbc00, 0x7e00, 0x3c00, 0x0000, 0x8000]
    const z1 = lanes.reduce((a, v, i) => a | (BigInt(v) << BigInt(16 * i)), 0n)
    const go = (word: number, ah: boolean) => {
      const m = run(word, 128)
      m.setRegister(P0, 0xffffn)
      m.setRegister(Z0 + 1, z1)
      m.setRegister(FPCR_ID, ah ? 2n : 0n)
      m.step()
      const z0 = BigInt(m.readRegister(Z0))
      return lanes.map((_, i) => Number((z0 >> BigInt(16 * i)) & 0xffffn))
    }
    const nan = (v: number) => (v & 0x7c00) === 0x7c00 && (v & 0x3ff) !== 0
    expect(go(0x045ca020, false)).toEqual(lanes.map((v) => v & 0x7fff))
    expect(go(0x045ca020, true)).toEqual(lanes.map((v) => (nan(v) ? v : v & 0x7fff)))
    expect(go(0x045da020, false)).toEqual(lanes.map((v) => v ^ 0x8000))
    expect(go(0x045da020, true)).toEqual(lanes.map((v) => (nan(v) ? v : v ^ 0x8000)))
  })
})

describe('SME at the shortest streaming vector length', () => {
  it('wraps the slices of four-register MOVA round a .d tile that has only two', async () => {
    const { arm64 } = await import('../../src/isa/arm64')
    const text = [
      '.text',
      '_start:',
      '    smstart',
      '    mov w12, #0',
      '    index z0.d, #1, #1',
      '    index z1.d, #3, #1',
      '    index z2.d, #5, #1',
      '    index z3.d, #7, #1',
      '    mova za0h.d[w12, 0:3], {z0.d-z3.d}',
      '    mova {z4.d-z7.d}, za0h.d[w12, 0:3]',
      '    movaz {z8.d-z11.d}, za0v.d[w12, 0:3]',
      '    mov x8, #93',
      '    svc #0',
    ].join('\n')
    const r = arm64.assemble({ name: 'a.s', text })
    expect(r.ok).toBe(true)
    const m = arm64.createMachine(r.program!, new ConsoleEnv(), { settings: { svl: 128 } })
    m.run(100, new Set())
    expect(m.halted?.kind).toBe('exit')
    const z = (n: number) => BigInt(m.readRegister(Z0 + n))
    const pair = (lo: bigint, hi: bigint) => lo | (hi << 64n)
    // Rows 0 and 1 end up holding z2 and z3 (written last); reading four slices gives rows 0, 1, 0, 1.
    expect([4, 5, 6, 7].map(z)).toEqual([pair(5n, 6n), pair(7n, 8n), pair(5n, 6n), pair(7n, 8n)])
    // Columns: column 0 is (5, 7), column 1 is (6, 8). MOVAZ zeroes each slice right after reading it, so the
    // wrapped third and fourth reads find zeros.
    expect([8, 9, 10, 11].map(z)).toEqual([pair(5n, 7n), pair(6n, 8n), 0n, 0n])
  })
})
