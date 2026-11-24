/**
 * The SVE instructions this Mac's CPU forbids in streaming mode, so the native fixtures cannot hold them:
 * first-fault and non-fault loads with the FFR, gathers and scatters, FADDA, the trigonometric helpers,
 * COMPACT, ADR, the quadword permutes, LD1RO, and the SVE2 crypto, bit-permute, histogram and matrix
 * instructions. Where Neon has the same operation (natively checked), each 128-bit segment must match it;
 * elsewhere the expected values follow the Arm architecture's description.
 */
import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/isa/arm64/assembler'
import { createMachine, type ArmMachine } from '../../src/isa/arm64/cpu'
import { FFR, FLAG_C, FLAG_N, FLAG_V, FLAG_Z, P0, V0, Z0 } from '../../src/isa/arm64/registers'
import { rng } from '../../scripts/native/state'
import { ConsoleEnv } from '../helpers'

const EXIT = '\n mov x0, #0\n mov x8, #93\n svc #0'

/** Run a program at a vector length (bits); returns the machine. */
function run(src: string, vl = 256, halt: unknown = { kind: 'exit', code: 0 }): ArmMachine {
  const r = assemble({ name: 't.s', text: src + EXIT })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  const m = createMachine(r.program!, new ConsoleEnv(), { settings: { vl } })
  m.run(1_000_000, new Set())
  expect(m.halted).toMatchObject(halt as object)
  return m
}
/** The elements of z<n> of size 8 << es bits, element 0 first. */
function zel(m: ArmMachine, n: number, es: number): bigint[] {
  const v = BigInt(m.readRegister(Z0 + n))
  const bits = 8 << es
  return Array.from({ length: (m.vl * 8) / bits }, (_, i) => (v >> BigInt(i * bits)) & ((1n << BigInt(bits)) - 1n))
}
/** The elements of a predicate (or FFR, n = 16) of size 8 << es bits, as booleans. */
function pel(m: ArmMachine, n: number, es: number): boolean[] {
  const v = BigInt(m.readRegister(P0 + n))
  return Array.from({ length: m.vl >> es }, (_, i) => ((v >> BigInt(i << es)) & 1n) === 1n)
}
const nzcv = (m: ArmMachine) => [FLAG_N, FLAG_Z, FLAG_C, FLAG_V].map((id) => Number(m.readRegister(id))).join('')
const words = (vals: (number | bigint)[], dir = '.word') => `${dir} ${vals.join(', ')}`
const f32 = (x: number) => BigInt(new Uint32Array(new Float32Array([x]).buffer)[0]!)
const f64 = (x: number) => new BigUint64Array(new Float64Array([x]).buffer)[0]!

describe('first-fault and non-fault loads', () => {
  // 4096 bytes of data: the region ends at the next page, so element 1 of a load at base+4088 faults.
  const DATA = `.data\nbase: .quad ${Array.from({ length: 512 }, (_, i) => i + 1).join(', ')}\n.text\n.global _start\n_start:\n ldr x0, =base\n add x1, x0, #4088\n ptrue p0.d\n`

  it('LD1D faults when any active element is outside memory', () => {
    run(DATA + ' ld1d { z0.d }, p0/z, [x1]', 256, { kind: 'error', code: 'sigsegv' })
  })

  it('LDFF1D loads up to the first fault and clears the FFR from there', () => {
    const m = run(DATA + ' setffr\n ldff1d { z0.d }, p0/z, [x1]\n rdffr p1.b')
    expect(zel(m, 0, 3)[0]).toBe(512n)
    expect(pel(m, 16, 3)).toEqual([true, false, false, false])
    expect(pel(m, 1, 3)).toEqual([true, false, false, false])
  })

  it('LDFF1D still faults on the first active element', () => {
    run(DATA + ' add x1, x1, #8\n setffr\n ldff1d { z0.d }, p0/z, [x1]', 256, { kind: 'error', code: 'sigsegv' })
  })

  it('LDNF1D never faults: it clears the FFR from the first element it cannot read', () => {
    const m = run(DATA + ' add x1, x1, #8\n setffr\n ldnf1d { z0.d }, p0/z, [x1]\n ptrue p2.b\n rdffrs p1.b, p2/z')
    expect(pel(m, 16, 3)).toEqual([false, false, false, false])
    // No element true: N = 0, Z = 1, C = 1.
    expect(nzcv(m)).toBe('0110')
  })

  it('a gathering LDFF1D clears the FFR from the faulting element, in element order', () => {
    // Addresses base, base + 8, base + 16 + 64 KiB (outside memory), base + 24.
    const m = run(DATA + ' index z1.d, x0, #8\n ptrue p3.d, vl3\n ptrue p4.d, vl2\n bic p5.b, p0/z, p3.b, p4.b\n mov x2, #0x10000\n dup z2.d, x2\n add z1.d, p5/m, z1.d, z2.d\n setffr\n ldff1d { z0.d }, p0/z, [z1.d]\n rdffr p1.b')
    expect(zel(m, 0, 3)).toEqual([1n, 2n, 0n, 0n])
    expect(pel(m, 16, 3)).toEqual([true, true, false, false])
  })

  it('WRFFR and RDFFR move the FFR through a predicate', () => {
    const m = run(DATA + ' ptrue p1.s, vl3\n wrffr p1.b\n rdffr p2.b')
    expect(pel(m, 2, 2).slice(0, 4)).toEqual([true, true, true, false])
  })
})

describe('gathers and scatters', () => {
  const ARR = `.data\narr: ${words(Array.from({ length: 16 }, (_, i) => 100 + i), '.quad')}\nout: .skip 128\n.text\n.global _start\n_start:\n ldr x0, =arr\n ldr x5, =out\n ptrue p0.d\n`

  it('gathers with scaled vector offsets and vector bases', () => {
    const m = run(ARR + ' index z1.d, #3, #-1\n ld1d { z0.d }, p0/z, [x0, z1.d, lsl #3]\n mov x3, #16\n index z2.d, x0, x3\n ld1d { z3.d }, p0/z, [z2.d, #8]\n ld1w { z4.d }, p0/z, [x0, z1.d, lsl #2]')
    expect(zel(m, 0, 3)).toEqual([103n, 102n, 101n, 100n])
    expect(zel(m, 3, 3)).toEqual([101n, 103n, 105n, 107n])
    // Words of the quad array: word 2k is the low half of quad k, word 2k + 1 its zero high half.
    expect(zel(m, 4, 3)).toEqual([0n, 101n, 0n, 100n])
  })

  it('scatters and loads back', () => {
    const m = run(ARR + ' index z0.d, #10, #1\n index z1.d, #0, #2\n st1d { z0.d }, p0, [x5, z1.d, lsl #3]\n ld1d { z2.d }, p0/z, [x5]\n ld1d { z3.d }, p0/z, [x5, #1, mul vl]')
    expect(zel(m, 2, 3)).toEqual([10n, 0n, 11n, 0n])
    expect(zel(m, 3, 3)).toEqual([12n, 0n, 13n, 0n])
  })

  it('LD1Q and ST1Q move quadwords at the even doubleword of each base pair', () => {
    const m = run(ARR + ' mov x3, #16\n index z1.d, x0, x3\n mov x2, #0\n ptrue p1.b\n ld1q { z0.q }, p1/z, [z1.d, x2]\n mov x3, #32\n index z3.d, x5, x3\n st1q { z0.q }, p1, [z3.d, x2]\n ld1d { z4.d }, p0/z, [x5]')
    // Quadword e comes from z1.d[2e] = arr + 32e: quads 0 and 2 of the array.
    expect(zel(m, 0, 3)).toEqual([100n, 101n, 104n, 105n])
    // Stored at z3.d[2e] = out + 64e: quadword 0 at out, quadword 1 at out + 64.
    expect(zel(m, 4, 3)).toEqual([100n, 101n, 0n, 0n])
  })

  it('LD1ROB replicates 32 bytes into each 256-bit segment', () => {
    const m = run(ARR + ' ptrue p1.b\n ld1rob { z0.b }, p1/z, [x0]', 512)
    const z = zel(m, 0, 3)
    expect(z).toEqual([100n, 101n, 102n, 103n, 100n, 101n, 102n, 103n])
  })
})

describe('FADDA and the trigonometric helpers', () => {
  const S = (vals: number[]) => `.data\nv: ${words(vals.map(f32))}\n.text\n.global _start\n_start:\n ldr x0, =v\n ptrue p0.s\n ld1w { z1.s }, p0/z, [x0]\n`

  it('FADDA adds strictly in element order', () => {
    // In order: ((0 + 1e8) + 1) − 1e8 = 0 in single precision; a tree would give 1.
    const m = run(S([1e8, 1, -1e8, 0, 0, 0, 0, 0]) + ' fmov s0, wzr\n fadda s0, p0, s0, z1.s')
    expect(zel(m, 0, 2)[0]).toBe(0n)
  })

  it('FEXPA builds 2^(i/64) from the exponent field and a fraction table', () => {
    const m = run(`.global _start\n_start:\n mov w1, #${(127 << 6) | 32}\n dup z1.s, w1\n fexpa z0.s, z1.s\n mov x2, #${(1023 << 6) | 32}\n dup z2.d, x2\n fexpa z3.d, z2.d\n mov w4, #${(15 << 5) | 16}\n dup z4.h, w4\n fexpa z5.h, z4.h`)
    expect(zel(m, 0, 2)[0]).toBe(0x3fb504f3n) // √2 in single precision
    expect(zel(m, 3, 3)[0]).toBe(0x3ff6a09e667f3bcdn) // √2 in double precision
    expect(zel(m, 5, 1)[0]).toBe(0x3da8n) // √2 in half precision
  })

  it('FTSSEL picks 1.0 or the input by bit 0 and flips the sign by bit 1', () => {
    const m = run(`.global _start\n_start:\n fmov z1.s, #3.0\n index z2.s, #0, #1\n ftssel z0.s, z1.s, z2.s`)
    expect(zel(m, 0, 2).slice(0, 4)).toEqual([f32(3), f32(1), f32(-3), f32(-1)])
  })

  it('FTSMUL squares and takes the sign from bit 0', () => {
    const m = run(`.global _start\n_start:\n fmov z1.d, #-3.0\n index z2.d, #0, #1\n ftsmul z0.d, z1.d, z2.d`)
    expect(zel(m, 0, 3)).toEqual([f64(9), f64(-9), f64(9), f64(-9)])
  })

  it('FTMAD adds the sine coefficient for a positive Zm and the cosine one for a negative Zm', () => {
    const m = run(`.global _start\n_start:\n fmov z0.s, #0.0\n fmov z1.s, #2.0\n ftmad z0.s, z0.s, z1.s, #1\n fmov z2.s, #0.0\n fmov z3.s, #-2.0\n ftmad z2.s, z2.s, z3.s, #1\n fmov z4.d, #2.0\n fmov z5.d, #-3.0\n ftmad z4.d, z4.d, z5.d, #0`)
    expect(zel(m, 0, 2)[0]).toBe(0xbe2aaaabn) // −1/6
    expect(zel(m, 2, 2)[0]).toBe(0xbf000000n) // −1/2
    expect(zel(m, 4, 3)[0]).toBe(f64(7)) // 2 × |−3| + 1
  })
})

describe('COMPACT, ADR and the quadword permutes', () => {
  it('COMPACT packs the active elements low and zeroes the rest', () => {
    const m = run(`.global _start\n_start:\n index z1.s, #1, #1\n ptrue p0.s\n index z3.s, #0, #1\n and z3.s, z3.s, #1\n cmpeq p1.s, p0/z, z3.s, #0\n compact z0.s, p1, z1.s`)
    expect(zel(m, 0, 2)).toEqual([1n, 3n, 5n, 7n, 0n, 0n, 0n, 0n])
  })

  it('ADR adds scaled (and extended) offsets to vector bases', () => {
    const m = run(`.global _start\n_start:\n index z1.d, #0, #8\n index z2.d, #-2, #1\n adr z0.d, [z1.d, z2.d, lsl #2]\n adr z3.d, [z1.d, z2.d, sxtw #1]\n adr z4.d, [z1.d, z2.d, uxtw]`)
    expect(zel(m, 0, 3)).toEqual([-8n, 4n, 16n, 28n].map((v) => BigInt.asUintN(64, v)))
    expect(zel(m, 3, 3)).toEqual([-4n, 6n, 16n, 26n].map((v) => BigInt.asUintN(64, v)))
    expect(zel(m, 4, 3)).toEqual([0xfffffffen, 0xffffffffn + 8n, 16n, 25n])
  })

  it('ZIP, UZP and TRN on quadwords move 128-bit granules', () => {
    const src = `.global _start\n_start:\n index z1.d, #0, #1\n mov x0, #100\n index z2.d, x0, #1\n`
    const q = (m: ArmMachine, n: number) => zel(m, n, 3).filter((_, i) => i % 2 === 0).map((v) => (v >= 100n ? `b${(v - 100n) / 2n}` : `a${v / 2n}`))
    const m = run(src + ' zip1 z3.q, z1.q, z2.q\n zip2 z4.q, z1.q, z2.q\n uzp1 z5.q, z1.q, z2.q\n uzp2 z6.q, z1.q, z2.q\n trn1 z7.q, z1.q, z2.q\n trn2 z8.q, z1.q, z2.q', 512)
    expect(q(m, 3)).toEqual(['a0', 'b0', 'a1', 'b1'])
    expect(q(m, 4)).toEqual(['a2', 'b2', 'a3', 'b3'])
    expect(q(m, 5)).toEqual(['a0', 'a2', 'b0', 'b2'])
    expect(q(m, 6)).toEqual(['a1', 'a3', 'b1', 'b3'])
    expect(q(m, 7)).toEqual(['a0', 'b0', 'a2', 'b2'])
    expect(q(m, 8)).toEqual(['a1', 'b1', 'a3', 'b3'])
  })
})

describe('SVE2 histograms, matches and bit permutes', () => {
  const V = (z1: number[], z2: number[], dir = '.word') => `.data\na: ${words(z1, dir)}\nb: ${words(z2, dir)}\n.text\n.global _start\n_start:\n ldr x0, =a\n ldr x1, =b\n ptrue p0.b\n ld1b { z1.b }, p0/z, [x0]\n ld1b { z2.b }, p0/z, [x1]\n`

  it('HISTCNT counts the matching active elements up to each one', () => {
    const m = run(V([1, 2, 1, 3], [1, 1, 2, 1]) + ' ptrue p1.s\n histcnt z0.s, p1/z, z1.s, z2.s', 128)
    expect(zel(m, 0, 2)).toEqual([1n, 0n, 2n, 0n])
  })

  it('HISTSEG counts equal bytes in the same 128-bit segment', () => {
    const m = run(V([0x03020101, 0, 0, 0], [0x01010101, 0x02, 0, 0x03030303]) + ' histseg z0.b, z1.b, z2.b', 128)
    // Byte values of z1: 1, 1, 2, 3, then 0s; z2 holds four 1s, one 2, seven 0s... and four 3s.
    expect(zel(m, 0, 0).slice(0, 5)).toEqual([4n, 4n, 1n, 4n, 7n])
  })

  it('MATCH and NMATCH test each element against its segment and set the flags', () => {
    const m = run(V([0x00090501, 0, 0, 0], [0x0a050403, 0, 0, 0], '.word') + ' ptrue p1.h, vl2\n match p2.h, p1/z, z1.h, z2.h\n mrs x3, nzcv\n nmatch p3.h, p1/z, z1.h, z2.h', 128)
    // Halfwords of z1: 0x0501, 0x0009; of z2: 0x0403, 0x0a05, 0, ...: 0x0501 has no match, 0x0009 neither.
    expect(pel(m, 2, 1).slice(0, 2)).toEqual([false, false])
    expect(pel(m, 3, 1).slice(0, 2)).toEqual([true, true])
    expect(BigInt(m.readRegister(3)) >> 28n).toBe(0b0110n)
  })

  it('BEXT, BDEP and BGRP gather, scatter and group bits', () => {
    const m = run(V([0b10110110], [0b11110000]) + ' bext z3.s, z1.s, z2.s\n bdep z4.s, z3.s, z2.s\n bgrp z5.s, z1.s, z2.s', 128)
    expect(zel(m, 3, 2)[0]).toBe(0b1011n)
    expect(zel(m, 4, 2)[0]).toBe(0b10110000n)
    // The bits under 1s (1011) low, the bits under 0s (0110, then the zero bits above) next.
    expect(zel(m, 5, 2)[0]).toBe(0b01101011n)
  })
})

describe('SVE2 crypto and matrix multiplies match Neon in every 128-bit segment', () => {
  const r = rng(99)
  const block = Array.from({ length: 4 * 32 }, () => Math.floor(r() * 256))
  const DATA = `.data\nblk: .byte ${block.join(', ')}\n.text\n.global _start\n_start:\n ldr x0, =blk\n`
  /** z0–z3 from the four 32-byte blocks (VL 256), run one SVE line, return z0. */
  const sve = (line: string) => {
    const m = run(DATA + ' ldr z0, [x0]\n ldr z1, [x0, #1, mul vl]\n ldr z2, [x0, #2, mul vl]\n ldr z3, [x0, #3, mul vl]\n' + line)
    return BigInt(m.readRegister(Z0))
  }
  /** v0–v3 from segment `seg` of the same blocks, run one Neon line, return v0. */
  const neon = (line: string, seg: number) => {
    const m = run(DATA + [0, 1, 2, 3].map((n) => ` ldr q${n}, [x0, #${n * 32 + seg * 16}]`).join('\n') + '\n' + line)
    return BigInt(m.readRegister(V0)) & ((1n << 128n) - 1n)
  }
  const segs = (v: bigint) => [v & ((1n << 128n) - 1n), v >> 128n]

  for (const [sveLine, neonLine] of [
    ['aese z0.b, z0.b, z1.b', 'aese v0.16b, v1.16b'],
    ['aesd z0.b, z0.b, z1.b', 'aesd v0.16b, v1.16b'],
    ['aesmc z0.b, z0.b', 'aesmc v0.16b, v0.16b'],
    ['aesimc z0.b, z0.b', 'aesimc v0.16b, v0.16b'],
    ['sm4e z0.s, z0.s, z1.s', 'sm4e v0.4s, v1.4s'],
    ['sm4ekey z0.s, z1.s, z2.s', 'sm4ekey v0.4s, v1.4s, v2.4s'],
    ['rax1 z0.d, z1.d, z2.d', 'rax1 v0.2d, v1.2d, v2.2d'],
    ['pmullb z0.q, z1.d, z2.d', 'pmull v0.1q, v1.1d, v2.1d'],
    ['pmullt z0.q, z1.d, z2.d', 'pmull2 v0.1q, v1.2d, v2.2d'],
    ['smmla z0.s, z1.b, z2.b', 'smmla v0.4s, v1.16b, v2.16b'],
    ['ummla z0.s, z1.b, z2.b', 'ummla v0.4s, v1.16b, v2.16b'],
    ['usmmla z0.s, z1.b, z2.b', 'usmmla v0.4s, v1.16b, v2.16b'],
    ['bfmmla z0.s, z1.h, z2.h', 'bfmmla v0.4s, v1.8h, v2.8h'],
  ])
    it(sveLine.split(' ')[0]!, () => {
      expect(segs(sve(sveLine))).toEqual([neon(neonLine, 0), neon(neonLine, 1)])
    })

  it('FMMLA multiplies 2×2 matrices per segment (single) and per 256 bits (double)', () => {
    // Zn rows (1, 2) and (3, 4); Zm rows (5, 6) and (7, 8); Zda starts at 0.5 everywhere.
    const s = (vals: number[]) => vals.map(f32).join(', ')
    const m = run(`.data\nn: .word ${s([1, 2, 3, 4])}\nmm: .word ${s([5, 6, 7, 8])}\nnd: .quad ${[1, 2, 3, 4].map(f64).join(', ')}\nmd: .quad ${[5, 6, 7, 8].map(f64).join(', ')}\n.text\n.global _start\n_start:\n ldr x0, =n\n ldr x1, =mm\n ldr x2, =nd\n ldr x3, =md\n ptrue p0.b\n ld1rqw { z1.s }, p0/z, [x0]\n ld1rqw { z2.s }, p0/z, [x1]\n fmov z0.s, #0.5\n fmmla z0.s, z1.s, z2.s\n ld1d { z3.d }, p0/z, [x2]\n ld1d { z4.d }, p0/z, [x3]\n fmov z5.d, #0.5\n fmmla z5.d, z3.d, z4.d`)
    // Zda[i][j] += sum_k Zn[i][k] × Zm[j][k]: 1·5+2·6, 1·7+2·8, 3·5+4·6, 3·7+4·8.
    expect(zel(m, 0, 2).slice(0, 4)).toEqual([17.5, 23.5, 39.5, 53.5].map(f32))
    expect(zel(m, 5, 3)).toEqual([17.5, 23.5, 39.5, 53.5].map(f64))
  })

  it('FMMLA on doublewords is undefined below a 256-bit vector', () => {
    run('.global _start\n_start:\n fmmla z0.d, z1.d, z2.d', 128, { kind: 'error', code: 'sigill' })
  })
})
