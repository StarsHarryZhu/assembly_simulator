/**
 * The machine moves LDn/STn structures and SVE contiguous loads and stores as one block when no byte of it
 * can fault, and computes WHILE counts in closed form. These check that a block running into unmapped
 * memory still faults at the first element that cannot be accessed, that the stores before it still
 * happen, and the WHILE counts at the ends of the integer ranges.
 */
import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/isa/arm64/assembler'
import { createMachine, type ArmMachine } from '../../src/isa/arm64/cpu'
import { STACK_TOP } from '../../src/isa/arm64/linux'
import { FLAG_C, FLAG_N, FLAG_V, FLAG_Z, P0 } from '../../src/isa/arm64/registers'
import { ConsoleEnv } from '../helpers'

const EXIT = '\n mov x0, #0\n mov x8, #93\n svc #0'

function run(body: string, vl = 256): ArmMachine {
  const text = `.arch armv9.4-a+sve2p1
_start:
    index z0.b, #1, #1
    index z1.b, #-16, #3
    index z2.b, #7, #-5
    index z3.b, #13, #11
${body}${EXIT}`
  const r = assemble({ name: 't.s', text })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  const m = createMachine(r.program!, new ConsoleEnv(), { settings: { vl } })
  m.run(1_000_000, new Set())
  return m
}
/** The 16-digit hex address a fault message names. */
const faultAddr = (m: ArmMachine) => (m.halted?.kind === 'error' ? /0x[0-9a-f]{16}/.exec(m.halted.message)?.[0] : undefined)
const hex = (a: number) => '0x' + a.toString(16).padStart(16, '0')
const at = (k: number) => `    ldr x1, =${STACK_TOP}\n    sub x1, x1, #${k}\n`
const nzcv = (m: ArmMachine) => [FLAG_N, FLAG_Z, FLAG_C, FLAG_V].map((id) => Number(m.readRegister(id))).join('')

describe('block loads and stores at the edge of mapped memory', () => {
  // Memory ends at STACK_TOP: a block from STACK_TOP − k reaches k bytes in.
  const cases: [string, number, number][] = [
    // [instruction, element bytes, total bytes]
    ['ld1 {v0.16b-v3.16b}, [x1]', 1, 64],
    ['ld1 {v0.2d, v1.2d}, [x1]', 8, 32],
    ['ld4 {v0.4s-v3.4s}, [x1]', 4, 64],
    ['ld3 {v0.4h-v2.4h}, [x1]', 2, 24],
    ['st1 {v0.16b-v3.16b}, [x1]', 1, 64],
    ['st2 {v0.2d, v1.2d}, [x1]', 8, 32],
    ['st4 {v0.8h-v3.8h}, [x1]', 2, 64],
  ]
  for (const [op, eb, total] of cases)
    it(`${op} faults at the first element past the end, after the stores before it`, () => {
      for (let k = 1; k <= total; k++) {
        const m = run(at(k) + `    ${op}`)
        if (k === total) {
          expect(m.halted, op).toMatchObject({ kind: 'exit' })
          continue
        }
        // The first element with a byte at or past STACK_TOP.
        const first = STACK_TOP - k + Math.floor(k / eb) * eb
        expect(faultAddr(m), `${op} k=${k}`).toBe(hex(first))
        if (op.startsWith('st')) {
          for (let a = STACK_TOP - k; a < first; a++) expect(m.readByte(a), `${op} k=${k}`).not.toBe(0)
          for (let a = first; a < STACK_TOP; a++) expect(m.readByte(a), `${op} k=${k}`).toBe(0)
        }
      }
    })

  it('SVE ld1w faults at the first active element past the end, and inactive ones never fault', () => {
    for (let k = 1; k < 32; k++) {
      const m = run(at(k) + '    ptrue p0.s\n    ld1w {z4.s}, p0/z, [x1]')
      expect(faultAddr(m), `k=${k}`).toBe(hex(STACK_TOP - k + Math.floor(k / 4) * 4))
      // Only the elements that fit are active: no fault.
      const fit = Math.floor(k / 4)
      expect(run(at(k) + `    mov x3, #${fit}\n    whilelo p0.s, xzr, x3\n    ld1w {z4.s}, p0/z, [x1]`).halted, `k=${k}`).toMatchObject({ kind: 'exit' })
    }
  })

  it('SVE st1b stores the bytes before a fault, and nothing for a partial predicate past the end', () => {
    const m = run(at(5) + '    ptrue p0.s\n    st1b {z0.s}, p0, [x1]')
    expect(faultAddr(m)).toBe(hex(STACK_TOP))
    expect([0, 1, 2, 3, 4].map((i) => m.readByte(STACK_TOP - 5 + i))).toEqual([1, 5, 9, 13, 17])
    const p = run(at(5) + '    mov x3, #5\n    whilelo p0.s, xzr, x3\n    st1b {z0.s}, p0, [x1]')
    expect(p.halted).toMatchObject({ kind: 'exit' })
    expect([0, 1, 2, 3, 4].map((i) => p.readByte(STACK_TOP - 5 + i))).toEqual([1, 5, 9, 13, 17])
  })
})

describe('WHILE counts at the ends of the range', () => {
  /** Active .s elements of p0 at VL 256 (8 elements), and NZCV. */
  const ran = (op: string, a: bigint, b: bigint) => {
    const m = run(`    ldr x1, =${a}\n    ldr x2, =${b}\n    ${op} p0.s, x1, x2`)
    const v = BigInt(m.readRegister(P0))
    return [Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(4 * i)) & 1n)).join(''), nzcv(m)]
  }
  const U64 = 0xffff_ffff_ffff_ffffn
  const I64 = 0x7fff_ffff_ffff_ffffn
  it('counts up to the second operand, and forever when a non-strict compare names the largest value', () => {
    expect(ran('whilelo', 3n, 6n)).toEqual(['11100000', '1010'])
    expect(ran('whilelo', 6n, 3n)).toEqual(['00000000', '0110'])
    expect(ran('whilels', 3n, 6n)).toEqual(['11110000', '1010'])
    expect(ran('whilels', U64 - 2n, U64)).toEqual(['11111111', '1000'])
    expect(ran('whilelo', U64 - 2n, U64)).toEqual(['11000000', '1010'])
    expect(ran('whilele', I64 - 1n, I64)).toEqual(['11111111', '1000'])
    expect(ran('whilelt', -3n & U64, 2n)).toEqual(['11111000', '1010'])
    expect(ran('whilele', 5n, 5n)).toEqual(['10000000', '1010'])
  })
  it('counts down from the top for the decrementing forms', () => {
    expect(ran('whilehi', 6n, 3n)).toEqual(['00000111', '0000'])
    expect(ran('whilehs', 2n, 0n)).toEqual(['11111111', '1000'])
    expect(ran('whilege', -(1n << 63n) & U64, -(1n << 63n) & U64)).toEqual(['11111111', '1000'])
    expect(ran('whilegt', 3n, 3n)).toEqual(['00000000', '0110'])
    expect(ran('whilegt', 2n, -2n & U64)).toEqual(['00001111', '0000'])
  })
})
