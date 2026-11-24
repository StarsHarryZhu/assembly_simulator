/**
 * Advanced SIMD integer instructions, vector and scalar: three same, three different (long, wide and
 * narrow, with the "2" forms on the upper halves), two-register miscellaneous, across lanes, pairwise
 * addition. Shifts, copies, permutes, table lookups, immediates and by-element forms are in simd-more.ts.
 * Elements are unsigned bigints; see vec.ts.
 */
import { T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { clz, cls, ESIZE, half, int, maskEs, ones, polyMul, popcount, rbit, readV, sat, shiftReg, sx, ux, writeNarrow, writeV } from './vec'

const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')
const LETTER = 'bhsd'

/** Allowed element sizes (as letters) for the vector form; 64-bit elements also need Q = 1. */
export const sizes = (allowed: string) => (f: Fields) => allowed.includes(LETTER[f.size!]!) && !(f.size === 3 && f.Q === 0)
const scalarSizes = (allowed: string) => (f: Fields) => allowed.includes(LETTER[f.size!]!)

/** Saturation reported by a lane function. */
export interface Sat {
  qc: boolean
}
export type Lane = (a: bigint, b: bigint, d: bigint, es: number, st: Sat) => bigint

const satTo = (v: bigint, es: number, unsigned: boolean, st: Sat) => {
  const [r, s] = sat(v, es, unsigned)
  if (s) st.qc = true
  return r
}
const cmp = (t: boolean, es: number) => (t ? ones(es) : 0n)

const INSTRS_: InstrSpec[] = []
const ALIASES_: AliasSpec[] = []

/* ------------------------------------------------------------------ three same */

interface SameOp {
  U: number
  opc: number
  m: string
  /** Element sizes of the vector form ('' for none). */
  v: string
  /** Element sizes of the scalar form ('' for none). */
  s: string
  desc: Text
  lane: Lane
  /** Reads the destination too (accumulates). */
  acc?: boolean
  /** Pairwise: lanes of the concatenation Vm:Vn, two at a time. */
  pair?: boolean
}

const sat3 = (unsigned: boolean, sub: boolean): Lane => (a, b, _d, es, st) => satTo(sub ? int(a, es, unsigned) - int(b, es, unsigned) : int(a, es, unsigned) + int(b, es, unsigned), es, unsigned, st)
const halving = (unsigned: boolean, sub: boolean, round: boolean): Lane => (a, b, _d, es) => ux((sub ? int(a, es, unsigned) - int(b, es, unsigned) : int(a, es, unsigned) + int(b, es, unsigned) + (round ? 1n : 0n)) >> 1n, es)
const shl = (unsigned: boolean, round: boolean, saturating: boolean): Lane => (a, b, _d, es, st) => {
  const [r, s] = shiftReg(a, b, es, unsigned, round, saturating)
  if (s) st.qc = true
  return r
}
const absDiff = (unsigned: boolean) => (a: bigint, b: bigint, es: number) => {
  const d = int(a, es, unsigned) - int(b, es, unsigned)
  return ux(d < 0n ? -d : d, es)
}
const minmax = (unsigned: boolean, max: boolean): Lane => (a, b, _d, es) => {
  const x = int(a, es, unsigned)
  const y = int(b, es, unsigned)
  return ux(max ? (x > y ? x : y) : x < y ? x : y, es)
}
const dmulh = (round: boolean): Lane => (a, b, _d, es, st) => satTo((2n * sx(a, es) * sx(b, es) + (round ? 1n << BigInt(ESIZE[es]! - 1) : 0n)) >> BigInt(ESIZE[es]!), es, false, st)

const SAME: SameOp[] = [
  { U: 0, opc: 0b00000, m: 'shadd', v: 'bhs', s: '', desc: T('有符号减半加：(a + b) >> 1', 'Signed halving add: (a + b) >> 1'), lane: halving(false, false, false) },
  { U: 0, opc: 0b00001, m: 'sqadd', v: 'bhsd', s: 'bhsd', desc: T('有符号饱和加', 'Signed saturating add'), lane: sat3(false, false) },
  { U: 0, opc: 0b00010, m: 'srhadd', v: 'bhs', s: '', desc: T('有符号舍入减半加：(a + b + 1) >> 1', 'Signed rounding halving add: (a + b + 1) >> 1'), lane: halving(false, false, true) },
  { U: 0, opc: 0b00100, m: 'shsub', v: 'bhs', s: '', desc: T('有符号减半减：(a − b) >> 1', 'Signed halving subtract: (a − b) >> 1'), lane: halving(false, true, false) },
  { U: 0, opc: 0b00101, m: 'sqsub', v: 'bhsd', s: 'bhsd', desc: T('有符号饱和减', 'Signed saturating subtract'), lane: sat3(false, true) },
  { U: 0, opc: 0b00110, m: 'cmgt', v: 'bhsd', s: 'd', desc: T('有符号比较大于：成立时元素全 1，否则全 0', 'Compare signed greater than: all ones where true, zero elsewhere'), lane: (a, b, _d, es) => cmp(sx(a, es) > sx(b, es), es) },
  { U: 0, opc: 0b00111, m: 'cmge', v: 'bhsd', s: 'd', desc: T('有符号比较大于等于', 'Compare signed greater than or equal'), lane: (a, b, _d, es) => cmp(sx(a, es) >= sx(b, es), es) },
  { U: 0, opc: 0b01000, m: 'sshl', v: 'bhsd', s: 'd', desc: T('有符号按寄存器移位：Vm 每个元素的低 8 位是有符号移位量，负数右移', 'Signed shift by register: the low byte of each Vm element is a signed shift, negative shifts right'), lane: shl(false, false, false) },
  { U: 0, opc: 0b01001, m: 'sqshl', v: 'bhsd', s: 'bhsd', desc: T('有符号饱和按寄存器移位', 'Signed saturating shift by register'), lane: shl(false, false, true) },
  { U: 0, opc: 0b01010, m: 'srshl', v: 'bhsd', s: 'd', desc: T('有符号舍入按寄存器移位', 'Signed rounding shift by register'), lane: shl(false, true, false) },
  { U: 0, opc: 0b01011, m: 'sqrshl', v: 'bhsd', s: 'bhsd', desc: T('有符号饱和舍入按寄存器移位', 'Signed saturating rounding shift by register'), lane: shl(false, true, true) },
  { U: 0, opc: 0b01100, m: 'smax', v: 'bhs', s: '', desc: T('有符号最大值', 'Signed maximum'), lane: minmax(false, true) },
  { U: 0, opc: 0b01101, m: 'smin', v: 'bhs', s: '', desc: T('有符号最小值', 'Signed minimum'), lane: minmax(false, false) },
  { U: 0, opc: 0b01110, m: 'sabd', v: 'bhs', s: '', desc: T('有符号差的绝对值', 'Signed absolute difference'), lane: (a, b, _d, es) => absDiff(false)(a, b, es) },
  { U: 0, opc: 0b01111, m: 'saba', v: 'bhs', s: '', desc: T('有符号差的绝对值再累加到 Vd', 'Signed absolute difference, accumulated into Vd'), lane: (a, b, d, es) => ux(d + absDiff(false)(a, b, es), es), acc: true },
  { U: 0, opc: 0b10000, m: 'add', v: 'bhsd', s: 'd', desc: T('向量加（每个元素各加各的）', 'Add vectors (element by element)'), lane: (a, b, _d, es) => ux(a + b, es) },
  { U: 0, opc: 0b10001, m: 'cmtst', v: 'bhsd', s: 'd', desc: T('按位测试：a & b 不为 0 时元素全 1', 'Test bits: all ones where a & b is not zero'), lane: (a, b, _d, es) => cmp((a & b) !== 0n, es) },
  { U: 0, opc: 0b10010, m: 'mla', v: 'bhs', s: '', desc: T('乘加：Vd += Vn × Vm', 'Multiply-add: Vd += Vn × Vm'), lane: (a, b, d, es) => ux(d + a * b, es), acc: true },
  { U: 0, opc: 0b10011, m: 'mul', v: 'bhs', s: '', desc: T('向量乘（只保留低半部分）', 'Multiply vectors (low half of each product)'), lane: (a, b, _d, es) => ux(a * b, es) },
  { U: 0, opc: 0b10100, m: 'smaxp', v: 'bhs', s: '', desc: T('相邻元素两两取有符号最大值', 'Signed maximum of adjacent pairs'), lane: minmax(false, true), pair: true },
  { U: 0, opc: 0b10101, m: 'sminp', v: 'bhs', s: '', desc: T('相邻元素两两取有符号最小值', 'Signed minimum of adjacent pairs'), lane: minmax(false, false), pair: true },
  { U: 0, opc: 0b10110, m: 'sqdmulh', v: 'hs', s: 'hs', desc: T('有符号饱和加倍乘，取高半部分：(2 × a × b) >> 元素位数', 'Signed saturating doubling multiply, high half: (2 × a × b) >> element bits'), lane: dmulh(false) },
  { U: 0, opc: 0b10111, m: 'addp', v: 'bhsd', s: '', desc: T('相邻元素两两相加', 'Add adjacent pairs'), lane: (a, b, _d, es) => ux(a + b, es), pair: true },
  { U: 1, opc: 0b00000, m: 'uhadd', v: 'bhs', s: '', desc: T('无符号减半加', 'Unsigned halving add'), lane: halving(true, false, false) },
  { U: 1, opc: 0b00001, m: 'uqadd', v: 'bhsd', s: 'bhsd', desc: T('无符号饱和加', 'Unsigned saturating add'), lane: sat3(true, false) },
  { U: 1, opc: 0b00010, m: 'urhadd', v: 'bhs', s: '', desc: T('无符号舍入减半加', 'Unsigned rounding halving add'), lane: halving(true, false, true) },
  { U: 1, opc: 0b00100, m: 'uhsub', v: 'bhs', s: '', desc: T('无符号减半减', 'Unsigned halving subtract'), lane: halving(true, true, false) },
  { U: 1, opc: 0b00101, m: 'uqsub', v: 'bhsd', s: 'bhsd', desc: T('无符号饱和减', 'Unsigned saturating subtract'), lane: sat3(true, true) },
  { U: 1, opc: 0b00110, m: 'cmhi', v: 'bhsd', s: 'd', desc: T('无符号比较大于', 'Compare unsigned higher'), lane: (a, b, _d, es) => cmp(a > b, es) },
  { U: 1, opc: 0b00111, m: 'cmhs', v: 'bhsd', s: 'd', desc: T('无符号比较大于等于', 'Compare unsigned higher or same'), lane: (a, b, _d, es) => cmp(a >= b, es) },
  { U: 1, opc: 0b01000, m: 'ushl', v: 'bhsd', s: 'd', desc: T('无符号按寄存器移位（负数右移）', 'Unsigned shift by register (negative shifts right)'), lane: shl(true, false, false) },
  { U: 1, opc: 0b01001, m: 'uqshl', v: 'bhsd', s: 'bhsd', desc: T('无符号饱和按寄存器移位', 'Unsigned saturating shift by register'), lane: shl(true, false, true) },
  { U: 1, opc: 0b01010, m: 'urshl', v: 'bhsd', s: 'd', desc: T('无符号舍入按寄存器移位', 'Unsigned rounding shift by register'), lane: shl(true, true, false) },
  { U: 1, opc: 0b01011, m: 'uqrshl', v: 'bhsd', s: 'bhsd', desc: T('无符号饱和舍入按寄存器移位', 'Unsigned saturating rounding shift by register'), lane: shl(true, true, true) },
  { U: 1, opc: 0b01100, m: 'umax', v: 'bhs', s: '', desc: T('无符号最大值', 'Unsigned maximum'), lane: minmax(true, true) },
  { U: 1, opc: 0b01101, m: 'umin', v: 'bhs', s: '', desc: T('无符号最小值', 'Unsigned minimum'), lane: minmax(true, false) },
  { U: 1, opc: 0b01110, m: 'uabd', v: 'bhs', s: '', desc: T('无符号差的绝对值', 'Unsigned absolute difference'), lane: (a, b, _d, es) => absDiff(true)(a, b, es) },
  { U: 1, opc: 0b01111, m: 'uaba', v: 'bhs', s: '', desc: T('无符号差的绝对值再累加到 Vd', 'Unsigned absolute difference, accumulated into Vd'), lane: (a, b, d, es) => ux(d + absDiff(true)(a, b, es), es), acc: true },
  { U: 1, opc: 0b10000, m: 'sub', v: 'bhsd', s: 'd', desc: T('向量减', 'Subtract vectors'), lane: (a, b, _d, es) => ux(a - b, es) },
  { U: 1, opc: 0b10001, m: 'cmeq', v: 'bhsd', s: 'd', desc: T('比较相等：相等时元素全 1', 'Compare equal: all ones where equal'), lane: (a, b, _d, es) => cmp(a === b, es) },
  { U: 1, opc: 0b10010, m: 'mls', v: 'bhs', s: '', desc: T('乘减：Vd −= Vn × Vm', 'Multiply-subtract: Vd −= Vn × Vm'), lane: (a, b, d, es) => ux(d - a * b, es), acc: true },
  { U: 1, opc: 0b10011, m: 'pmul', v: 'b', s: '', desc: T('多项式乘（GF(2) 上无进位的乘法），取低 8 位', 'Polynomial multiply (carry-less, over GF(2)), low 8 bits'), lane: (a, b) => polyMul(a, b, 8) & 0xffn },
  { U: 1, opc: 0b10100, m: 'umaxp', v: 'bhs', s: '', desc: T('相邻元素两两取无符号最大值', 'Unsigned maximum of adjacent pairs'), lane: minmax(true, true), pair: true },
  { U: 1, opc: 0b10101, m: 'uminp', v: 'bhs', s: '', desc: T('相邻元素两两取无符号最小值', 'Unsigned minimum of adjacent pairs'), lane: minmax(true, false), pair: true },
  { U: 1, opc: 0b10110, m: 'sqrdmulh', v: 'hs', s: 'hs', desc: T('有符号饱和舍入加倍乘，取高半部分', 'Signed saturating rounding doubling multiply, high half'), lane: dmulh(true) },
]

/** Run a lane function over vectors: Vd = op(Vn, Vm[, Vd]). */
export function vectorOp(c: Cpu, f: Fields, es: number, lane: Lane, acc = false, pair = false): void {
  const bytes = f.Q ? 16 : 8
  const A = readV(c, f.Rn!, es, bytes)
  const B = readV(c, f.Rm!, es, bytes)
  const D = acc ? readV(c, f.Rd!, es, bytes) : null
  const st: Sat = { qc: false }
  let R: bigint[]
  if (pair) {
    const cat = [...A, ...B]
    R = A.map((_, i) => lane(cat[2 * i]!, cat[2 * i + 1]!, 0n, es, st))
  } else R = A.map((a, i) => lane(a, B[i]!, D ? D[i]! : 0n, es, st))
  if (st.qc) c.setQC()
  writeV(c, f.Rd!, R, es)
}

/** The same on scalars of element size es. */
export function scalarIntOp(c: Cpu, f: Fields, es: number, lane: Lane, acc = false): void {
  const bytes = 1 << es
  const st: Sat = { qc: false }
  const r = lane(c.vget(f.Rn!, bytes), c.vget(f.Rm!, bytes), acc ? c.vget(f.Rd!, bytes) : 0n, es, st)
  if (st.qc) c.setQC()
  c.vset(f.Rd!, bytes, r)
}

for (const op of SAME) {
  if (op.v)
    INSTRS_.push({
      id: `${op.m}-v`,
      mnemonic: op.m,
      group: 'simd',
      bits: `0 Q ${op.U} 01110 size:2 1 Rm:5 ${bin(op.opc, 5)} 1 Rn:5 Rd:5`,
      syntax: '<Vd:size:Q>, <Vn:size:Q>, <Vm:size:Q>',
      valid: sizes(op.v),
      desc: op.desc,
      example: op.v.includes('s') ? undefined : `${op.m} v0.${op.v === 'b' ? '16b' : '8h'}, v1.${op.v === 'b' ? '16b' : '8h'}, v2.${op.v === 'b' ? '16b' : '8h'}`,
      exec: (c, f) => vectorOp(c, f, f.size!, op.lane, op.acc, op.pair),
    })
  if (op.s)
    INSTRS_.push({
      id: `${op.m}-sc`,
      mnemonic: op.m,
      group: 'simd',
      bits: `01 ${op.U} 11110 size:2 1 Rm:5 ${bin(op.opc, 5)} 1 Rn:5 Rd:5`,
      syntax: '<Ed:size>, <En:size>, <Em:size>',
      valid: scalarSizes(op.s),
      desc: op.desc,
      example: op.s === 'd' ? `${op.m} d0, d1, d2` : undefined,
      exec: (c, f) => scalarIntOp(c, f, f.size!, op.lane, op.acc),
    })
}

/* Logical operations: the size field picks the operation; whole 64-bit chunks. */
const LOGIC: [number, number, string, Text, (n: bigint, m: bigint, d: bigint) => bigint, boolean][] = [
  [0, 0, 'and', T('按位与', 'Bitwise AND'), (n, m) => n & m, false],
  [0, 1, 'bic', T('按位清除：Vn & ~Vm', 'Bitwise bit clear: Vn & ~Vm'), (n, m) => n & ~m, false],
  [0, 2, 'orr', T('按位或', 'Bitwise OR'), (n, m) => n | m, false],
  [0, 3, 'orn', T('按位或非：Vn | ~Vm', 'Bitwise OR NOT: Vn | ~Vm'), (n, m) => n | ~m, false],
  [1, 0, 'eor', T('按位异或', 'Bitwise exclusive OR'), (n, m) => n ^ m, false],
  [1, 1, 'bsl', T('按位选择：Vd 为 1 的位取 Vn，为 0 的位取 Vm', 'Bitwise select: bits from Vn where Vd is 1, from Vm where it is 0'), (n, m, d) => (n & d) | (m & ~d), true],
  [1, 2, 'bit', T('为真时插入：Vm 为 1 的位取 Vn，其余保持 Vd', 'Bitwise insert if true: bits from Vn where Vm is 1, Vd elsewhere'), (n, m, d) => (n & m) | (d & ~m), true],
  [1, 3, 'bif', T('为假时插入：Vm 为 0 的位取 Vn，其余保持 Vd', 'Bitwise insert if false: bits from Vn where Vm is 0, Vd elsewhere'), (n, m, d) => (n & ~m) | (d & m), true],
]
for (const [U, size, m, desc, fn, acc] of LOGIC)
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    bits: `0 Q ${U} 01110 ${bin(size, 2)} 1 Rm:5 00011 1 Rn:5 Rd:5`,
    syntax: '<Vd:b:Q>, <Vn:b:Q>, <Vm:b:Q>',
    desc,
    exec: (c, f) => vectorOp(c, f, 3, (a, b, d) => fn(a, b, d) & maskEs(3), acc),
  })
ALIASES_.push({
  id: 'mov-v-orr',
  of: 'orr-v',
  mnemonic: 'mov',
  syntax: '<Vd:b:Q>, <Vn:b:Q>',
  encode: (f) => {
    f.Rm = f.Rn!
  },
  prefer: (f) => f.Rm === f.Rn,
  desc: T('复制向量寄存器', 'Copy a vector register'),
  group: 'simd',
})

/* ------------------------------------------------------------------ three different */

type DiffKind = 'long' | 'wide' | 'narrow'
interface DiffOp {
  U: number
  opc: number
  m: string
  kind: DiffKind
  /** Element sizes of the narrow side. */
  v: string
  desc: Text
  lane: Lane
  acc?: boolean
}
const longAdd = (unsigned: boolean, sub: boolean): Lane => (a, b, _d, es) => ux(sub ? int(a, es, unsigned) - int(b, es, unsigned) : int(a, es, unsigned) + int(b, es, unsigned), es + 1)
const longMul = (unsigned: boolean, sign: number): Lane => (a, b, d, es) => ux(d + BigInt(sign) * int(a, es, unsigned) * int(b, es, unsigned), es + 1)
const dmull = (sign: number, acc: boolean): Lane => (a, b, d, es, st) => {
  const p = satTo(2n * sx(a, es) * sx(b, es), es + 1, false, st)
  return acc ? satTo(sx(d, es + 1) + BigInt(sign) * sx(p, es + 1), es + 1, false, st) : p
}
const DIFF: DiffOp[] = [
  { U: 0, opc: 0b0000, m: 'saddl', kind: 'long', v: 'bhs', desc: T('有符号加，结果加宽一倍', 'Signed add long (results twice as wide)'), lane: longAdd(false, false) },
  { U: 0, opc: 0b0001, m: 'saddw', kind: 'wide', v: 'bhs', desc: T('宽元素加上有符号扩展的窄元素', 'Signed add wide: wide elements plus sign-extended narrow ones'), lane: longAdd(false, false) },
  { U: 0, opc: 0b0010, m: 'ssubl', kind: 'long', v: 'bhs', desc: T('有符号减，结果加宽一倍', 'Signed subtract long'), lane: longAdd(false, true) },
  { U: 0, opc: 0b0011, m: 'ssubw', kind: 'wide', v: 'bhs', desc: T('宽元素减去有符号扩展的窄元素', 'Signed subtract wide'), lane: longAdd(false, true) },
  { U: 0, opc: 0b0100, m: 'addhn', kind: 'narrow', v: 'bhs', desc: T('加后取高半部分（结果窄一半）', 'Add, returning the high half (narrowing)'), lane: (a, b, _d, es) => ux((a + b) >> BigInt(ESIZE[es]!), es) },
  { U: 0, opc: 0b0101, m: 'sabal', kind: 'long', v: 'bhs', desc: T('有符号差的绝对值，加宽后累加', 'Signed absolute difference, widened and accumulated'), lane: (a, b, d, es) => ux(d + ux(sx(a, es) - sx(b, es) < 0n ? sx(b, es) - sx(a, es) : sx(a, es) - sx(b, es), es + 1), es + 1), acc: true },
  { U: 0, opc: 0b0110, m: 'subhn', kind: 'narrow', v: 'bhs', desc: T('减后取高半部分', 'Subtract, returning the high half (narrowing)'), lane: (a, b, _d, es) => ux((a - b) >> BigInt(ESIZE[es]!), es) },
  { U: 0, opc: 0b0111, m: 'sabdl', kind: 'long', v: 'bhs', desc: T('有符号差的绝对值，结果加宽', 'Signed absolute difference long'), lane: (a, b, _d, es) => ux(sx(a, es) - sx(b, es) < 0n ? sx(b, es) - sx(a, es) : sx(a, es) - sx(b, es), es + 1) },
  { U: 0, opc: 0b1000, m: 'smlal', kind: 'long', v: 'bhs', desc: T('有符号加宽乘加', 'Signed multiply-add long'), lane: longMul(false, 1), acc: true },
  { U: 0, opc: 0b1001, m: 'sqdmlal', kind: 'long', v: 'hs', desc: T('有符号饱和加倍乘加（加宽）', 'Signed saturating doubling multiply-add long'), lane: dmull(1, true), acc: true },
  { U: 0, opc: 0b1010, m: 'smlsl', kind: 'long', v: 'bhs', desc: T('有符号加宽乘减', 'Signed multiply-subtract long'), lane: longMul(false, -1), acc: true },
  { U: 0, opc: 0b1011, m: 'sqdmlsl', kind: 'long', v: 'hs', desc: T('有符号饱和加倍乘减（加宽）', 'Signed saturating doubling multiply-subtract long'), lane: dmull(-1, true), acc: true },
  { U: 0, opc: 0b1100, m: 'smull', kind: 'long', v: 'bhs', desc: T('有符号乘，结果加宽一倍（完整乘积）', 'Signed multiply long (the full product)'), lane: longMul(false, 1) },
  { U: 0, opc: 0b1101, m: 'sqdmull', kind: 'long', v: 'hs', desc: T('有符号饱和加倍乘（加宽）', 'Signed saturating doubling multiply long'), lane: dmull(1, false) },
  { U: 0, opc: 0b1110, m: 'pmull', kind: 'long', v: 'bd', desc: T('多项式乘（无进位），结果加宽；64 位时得 128 位（用于 GCM、CRC）', 'Polynomial (carry-less) multiply long; 64-bit elements give 128 bits (for GCM and CRC)'), lane: (a, b, _d, es) => polyMul(a, b, ESIZE[es]!) },
  { U: 1, opc: 0b0000, m: 'uaddl', kind: 'long', v: 'bhs', desc: T('无符号加，结果加宽一倍', 'Unsigned add long'), lane: longAdd(true, false) },
  { U: 1, opc: 0b0001, m: 'uaddw', kind: 'wide', v: 'bhs', desc: T('宽元素加上零扩展的窄元素', 'Unsigned add wide'), lane: longAdd(true, false) },
  { U: 1, opc: 0b0010, m: 'usubl', kind: 'long', v: 'bhs', desc: T('无符号减，结果加宽一倍', 'Unsigned subtract long'), lane: longAdd(true, true) },
  { U: 1, opc: 0b0011, m: 'usubw', kind: 'wide', v: 'bhs', desc: T('宽元素减去零扩展的窄元素', 'Unsigned subtract wide'), lane: longAdd(true, true) },
  { U: 1, opc: 0b0100, m: 'raddhn', kind: 'narrow', v: 'bhs', desc: T('加后舍入取高半部分', 'Rounding add, returning the high half'), lane: (a, b, _d, es) => ux((a + b + (1n << BigInt(ESIZE[es]! - 1))) >> BigInt(ESIZE[es]!), es) },
  { U: 1, opc: 0b0101, m: 'uabal', kind: 'long', v: 'bhs', desc: T('无符号差的绝对值，加宽后累加', 'Unsigned absolute difference, widened and accumulated'), lane: (a, b, d, es) => ux(d + (a > b ? a - b : b - a), es + 1), acc: true },
  { U: 1, opc: 0b0110, m: 'rsubhn', kind: 'narrow', v: 'bhs', desc: T('减后舍入取高半部分', 'Rounding subtract, returning the high half'), lane: (a, b, _d, es) => ux((a - b + (1n << BigInt(ESIZE[es]! - 1))) >> BigInt(ESIZE[es]!), es) },
  { U: 1, opc: 0b0111, m: 'uabdl', kind: 'long', v: 'bhs', desc: T('无符号差的绝对值，结果加宽', 'Unsigned absolute difference long'), lane: (a, b) => (a > b ? a - b : b - a) },
  { U: 1, opc: 0b1000, m: 'umlal', kind: 'long', v: 'bhs', desc: T('无符号加宽乘加', 'Unsigned multiply-add long'), lane: longMul(true, 1), acc: true },
  { U: 1, opc: 0b1010, m: 'umlsl', kind: 'long', v: 'bhs', desc: T('无符号加宽乘减', 'Unsigned multiply-subtract long'), lane: longMul(true, -1), acc: true },
  { U: 1, opc: 0b1100, m: 'umull', kind: 'long', v: 'bhs', desc: T('无符号乘，结果加宽一倍（完整乘积）', 'Unsigned multiply long (the full product)'), lane: longMul(true, 1) },
]

const DIFF_SYNTAX: Record<DiffKind, string> = {
  long: '<Vd:size+1:1>, <Vn:size:Q>, <Vm:size:Q>',
  wide: '<Vd:size+1:1>, <Vn:size+1:1>, <Vm:size:Q>',
  narrow: '<Vd:size:Q>, <Vn:size+1:1>, <Vm:size+1:1>',
}

for (const op of DIFF)
  for (const Q of [0, 1]) {
    const m = Q ? `${op.m}2` : op.m
    const upper = Q === 1
    INSTRS_.push({
      id: `${m}-v`,
      mnemonic: m,
      group: 'simd',
      feature: op.m === 'pmull' ? 'pmull' : undefined,
      bits: `0 ${Q} ${op.U} 01110 size:2 1 Rm:5 ${bin(op.opc, 4)} 00 Rn:5 Rd:5`,
      syntax: DIFF_SYNTAX[op.kind].replace(/:Q>/g, `:${Q}>`),
      valid: (f) => op.v.includes(LETTER[f.size!]!),
      desc: upper ? T(`${op.desc.zh}（用源寄存器的高半部分${op.kind === 'narrow' ? '，结果写进 Vd 的高半部分' : ''}）`, `${op.desc.en} (upper halves${op.kind === 'narrow' ? ', into the upper half of Vd' : ''})`) : op.desc,
      example: op.v === 'hs' ? `${m} v0.4s, v1.${Q ? '8h' : '4h'}, v2.${Q ? '8h' : '4h'}` : op.m === 'pmull' ? `${m} v0.8h, v1.${Q ? '16b' : '8b'}, v2.${Q ? '16b' : '8b'}` : undefined,
      exec: (c, f) => {
        const es = f.size!
        const st: Sat = { qc: false }
        if (op.kind === 'narrow') {
          const A = readV(c, f.Rn!, es + 1, 16)
          const B = readV(c, f.Rm!, es + 1, 16)
          writeNarrow(c, f.Rd!, A.map((a, i) => op.lane(a, B[i]!, 0n, es, st)), es, upper)
          return
        }
        const A = op.kind === 'wide' ? readV(c, f.Rn!, es + 1, 16).map((v) => v) : half(c, f.Rn!, es, upper)
        const B = half(c, f.Rm!, es, upper)
        const D = op.acc ? readV(c, f.Rd!, es + 1, 16) : null
        const R = B.map((b, i) => {
          if (op.kind === 'wide') {
            const unsigned = op.U === 1
            const w = int(A[i]!, es + 1, unsigned)
            const n = int(b, es, unsigned)
            return ux(op.m.includes('sub') ? w - n : w + n, es + 1)
          }
          return op.lane(A[i]!, b, D ? D[i]! : 0n, es, st)
        })
        if (st.qc) c.setQC()
        writeV(c, f.Rd!, R, es === 3 ? 4 : es + 1)
      },
    })
  }

/* Scalar SQDMLAL, SQDMLSL, SQDMULL. */
for (const [opc, m, lane, acc] of [
  [0b1001, 'sqdmlal', dmull(1, true), true],
  [0b1011, 'sqdmlsl', dmull(-1, true), true],
  [0b1101, 'sqdmull', dmull(1, false), false],
] as const)
  INSTRS_.push({
    id: `${m}-sc`,
    mnemonic: m,
    group: 'simd',
    bits: `01 0 11110 size:2 1 Rm:5 ${bin(opc, 4)} 00 Rn:5 Rd:5`,
    syntax: '<Ed:size+1>, <En:size>, <Em:size>',
    valid: (f) => f.size === 1 || f.size === 2,
    desc: DIFF.find((d) => d.m === m)!.desc,
    example: `${m} s0, h1, h2`,
    exec: (c, f) => {
      const es = f.size!
      const st: Sat = { qc: false }
      const r = lane(c.vget(f.Rn!, 1 << es), c.vget(f.Rm!, 1 << es), acc ? c.vget(f.Rd!, 2 << es) : 0n, es, st)
      if (st.qc) c.setQC()
      c.vset(f.Rd!, 2 << es, r)
    },
  })

/* ------------------------------------------------------------------ two-register miscellaneous */

type Unary = (a: bigint, es: number, st: Sat) => bigint
interface MiscOp {
  U: number
  opc: number
  m: string
  v: string
  s: string
  desc: Text
  fn: Unary
  /** Compare with zero: written with #0. */
  zero?: boolean
}
const satUnary = (fn: (v: bigint) => bigint, unsigned: boolean): Unary => (a, es, st) => satTo(fn(sx(a, es)), es, unsigned, st)
const MISC: MiscOp[] = [
  { U: 0, opc: 0b00100, m: 'cls', v: 'bhs', s: '', desc: T('数前导符号位（不含最高位）', 'Count leading sign bits (not counting the top bit)'), fn: (a, es) => BigInt(cls(a, es)) },
  { U: 0, opc: 0b00111, m: 'sqabs', v: 'bhsd', s: 'bhsd', desc: T('有符号饱和绝对值', 'Signed saturating absolute value'), fn: satUnary((v) => (v < 0n ? -v : v), false) },
  { U: 0, opc: 0b01000, m: 'cmgt', v: 'bhsd', s: 'd', desc: T('有符号比较大于 0', 'Compare signed greater than zero'), fn: (a, es) => cmp(sx(a, es) > 0n, es), zero: true },
  { U: 0, opc: 0b01001, m: 'cmeq', v: 'bhsd', s: 'd', desc: T('比较等于 0', 'Compare equal to zero'), fn: (a, es) => cmp(a === 0n, es), zero: true },
  { U: 0, opc: 0b01010, m: 'cmlt', v: 'bhsd', s: 'd', desc: T('有符号比较小于 0', 'Compare signed less than zero'), fn: (a, es) => cmp(sx(a, es) < 0n, es), zero: true },
  { U: 0, opc: 0b01011, m: 'abs', v: 'bhsd', s: 'd', desc: T('绝对值（不饱和）', 'Absolute value (wrapping)'), fn: (a, es) => ux(sx(a, es) < 0n ? -sx(a, es) : a, es) },
  { U: 1, opc: 0b00100, m: 'clz', v: 'bhs', s: '', desc: T('数前导零', 'Count leading zeros'), fn: (a, es) => BigInt(clz(a, es)) },
  { U: 1, opc: 0b00111, m: 'sqneg', v: 'bhsd', s: 'bhsd', desc: T('有符号饱和取负', 'Signed saturating negate'), fn: satUnary((v) => -v, false) },
  { U: 1, opc: 0b01000, m: 'cmge', v: 'bhsd', s: 'd', desc: T('有符号比较大于等于 0', 'Compare signed greater than or equal to zero'), fn: (a, es) => cmp(sx(a, es) >= 0n, es), zero: true },
  { U: 1, opc: 0b01001, m: 'cmle', v: 'bhsd', s: 'd', desc: T('有符号比较小于等于 0', 'Compare signed less than or equal to zero'), fn: (a, es) => cmp(sx(a, es) <= 0n, es), zero: true },
  { U: 1, opc: 0b01011, m: 'neg', v: 'bhsd', s: 'd', desc: T('取负（不饱和）', 'Negate (wrapping)'), fn: (a, es) => ux(-a, es) },
]

export function unaryVector(c: Cpu, f: Fields, es: number, fn: Unary): void {
  const st: Sat = { qc: false }
  const R = readV(c, f.Rn!, es, f.Q ? 16 : 8).map((a) => fn(a, es, st))
  if (st.qc) c.setQC()
  writeV(c, f.Rd!, R, es)
}

for (const op of MISC) {
  const tail = op.zero ? ', #0' : ''
  INSTRS_.push({
    id: `${op.m}${op.zero ? 'z' : ''}-v`,
    mnemonic: op.m,
    group: 'simd',
    bits: `0 Q ${op.U} 01110 size:2 10000 ${bin(op.opc, 5)} 10 Rn:5 Rd:5`,
    syntax: `<Vd:size:Q>, <Vn:size:Q>${tail}`,
    valid: sizes(op.v),
    desc: op.desc,
    exec: (c, f) => unaryVector(c, f, f.size!, op.fn),
  })
  if (op.s)
    INSTRS_.push({
      id: `${op.m}${op.zero ? 'z' : ''}-sc`,
      mnemonic: op.m,
      group: 'simd',
      bits: `01 ${op.U} 11110 size:2 10000 ${bin(op.opc, 5)} 10 Rn:5 Rd:5`,
      syntax: `<Ed:size>, <En:size>${tail}`,
      valid: scalarSizes(op.s),
      desc: op.desc,
      example: op.s === 'd' ? `${op.m} d0, d1${tail}` : undefined,
      exec: (c, f) => {
        const st: Sat = { qc: false }
        const r = op.fn(c.vget(f.Rn!, 1 << f.size!), f.size!, st)
        if (st.qc) c.setQC()
        c.vset(f.Rd!, 1 << f.size!, r)
      },
    })
}

/* SUQADD, USQADD: accumulate the other signedness, saturating. */
for (const [U, m, desc] of [
  [0, 'suqadd', T('有符号饱和地加上无符号值：Vd = sat(Vd + Vn)', 'Signed saturating accumulate of unsigned value: Vd = sat(Vd + Vn)')],
  [1, 'usqadd', T('无符号饱和地加上有符号值：Vd = sat(Vd + Vn)', 'Unsigned saturating accumulate of signed value: Vd = sat(Vd + Vn)')],
] as const) {
  const lane = (n: bigint, d: bigint, es: number, st: Sat) => (U ? satTo(d + sx(n, es), es, true, st) : satTo(sx(d, es) + n, es, false, st))
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    bits: `0 Q ${U} 01110 size:2 10000 00011 10 Rn:5 Rd:5`,
    syntax: '<Vd:size:Q>, <Vn:size:Q>',
    valid: sizes('bhsd'),
    desc,
    exec: (c, f) => {
      const bytes = f.Q ? 16 : 8
      const N = readV(c, f.Rn!, f.size!, bytes)
      const D = readV(c, f.Rd!, f.size!, bytes)
      const st: Sat = { qc: false }
      const R = N.map((n, i) => lane(n, D[i]!, f.size!, st))
      if (st.qc) c.setQC()
      writeV(c, f.Rd!, R, f.size!)
    },
  })
  INSTRS_.push({
    id: `${m}-sc`,
    mnemonic: m,
    group: 'simd',
    bits: `01 ${U} 11110 size:2 10000 00011 10 Rn:5 Rd:5`,
    syntax: '<Ed:size>, <En:size>',
    desc,
    exec: (c, f) => {
      const st: Sat = { qc: false }
      const bytes = 1 << f.size!
      const r = lane(c.vget(f.Rn!, bytes), c.vget(f.Rd!, bytes), f.size!, st)
      if (st.qc) c.setQC()
      c.vset(f.Rd!, bytes, r)
    },
  })
}

/* Byte-order reversal inside containers: REV64 (b h s), REV32 (b h), REV16 (b). */
for (const [U, opc, m, container, v] of [
  [0, 0, 'rev64', 3, 'bhs'],
  [1, 0, 'rev32', 2, 'bh'],
  [0, 1, 'rev16', 1, 'b'],
] as const)
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    bits: `0 Q ${U} 01110 size:2 10000 ${bin(opc, 5)} 10 Rn:5 Rd:5`,
    syntax: '<Vd:size:Q>, <Vn:size:Q>',
    valid: (f) => v.includes(LETTER[f.size!]!),
    desc: T(`在每个 ${8 << container} 位的块里把元素倒序`, `Reverse the order of elements within each ${8 << container}-bit container`),
    example: `${m} v0.16b, v1.16b`,
    exec: (c, f) => {
      const es = f.size!
      const per = 1 << (container - es)
      const E = readV(c, f.Rn!, es, f.Q ? 16 : 8)
      writeV(
        c,
        f.Rd!,
        E.map((_, i) => E[i - (i % per) + (per - 1 - (i % per))]!),
        es,
      )
    },
  })

INSTRS_.push({
  id: 'cnt-v',
  mnemonic: 'cnt',
  group: 'simd',
  bits: '0 Q 0 01110 00 10000 00101 10 Rn:5 Rd:5',
  syntax: '<Vd:b:Q>, <Vn:b:Q>',
  desc: T('数每个字节里 1 的个数', 'Count the set bits of each byte'),
  exec: (c, f) => unaryVector(c, f, 0, (a) => BigInt(popcount(a))),
})
INSTRS_.push({
  id: 'not-v',
  mnemonic: 'not',
  group: 'simd',
  bits: '0 Q 1 01110 00 10000 00101 10 Rn:5 Rd:5',
  syntax: '<Vd:b:Q>, <Vn:b:Q>',
  desc: T('按位取反', 'Bitwise NOT'),
  exec: (c, f) => unaryVector(c, f, 0, (a) => ~a & 0xffn),
})
ALIASES_.push({ id: 'mvn-v', of: 'not-v', mnemonic: 'mvn', syntax: '<Vd:b:Q>, <Vn:b:Q>', desc: T('按位取反（not 的另一种写法）', 'Bitwise NOT (another name for not)'), group: 'simd' })
INSTRS_.push({
  id: 'rbit-v',
  mnemonic: 'rbit',
  group: 'simd',
  bits: '0 Q 1 01110 01 10000 00101 10 Rn:5 Rd:5',
  syntax: '<Vd:b:Q>, <Vn:b:Q>',
  desc: T('把每个字节的位顺序倒过来', 'Reverse the bit order of each byte'),
  exec: (c, f) => unaryVector(c, f, 0, (a) => rbit(a, 0)),
})

/* Pairwise long adds: SADDLP, UADDLP, SADALP, UADALP. */
for (const [U, opc, m, acc] of [
  [0, 0b00010, 'saddlp', false],
  [1, 0b00010, 'uaddlp', false],
  [0, 0b00110, 'sadalp', true],
  [1, 0b00110, 'uadalp', true],
] as const)
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    bits: `0 Q ${U} 01110 size:2 10000 ${bin(opc, 5)} 10 Rn:5 Rd:5`,
    syntax: '<Vd:size+1:Q>, <Vn:size:Q>',
    valid: (f) => f.size! < 3,
    desc: T(`${U ? '无' : '有'}符号相邻两元素相加，结果加宽${acc ? '后累加到 Vd' : ''}`, `${U ? 'Unsigned' : 'Signed'} add of adjacent pairs, widened${acc ? ' and accumulated into Vd' : ''}`),
    exec: (c, f) => {
      const es = f.size!
      const bytes = f.Q ? 16 : 8
      const E = readV(c, f.Rn!, es, bytes)
      const D = acc ? readV(c, f.Rd!, es + 1, bytes) : null
      const R = Array.from({ length: E.length / 2 }, (_, i) => ux((D ? D[i]! : 0n) + int(E[2 * i]!, es, U === 1) + int(E[2 * i + 1]!, es, U === 1), es + 1))
      writeV(c, f.Rd!, R, es + 1)
    },
  })

/* Narrowing moves: XTN, SQXTN, UQXTN, SQXTUN (vector "2" forms write the upper half), and SHLL. */
for (const [U, opc, m, desc, fn] of [
  [0, 0b10010, 'xtn', T('取每个元素的低半部分（变窄）', 'Extract the low half of each element (narrow)'), (a: bigint, es: number) => ux(a, es)],
  [0, 0b10100, 'sqxtn', T('有符号饱和变窄', 'Signed saturating extract narrow'), (a: bigint, es: number, st: Sat) => satTo(sx(a, es + 1), es, false, st)],
  [1, 0b10100, 'uqxtn', T('无符号饱和变窄', 'Unsigned saturating extract narrow'), (a: bigint, es: number, st: Sat) => satTo(a, es, true, st)],
  [1, 0b10010, 'sqxtun', T('有符号值饱和变窄成无符号', 'Signed saturating extract unsigned narrow'), (a: bigint, es: number, st: Sat) => satTo(sx(a, es + 1), es, true, st)],
] as [number, number, string, Text, (a: bigint, es: number, st: Sat) => bigint][]) {
  for (const Q of [0, 1]) {
    const mm = Q ? `${m}2` : m
    INSTRS_.push({
      id: `${mm}-v`,
      mnemonic: mm,
      group: 'simd',
      bits: `0 ${Q} ${U} 01110 size:2 10000 ${bin(opc, 5)} 10 Rn:5 Rd:5`,
      syntax: `<Vd:size:${Q}>, <Vn:size+1:1>`,
      valid: (f) => f.size! < 3,
      desc: Q ? T(`${desc.zh}，写进 Vd 的高半部分`, `${desc.en}, into the upper half of Vd`) : desc,
      exec: (c, f) => {
        const st: Sat = { qc: false }
        const R = readV(c, f.Rn!, f.size! + 1, 16).map((a) => fn(a, f.size!, st))
        if (st.qc) c.setQC()
        writeNarrow(c, f.Rd!, R, f.size!, Q === 1)
      },
    })
  }
  if (m !== 'xtn')
    INSTRS_.push({
      id: `${m}-sc`,
      mnemonic: m,
      group: 'simd',
      bits: `01 ${U} 11110 size:2 10000 ${bin(opc, 5)} 10 Rn:5 Rd:5`,
      syntax: '<Ed:size>, <En:size+1>',
      valid: (f) => f.size! < 3,
      desc,
      example: `${m} h0, s1`,
      exec: (c, f) => {
        const st: Sat = { qc: false }
        const r = fn(c.vget(f.Rn!, 2 << f.size!), f.size!, st)
        if (st.qc) c.setQC()
        c.vset(f.Rd!, 1 << f.size!, r)
      },
    })
}
for (const Q of [0, 1]) {
  const m = Q ? 'shll2' : 'shll'
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    bits: `0 ${Q} 1 01110 size:2 10000 10011 10 Rn:5 Rd:5`,
    syntax: `<Vd:size+1:1>, <Vn:size:${Q}>, #<shll>`,
    valid: (f) => f.size! < 3,
    desc: T(`每个元素加宽后左移元素位数（8、16 或 32）${Q ? '，取源的高半部分' : ''}`, `Widen each element and shift it left by the element size (8, 16 or 32)${Q ? ', from the upper half' : ''}`),
    exec: (c, f) => {
      const es = f.size!
      writeV(
        c,
        f.Rd!,
        half(c, f.Rn!, es, Q === 1).map((a) => a << BigInt(ESIZE[es]!)),
        es + 1,
      )
    },
  })
}

/* ------------------------------------------------------------------ across lanes */

for (const [U, opc, m, wide, desc, fn] of [
  [0, 0b00011, 'saddlv', true, T('所有元素有符号相加，结果加宽', 'Signed add of all elements, widened'), (v: bigint[], es: number) => v.reduce((a, b) => a + sx(b, es), 0n)],
  [1, 0b00011, 'uaddlv', true, T('所有元素无符号相加，结果加宽', 'Unsigned add of all elements, widened'), (v: bigint[]) => v.reduce((a, b) => a + b, 0n)],
  [0, 0b01010, 'smaxv', false, T('所有元素的有符号最大值', 'Signed maximum of all elements'), (v: bigint[], es: number) => v.reduce((a, b) => (sx(b, es) > sx(a, es) ? b : a))],
  [1, 0b01010, 'umaxv', false, T('所有元素的无符号最大值', 'Unsigned maximum of all elements'), (v: bigint[]) => v.reduce((a, b) => (b > a ? b : a))],
  [0, 0b11010, 'sminv', false, T('所有元素的有符号最小值', 'Signed minimum of all elements'), (v: bigint[], es: number) => v.reduce((a, b) => (sx(b, es) < sx(a, es) ? b : a))],
  [1, 0b11010, 'uminv', false, T('所有元素的无符号最小值', 'Unsigned minimum of all elements'), (v: bigint[]) => v.reduce((a, b) => (b < a ? b : a))],
  [0, 0b11011, 'addv', false, T('所有元素相加（结果和元素一样宽）', 'Add all elements (result as wide as an element)'), (v: bigint[]) => v.reduce((a, b) => a + b, 0n)],
] as [number, number, string, boolean, Text, (v: bigint[], es: number) => bigint][])
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    bits: `0 Q ${U} 01110 size:2 11000 ${bin(opc, 5)} 10 Rn:5 Rd:5`,
    syntax: wide ? '<Ed:size+1>, <Vn:size:Q>' : '<Ed:size>, <Vn:size:Q>',
    valid: (f) => f.size! < 2 || (f.size === 2 && f.Q === 1),
    desc,
    exec: (c, f) => {
      const es = f.size!
      const r = fn(readV(c, f.Rn!, es, f.Q ? 16 : 8), es)
      const out = wide ? es + 1 : es
      c.vset(f.Rd!, 1 << out, ux(r, out))
    },
  })

INSTRS_.push({
  id: 'addp-sc',
  mnemonic: 'addp',
  group: 'simd',
  bits: '01 0 11110 11 11000 11011 10 Rn:5 Rd:5',
  syntax: '<Dd>, <Vn:d:1>',
  desc: T('把两个 64 位元素相加', 'Add the two 64-bit elements'),
  exec: (c, f) => {
    const [a, b] = readV(c, f.Rn!, 3, 16)
    c.vset(f.Rd!, 8, ux(a! + b!, 3))
  },
})

export const INSTRS = INSTRS_
export const ALIASES = ALIASES_
