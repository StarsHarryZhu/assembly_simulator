/**
 * SM3 and SM4, which this Mac's CPU lacks, against their standards' test vectors: SM4 encrypts the
 * GB/T 32907 example with SM4EKEY and SM4E, and SM3 hashes "abc" (GB/T 32905) with the usual
 * SM3SS1 / SM3TT / SM3PARTW instruction sequence. AES and the SHA instructions are covered natively.
 */
import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/isa/arm64/assembler'
import { createMachine } from '../../src/isa/arm64/cpu'
import { SBOXES } from '../../src/isa/arm64/instructions/crypto'
import { V0 } from '../../src/isa/arm64/registers'
import { ConsoleEnv } from '../helpers'

function run(src: string) {
  const r = assemble({ name: 't.s', text: src })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  const m = createMachine(r.program!, new ConsoleEnv())
  m.run(1_000_000, new Set())
  expect(m.halted).toEqual({ kind: 'exit', code: 0 })
  return m
}
/** Register v<n> as four 32-bit words, element 0 first. */
const words = (m: ReturnType<typeof run>, n: number) => {
  const v = m.readRegister(V0 + n) as bigint
  return [0, 1, 2, 3].map((i) => Number((v >> BigInt(32 * i)) & 0xffffffffn))
}
const hex = (w: number[]) => w.map((x) => x.toString(16).padStart(8, '0')).join(' ')
const wordList = (w: number[]) => w.map((x) => '0x' + x.toString(16)).join(', ')
const EXIT = 'mov x0, #0\n mov x8, #93\n svc #0'

describe('SM4', () => {
  it('builds the S-box from its algebraic definition', () => {
    expect(SBOXES.sm4.slice(0, 8)).toEqual([0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7])
    expect(SBOXES.sm4[0xff]).toBe(0x48)
    expect(SBOXES.aes.slice(0, 4)).toEqual([0x63, 0x7c, 0x77, 0x7b])
  })

  it('encrypts the standard example with SM4EKEY and SM4E', () => {
    const MK = [0x01234567, 0x89abcdef, 0xfedcba98, 0x76543210]
    const FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc]
    const CK = Array.from({ length: 32 }, (_, i) => {
      let w = 0
      for (let j = 0; j < 4; j++) w = (w << 8) | (((4 * i + j) * 7) & 0xff)
      return w >>> 0
    })
    const m = run(`
      .text
      .global _start
_start:
      adr x0, key
      ld1 {v0.4s}, [x0]
      adr x1, ck
      adr x2, pt
      ld1 {v1.4s}, [x2]
      mov x3, #8
1:    ld1 {v2.4s}, [x1], #16
      sm4ekey v0.4s, v0.4s, v2.4s
      sm4e v1.4s, v0.4s
      subs x3, x3, #1
      b.ne 1b
      ${EXIT}
      .data
key:  .word ${wordList(MK.map((k, i) => (k ^ FK[i]!) >>> 0))}
ck:   .word ${wordList(CK)}
pt:   .word ${wordList(MK)}
`)
    const x = words(m, 1)
    expect(hex([x[3]!, x[2]!, x[1]!, x[0]!])).toBe('681edf34 d206965e 86b3e94f 536e4246')
  })
})

describe('SM3', () => {
  it('hashes "abc" with the SM3 instructions', () => {
    const lines: string[] = []
    const round = (ab: string, s0: string, t0: string, t1: string, i: number) =>
      lines.push(`sm3ss1 v5.4s, v8.4s, ${t0}.4s, v9.4s`, `shl ${t1}.4s, ${t0}.4s, #1`, `sri ${t1}.4s, ${t0}.4s, #31`, `sm3tt1${ab} v8.4s, v5.4s, v10.s[${i}]`, `sm3tt2${ab} v9.4s, v5.4s, ${s0}.s[${i}]`)
    const qround = (ab: string, s0: string, s1: string, s2?: string, s3?: string, s4?: string) => {
      if (s4) lines.push(`ext ${s4}.16b, ${s1}.16b, ${s2}.16b, #12`, `ext v6.16b, ${s0}.16b, ${s1}.16b, #12`, `ext v7.16b, ${s2}.16b, ${s3}.16b, #8`, `sm3partw1 ${s4}.4s, ${s0}.4s, ${s3}.4s`)
      lines.push(`eor v10.16b, ${s0}.16b, ${s1}.16b`)
      round(ab, s0, 'v11', 'v12', 0)
      round(ab, s0, 'v12', 'v11', 1)
      round(ab, s0, 'v11', 'v12', 2)
      round(ab, s0, 'v12', 'v11', 3)
      if (s4) lines.push(`sm3partw2 ${s4}.4s, v7.4s, v6.4s`)
    }
    lines.push('ext v11.16b, v13.16b, v13.16b, #4')
    qround('a', 'v0', 'v1', 'v2', 'v3', 'v4')
    qround('a', 'v1', 'v2', 'v3', 'v4', 'v0')
    qround('a', 'v2', 'v3', 'v4', 'v0', 'v1')
    qround('a', 'v3', 'v4', 'v0', 'v1', 'v2')
    lines.push('ext v11.16b, v14.16b, v14.16b, #4')
    qround('b', 'v4', 'v0', 'v1', 'v2', 'v3')
    qround('b', 'v0', 'v1', 'v2', 'v3', 'v4')
    qround('b', 'v1', 'v2', 'v3', 'v4', 'v0')
    qround('b', 'v2', 'v3', 'v4', 'v0', 'v1')
    qround('b', 'v3', 'v4', 'v0', 'v1', 'v2')
    qround('b', 'v4', 'v0', 'v1', 'v2', 'v3')
    qround('b', 'v0', 'v1', 'v2', 'v3', 'v4')
    qround('b', 'v1', 'v2', 'v3', 'v4', 'v0')
    qround('b', 'v2', 'v3', 'v4', 'v0', 'v1')
    qround('b', 'v3', 'v4')
    qround('b', 'v4', 'v0')
    qround('b', 'v0', 'v1')
    const block = [0x61, 0x62, 0x63, 0x80, ...Array<number>(59).fill(0), 0x18]
    const m = run(`
      .text
      .global _start
_start:
      adr x0, state
      ld1 {v8.4s-v9.4s}, [x0]
      rev64 v8.4s, v8.4s
      rev64 v9.4s, v9.4s
      ext v8.16b, v8.16b, v8.16b, #8
      ext v9.16b, v9.16b, v9.16b, #8
      adr x8, consts
      ldp s13, s14, [x8]
      adr x1, block
      ld1 {v0.16b-v3.16b}, [x1], #64
      mov v15.16b, v8.16b
      mov v16.16b, v9.16b
      rev32 v0.16b, v0.16b
      rev32 v1.16b, v1.16b
      rev32 v2.16b, v2.16b
      rev32 v3.16b, v3.16b
      ${lines.join('\n      ')}
      eor v8.16b, v8.16b, v15.16b
      eor v9.16b, v9.16b, v16.16b
      rev64 v8.4s, v8.4s
      rev64 v9.4s, v9.4s
      ext v8.16b, v8.16b, v8.16b, #8
      ext v9.16b, v9.16b, v9.16b, #8
      ${EXIT}
      .data
state:  .word 0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e
consts: .word 0x79cc4519, 0x9d8a7a87
block:  .byte ${block.join(', ')}
`)
    expect(hex([...words(m, 8), ...words(m, 9)])).toBe('66c7f0f4 62eeedd9 d1f2d46b dc10e4e2 4167c487 5cf2f7a2 297da02b 8f4ba8e0')
  })
})
