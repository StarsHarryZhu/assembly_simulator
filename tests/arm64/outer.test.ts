/**
 * SME outer products have fast paths: integer sums of 8- and 16-bit products on numbers, and single-precision
 * FMOPA/FMOPS on the native floating-point path. These check the integer forms against sums computed here
 * from the registers, and the single-precision forms against the exact path (sf.fast.on = false), on random
 * tiles, vectors and predicates with every special value and every FPCR mode.
 */
import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/isa/arm64/assembler'
import { createMachine, type ArmMachine } from '../../src/isa/arm64/cpu'
import { P0, Z0, ZA } from '../../src/isa/arm64/registers'
import * as sf from '../../src/isa/arm64/softfloat'
import { ConsoleEnv } from '../helpers'

/** A deterministic generator of 32-bit words (mulberry32). */
function gen(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
}

const SPECIAL = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0xffc00001, 1, 0x807fffff, 0x3f800000, 0xbf800000, 0x7f7fffff, 0x00800000, 0x4b000000]

/** Words for registers and ZA: random bits, specials, and floats of every exponent range. */
function words(w: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const k = w() % 4
    const v = k === 0 ? w() : k === 1 ? SPECIAL[w() % SPECIAL.length]! : ((w() & 0x80000000) | ((60 + (w() % 140)) << 23) | (w() & 0x7fffff)) >>> 0
    out.push('0x' + v.toString(16))
  }
  return out.join(', ')
}

/** ZA, z1, z2, p0 and p1 from random data (the predicates all true a third of the time), then `op`. */
function program(op: string, w: () => number, fpcr: number): string {
  const preds = w() % 3 === 0 ? Array(16).fill('0xffffffff').join(', ') : words(w, 16)
  return `_start:
    smstart
    ldr x0, =${fpcr}
    msr fpcr, x0
    adr x1, zdata
    adr x2, pdata
    adr x3, zadata
    ldr z1, [x1]
    ldr z2, [x1, #1, mul vl]
    ldr p0, [x2]
    ldr p1, [x2, #1, mul vl]
    rdsvl x9, #1
    mov w12, #0
1:  ldr za[w12, 0], [x3]
    add x3, x3, x9
    add w12, w12, #1
    cmp x12, x9
    b.ne 1b
    ${op}
    mov x0, #0
    mov x8, #93
    svc #0
.data
.p2align 6
zdata: .word ${words(w, 128)}
pdata: .word ${preds}
zadata: .word ${words(w, 4096)}
`
}

function run(text: string, svl: number): ArmMachine {
  const r = assemble({ name: 'o.s', text })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  const m = createMachine(r.program!, new ConsoleEnv(), { settings: { svl } })
  m.run(1_000_000, new Set())
  expect(m.halted).toMatchObject({ kind: 'exit' })
  return m
}

/** Little-endian element `i` of size `bytes` from a byte array, as an unsigned bigint. */
function elem(b: Uint8Array, i: number, bytes: number): bigint {
  let v = 0n
  for (let k = bytes - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[i * bytes + k]!)
  return v
}

describe('SME integer outer products', () => {
  // [instruction, tile element bytes, source element bytes, tile, Zn unsigned, Zm unsigned, subtract]
  const OPS: [string, number, number, number, boolean, boolean, boolean][] = [
    ['smopa za2.s, p0/m, p1/m, z1.b, z2.b', 4, 1, 2, false, false, false],
    ['umops za3.s, p0/m, p1/m, z1.b, z2.b', 4, 1, 3, true, true, true],
    ['sumopa za0.s, p0/m, p1/m, z1.b, z2.b', 4, 1, 0, false, true, false],
    ['usmops za1.s, p0/m, p1/m, z1.b, z2.b', 4, 1, 1, true, false, true],
    ['smopa za2.d, p0/m, p1/m, z1.h, z2.h', 8, 2, 2, false, false, false],
    ['umops za7.d, p0/m, p1/m, z1.h, z2.h', 8, 2, 7, true, true, true],
    ['sumopa za3.d, p0/m, p1/m, z1.h, z2.h', 8, 2, 3, false, true, false],
    ['usmops za6.d, p0/m, p1/m, z1.h, z2.h', 8, 2, 6, true, false, true],
    ['smopa za1.s, p0/m, p1/m, z1.h, z2.h', 4, 2, 1, false, false, false],
    ['umops za0.s, p0/m, p1/m, z1.h, z2.h', 4, 2, 0, true, true, true],
  ]
  for (const [op, tb, sb, t, uN, uM, sub] of OPS)
    it(`${op} adds the sums of the active products`, () => {
      const w = gen(tb * 1000 + sb * 100 + t * 10 + (sub ? 1 : 0))
      for (let n = 0; n < 6; n++) {
        const svl = n % 2 ? 512 : 256
        const text = program(op, w, 0)
        const before = run(text.replace(op, ''), svl)
        const after = run(text, svl)
        const s = svl / 8
        const N = before.readRegisterBytes(Z0 + 1)
        const M = before.readRegisterBytes(Z0 + 2)
        const PN = before.readRegisterBytes(P0)
        const PM = before.readRegisterBytes(P0 + 1)
        const za0 = before.readRegisterBytes(ZA)
        const za1 = after.readRegisterBytes(ZA)
        const k = tb / sb
        const d = s / tb
        const bits = BigInt(tb * 8)
        const val = (b: Uint8Array, i: number, unsigned: boolean) => (unsigned ? elem(b, i, sb) : BigInt.asIntN(sb * 8, elem(b, i, sb)))
        // A predicate bit governs each vector byte: an element's is the one of its first byte.
        const on = (p: Uint8Array, i: number) => ((p[(i * sb) >> 3]! >> ((i * sb) & 7)) & 1) === 1
        for (let i = 0; i < d; i++) {
          // Horizontal slice i of tile t is ZA row i × (tile element bytes) + t.
          const row = (i * tb + t) * s
          for (let j = 0; j < d; j++) {
            let sum = 0n
            let any = false
            for (let p = 0; p < k; p++)
              if (on(PN, i * k + p) && on(PM, j * k + p)) {
                any = true
                sum += val(N, i * k + p, uN) * val(M, j * k + p, uM)
              }
            const old = elem(za0.subarray(row), j, tb)
            const want = any ? BigInt.asUintN(Number(bits), sub ? old - sum : old + sum) : old
            expect(elem(za1.subarray(row), j, tb), `${op} svl ${svl} [${i}][${j}]`).toBe(want)
          }
        }
        // The other tiles and rows are untouched.
        for (let r = 0; r < s; r++) if (r % tb !== t) expect(za1.subarray(r * s, r * s + s)).toEqual(za0.subarray(r * s, r * s + s))
      }
    })
})

describe('SME single-precision outer products', () => {
  const FPCRS = [0, sf.FZ, sf.DN, sf.AH, sf.FIZ, sf.FZ | sf.AH, 1 << 22, 2 << 22, 3 << 22]
  for (const op of ['fmopa za0.s, p0/m, p1/m, z1.s, z2.s', 'fmops za3.s, p0/m, p1/m, z1.s, z2.s'])
    it(`${op} gives what the exact path gives, in every FPCR mode`, () => {
      const w = gen(op.length)
      for (let n = 0; n < 18; n++) {
        const svl = n % 2 ? 512 : 256
        const text = program(op, w, FPCRS[n % FPCRS.length]!)
        const fast = run(text, svl)
        sf.fast.on = false
        try {
          const exact = run(text, svl)
          expect(fast.readRegisterBytes(ZA), `${op} case ${n}`).toEqual(exact.readRegisterBytes(ZA))
        } finally {
          sf.fast.on = true
        }
      }
    })
})
