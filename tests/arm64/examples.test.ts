/** The AArch64 example programs: both languages hold the same code, the formatter leaves them alone, and each runs as expected. */
import { describe, expect, it } from 'vitest'
import { arm64 } from '../../src/isa/arm64'
import { formatSource } from '../../src/isa/arm64/format'
import { codeOf } from '../../src/core/source'
import { ConsoleEnv } from '../helpers'

const code = (text: string) =>
  text
    .split('\n')
    .map((l) => codeOf(l, '//').trimEnd())
    .join('\n')
const CJK = /[　-鿿＀-￯]/

function run(text: string, stdin = '', vl?: number, svl?: number) {
  const r = arm64.assemble({ name: 'example.s', text })
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  const env = new ConsoleEnv(stdin)
  const m = arm64.createMachine(r.program!, env, vl || svl ? { settings: { ...(vl ? { vl } : {}), ...(svl ? { svl } : {}) } } : undefined)
  m.run(1_000_000, new Set())
  return { out: env.output, halt: m.halted }
}

/** The sme example's product: A, then the sum of each row of A. */
const SME_C = '    1    2    3    6\n    4    5    6   15\n    7    8    9   24\n   10   11   12   33\n'

const EXPECTED: Record<string, { stdin?: string; out: string }> = {
  welcome: { out: '1 + 2 + ... + 10 = 55\n' },
  hello: { out: 'Hello, AArch64!\n' },
  'hello-printf': { out: 'Hello from printf!\ndec 42, hex ff, negative -7, string arm, char A\n' },
  factorial: { out: Array.from({ length: 11 }, (_, n) => `${String(n).padStart(2)}! = ${[1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800][n]}\n`).join('') },
  input: { stdin: '6 7\nAda\n', out: 'Two numbers: 6 + 7 = 13\n6 * 7 = 42\nYour name: Hello, Ada!\n' },
  heap: { out: Array.from({ length: 10 }, (_, i) => `${i} squared is ${i * i}\n`).join('') },
  float: {
    out:
      'step 1: x = 1.5\nstep 2: x = 1.4166666666666665\nstep 3: x = 1.4142156862745097\nstep 4: x = 1.4142135623746899\n' +
      'step 5: x = 1.4142135623730949\nfsqrt:  x = 1.4142135623730951, difference -2.22045e-16\n' +
      'as float: 1.41421354, x * 10^6 rounded: 1414214\n',
  },
  simd: { out: 'a . b = 816\n1^2 + 2^2 + ... + 16^2 = 1496\n' },
  sve: { out: 'sum of a*x + y = 399, VL = 256 bits, 3 rounds\n' },
  sme: { out: SME_C + 'SVL = 512 bits, za0.s is 16 x 16 floats\n' },
  exceptions: { out: '  exception: EC = 0x24 at 0x400010\n  exception: EC = 0x3c at 0x400014\nBack in main after two exceptions.\n' },
}

describe('examples', () => {
  it('are all here, in menu order', () => {
    expect(arm64.examples.map((e) => e.id)).toEqual(Object.keys(EXPECTED))
  })

  for (const e of arm64.examples) {
    it(`${e.id}: same code in both languages, already formatted`, () => {
      expect(e.text.en).not.toBe(e.text.zh)
      expect(code(e.text.en)).toBe(code(e.text.zh))
      expect(CJK.test(e.text.en)).toBe(false)
      expect(formatSource(e.text.zh)).toBe(e.text.zh)
      expect(formatSource(e.text.en)).toBe(e.text.en)
    })

    it(`${e.id}: runs to the end with the expected output`, () => {
      const want = EXPECTED[e.id]!
      for (const text of [e.text.zh, e.text.en]) {
        const { out, halt } = run(text, want.stdin)
        expect(halt).toEqual({ kind: 'exit', code: 0 })
        expect(out).toBe(want.out)
      }
    })
  }

  it('sve: the same sum at every vector length, in fewer rounds as it grows', () => {
    const sve = arm64.examples.find((e) => e.id === 'sve')!
    for (const [vl, rounds] of [
      [128, 5],
      [512, 2],
      [2048, 1],
    ])
      expect(run(sve.text.en, '', vl).out).toBe(`sum of a*x + y = 399, VL = ${vl} bits, ${rounds} rounds\n`)
  })

  it('sme: the same product at every streaming vector length', () => {
    const sme = arm64.examples.find((e) => e.id === 'sme')!
    for (const svl of [128, 256, 1024, 2048]) expect(run(sme.text.en, '', undefined, svl).out).toBe(`${SME_C}SVL = ${svl} bits, za0.s is ${svl / 32} x ${svl / 32} floats\n`)
  })
})
