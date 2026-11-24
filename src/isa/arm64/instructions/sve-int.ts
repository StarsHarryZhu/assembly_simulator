/**
 * SVE integer instructions: predicated and unpredicated arithmetic, logical operations and shifts,
 * reductions, multiply-add, index generation, vector-length arithmetic (ADDVL, RDVL), element counts and
 * their increments, and immediates (logical, wide, CPY, DUP). Permutes, predicates, comparisons, floating
 * point, loads and stores and the SVE2 additions are in the other sve-*.ts files. Elements are unsigned
 * bigints; see zvec.ts.
 */
import { T, type Text } from '../../../core/i18n'
import { limmValue } from '../encoding/sve'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { clz, cls, ESIZE, maskEs, popcount, sat, sx, ux } from './vec'
import { allTrue, count, pget, predicated, zget, zset } from './zvec'

const LETTER = 'bhsd'
export const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')
/** valid() for element sizes given as letters. */
export const sizes = (allowed: string, field = 'size') => (f: Fields) => allowed.includes(LETTER[f[field]!]!)

export const INSTRS: InstrSpec[] = []
export const ALIASES: AliasSpec[] = []

/** Signed value of an element. */
const s = (v: bigint, es: number) => sx(v, es)
const satTo = (v: bigint, es: number, unsigned: boolean) => sat(v, es, unsigned)[0]

/** Shift right of an element by an amount that may exceed its size (sign fill or zero). */
export function shiftRight(a: bigint, sh: bigint, es: number, arith: boolean): bigint {
  const bits = BigInt(ESIZE[es]!)
  if (sh >= bits) return arith && s(a, es) < 0n ? maskEs(es) : 0n
  return ux((arith ? s(a, es) : a) >> sh, es)
}
export function shiftLeft(a: bigint, sh: bigint, es: number): bigint {
  return sh >= BigInt(ESIZE[es]!) ? 0n : ux(a << sh, es)
}

/* ------------------------------------------------------------------ predicated binary arithmetic */

interface BinOp {
  opc: number
  m: string
  sizes: string
  desc: Text
  fn: (a: bigint, b: bigint, es: number) => bigint
}

const divide = (signed: boolean, rev: boolean) => (a0: bigint, b0: bigint, es: number) => {
  const [a, b] = rev ? [b0, a0] : [a0, b0]
  if (b === 0n) return 0n
  if (!signed) return a / b
  // BigInt division truncates toward zero, as SDIV does; MIN / −1 wraps to MIN.
  return ux(s(a, es) / s(b, es), es)
}

const BIN: BinOp[] = [
  { opc: 0b00000, m: 'add', sizes: 'bhsd', desc: T('加：活跃元素 Zdn + Zm，不活跃的保持不变', 'Add: Zdn + Zm in active elements; inactive ones keep their value'), fn: (a, b, es) => ux(a + b, es) },
  { opc: 0b00001, m: 'sub', sizes: 'bhsd', desc: T('减：活跃元素 Zdn − Zm', 'Subtract: Zdn − Zm in active elements'), fn: (a, b, es) => ux(a - b, es) },
  { opc: 0b00011, m: 'subr', sizes: 'bhsd', desc: T('反向减：活跃元素 Zm − Zdn', 'Reversed subtract: Zm − Zdn in active elements'), fn: (a, b, es) => ux(b - a, es) },
  { opc: 0b01000, m: 'smax', sizes: 'bhsd', desc: T('有符号最大值', 'Signed maximum'), fn: (a, b, es) => (s(a, es) > s(b, es) ? a : b) },
  { opc: 0b01001, m: 'umax', sizes: 'bhsd', desc: T('无符号最大值', 'Unsigned maximum'), fn: (a, b) => (a > b ? a : b) },
  { opc: 0b01010, m: 'smin', sizes: 'bhsd', desc: T('有符号最小值', 'Signed minimum'), fn: (a, b, es) => (s(a, es) < s(b, es) ? a : b) },
  { opc: 0b01011, m: 'umin', sizes: 'bhsd', desc: T('无符号最小值', 'Unsigned minimum'), fn: (a, b) => (a < b ? a : b) },
  { opc: 0b01100, m: 'sabd', sizes: 'bhsd', desc: T('有符号差的绝对值 |Zdn − Zm|', 'Signed absolute difference |Zdn − Zm|'), fn: (a, b, es) => ux(s(a, es) > s(b, es) ? s(a, es) - s(b, es) : s(b, es) - s(a, es), es) },
  { opc: 0b01101, m: 'uabd', sizes: 'bhsd', desc: T('无符号差的绝对值', 'Unsigned absolute difference'), fn: (a, b) => (a > b ? a - b : b - a) },
  { opc: 0b10000, m: 'mul', sizes: 'bhsd', desc: T('乘：结果取低位', 'Multiply, keeping the low half'), fn: (a, b, es) => ux(a * b, es) },
  { opc: 0b10010, m: 'smulh', sizes: 'bhsd', desc: T('有符号乘，取积的高半部分', 'Signed multiply, keeping the high half'), fn: (a, b, es) => ux((s(a, es) * s(b, es)) >> BigInt(ESIZE[es]!), es) },
  { opc: 0b10011, m: 'umulh', sizes: 'bhsd', desc: T('无符号乘，取积的高半部分', 'Unsigned multiply, keeping the high half'), fn: (a, b, es) => ux((a * b) >> BigInt(ESIZE[es]!), es) },
  { opc: 0b10100, m: 'sdiv', sizes: 'sd', desc: T('有符号除：Zdn ÷ Zm，向 0 截断；除以 0 得 0', 'Signed divide Zdn ÷ Zm, truncating; dividing by 0 gives 0'), fn: divide(true, false) },
  { opc: 0b10101, m: 'udiv', sizes: 'sd', desc: T('无符号除；除以 0 得 0', 'Unsigned divide; dividing by 0 gives 0'), fn: divide(false, false) },
  { opc: 0b10110, m: 'sdivr', sizes: 'sd', desc: T('反向有符号除：Zm ÷ Zdn', 'Reversed signed divide Zm ÷ Zdn'), fn: divide(true, true) },
  { opc: 0b10111, m: 'udivr', sizes: 'sd', desc: T('反向无符号除：Zm ÷ Zdn', 'Reversed unsigned divide Zm ÷ Zdn'), fn: divide(false, true) },
  { opc: 0b11000, m: 'orr', sizes: 'bhsd', desc: T('按位或', 'Bitwise OR'), fn: (a, b) => a | b },
  { opc: 0b11001, m: 'eor', sizes: 'bhsd', desc: T('按位异或', 'Bitwise exclusive OR'), fn: (a, b) => a ^ b },
  { opc: 0b11010, m: 'and', sizes: 'bhsd', desc: T('按位与', 'Bitwise AND'), fn: (a, b) => a & b },
  { opc: 0b11011, m: 'bic', sizes: 'bhsd', desc: T('按位清除：Zdn AND NOT Zm', 'Bit clear: Zdn AND NOT Zm'), fn: (a, b, es) => a & ~b & maskEs(es) },
]

/** The destructive predicated form: Zdn = fn(Zdn, Zm) in active elements. */
export function binPred(fn: (a: bigint, b: bigint, es: number) => bigint, esOf: (f: Fields) => number = (f) => f.size!) {
  return (c: Cpu, f: Fields) => {
    const es = esOf(f)
    const pg = pget(c, f.Pg!, es)
    const a = zget(c, f.Zdn!, es)
    const b = zget(c, f.Zm!, es)
    predicated(c, f.Zdn!, es, pg, true, (i) => fn(a[i]!, b[i]!, es))
  }
}

for (const op of BIN) {
  INSTRS.push({
    id: `sve-${op.m}-pred`,
    mnemonic: op.m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 size:2 0 ${bin(op.opc, 5)} 000 Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>',
    valid: sizes(op.sizes),
    desc: op.desc,
    exec: binPred(op.fn),
  })
}

/* ------------------------------------------------------------------ reductions */

interface RedOp {
  opc: number
  m: string
  sizes: string
  desc: Text
  /** Result element size from the source's (saddv and uaddv give 64 bits). */
  wide?: boolean
  init: (es: number) => bigint
  fn: (acc: bigint, v: bigint, es: number) => bigint
}

const RED: RedOp[] = [
  { opc: 0b00000, m: 'saddv', sizes: 'bhs', wide: true, desc: T('有符号求和：活跃元素符号扩展后相加，结果放进 64 位的 Dd', 'Signed add reduction: active elements sign-extended and summed into the 64-bit Dd'), init: () => 0n, fn: (acc, v, es) => ux(acc + s(v, es), 3) },
  { opc: 0b00001, m: 'uaddv', sizes: 'bhsd', wide: true, desc: T('无符号求和：活跃元素相加，结果放进 64 位的 Dd', 'Unsigned add reduction: active elements summed into the 64-bit Dd'), init: () => 0n, fn: (acc, v) => ux(acc + v, 3) },
  { opc: 0b01000, m: 'smaxv', sizes: 'bhsd', desc: T('活跃元素的有符号最大值', 'Signed maximum of the active elements'), init: (es) => 1n << BigInt(ESIZE[es]! - 1), fn: (acc, v, es) => (s(v, es) > s(acc, es) ? v : acc) },
  { opc: 0b01001, m: 'umaxv', sizes: 'bhsd', desc: T('活跃元素的无符号最大值', 'Unsigned maximum of the active elements'), init: () => 0n, fn: (acc, v) => (v > acc ? v : acc) },
  { opc: 0b01010, m: 'sminv', sizes: 'bhsd', desc: T('活跃元素的有符号最小值', 'Signed minimum of the active elements'), init: (es) => maskEs(es) >> 1n, fn: (acc, v, es) => (s(v, es) < s(acc, es) ? v : acc) },
  { opc: 0b01011, m: 'uminv', sizes: 'bhsd', desc: T('活跃元素的无符号最小值', 'Unsigned minimum of the active elements'), init: (es) => maskEs(es), fn: (acc, v) => (v < acc ? v : acc) },
  { opc: 0b11000, m: 'orv', sizes: 'bhsd', desc: T('活跃元素按位或', 'Bitwise OR of the active elements'), init: () => 0n, fn: (acc, v) => acc | v },
  { opc: 0b11001, m: 'eorv', sizes: 'bhsd', desc: T('活跃元素按位异或', 'Bitwise exclusive OR of the active elements'), init: () => 0n, fn: (acc, v) => acc ^ v },
  { opc: 0b11010, m: 'andv', sizes: 'bhsd', desc: T('活跃元素按位与', 'Bitwise AND of the active elements'), init: (es) => maskEs(es), fn: (acc, v) => acc & v },
]

for (const op of RED) {
  INSTRS.push({
    id: `sve-${op.m}`,
    mnemonic: op.m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 size:2 0 ${bin(op.opc, 5)} 001 Pg:3 Zn:5 Vd:5`,
    syntax: op.wide ? '<Vd.d>, <Pg>, <Zn.size>' : '<Vd.size>, <Pg>, <Zn.size>',
    valid: sizes(op.sizes),
    desc: op.desc,
    exec(c, f) {
      const es = f.size!
      const pg = pget(c, f.Pg!, es)
      const z = zget(c, f.Zn!, es)
      let acc = op.init(es)
      z.forEach((v, i) => {
        if (pg[i]) acc = op.fn(acc, v, es)
      })
      c.vset(f.Vd!, op.wide ? 8 : ESIZE[es]! / 8, acc)
    },
  })
}

INSTRS.push({
  id: 'sve-movprfx-pred',
  mnemonic: 'movprfx',
  group: 'sve',
  feature: 'sve',
  bits: '00000100 size:2 0 1000 M 001 Pg:3 Zn:5 Zd:5',
  syntax: '<Zd.size>, <Pg/M>, <Zn.size>',
  desc: T('前缀：把 Zn 的活跃元素复制到 Zd（/z 时其余清零，/m 时保留），给紧跟的破坏性指令当初值', 'Prefix: copy the active elements of Zn into Zd (others zeroed with /z, kept with /m) as the start value of the destructive instruction that follows'),
  exec(c, f) {
    const es = f.size!
    const z = zget(c, f.Zn!, es)
    predicated(c, f.Zd!, es, pget(c, f.Pg!, es), f.M === 1, (i) => z[i]!)
  },
})

/* ------------------------------------------------------------------ predicated unary */

interface UnOp {
  opc: number
  m: string
  sizes: string
  desc: Text
  fn: (a: bigint, es: number) => bigint
}

const ext = (bits: number, signed: boolean) => (a: bigint, es: number) => ux(signed ? BigInt.asIntN(bits, a) : BigInt.asUintN(bits, a), es)
const sign = (es: number) => 1n << BigInt(ESIZE[es]! - 1)

const UN: UnOp[] = [
  { opc: 0b10000, m: 'sxtb', sizes: 'hsd', desc: T('把最低字节符号扩展成整个元素', 'Sign-extend the low byte to the element'), fn: ext(8, true) },
  { opc: 0b10001, m: 'uxtb', sizes: 'hsd', desc: T('把最低字节零扩展成整个元素', 'Zero-extend the low byte to the element'), fn: ext(8, false) },
  { opc: 0b10010, m: 'sxth', sizes: 'sd', desc: T('把低 16 位符号扩展成整个元素', 'Sign-extend the low 16 bits to the element'), fn: ext(16, true) },
  { opc: 0b10011, m: 'uxth', sizes: 'sd', desc: T('把低 16 位零扩展成整个元素', 'Zero-extend the low 16 bits to the element'), fn: ext(16, false) },
  { opc: 0b10100, m: 'sxtw', sizes: 'd', desc: T('把低 32 位符号扩展成 64 位', 'Sign-extend the low 32 bits to 64'), fn: ext(32, true) },
  { opc: 0b10101, m: 'uxtw', sizes: 'd', desc: T('把低 32 位零扩展成 64 位', 'Zero-extend the low 32 bits to 64'), fn: ext(32, false) },
  { opc: 0b10110, m: 'abs', sizes: 'bhsd', desc: T('绝对值（最小负数保持不变）', 'Absolute value (the most negative value stays)'), fn: (a, es) => ux(s(a, es) < 0n ? -s(a, es) : a, es) },
  { opc: 0b10111, m: 'neg', sizes: 'bhsd', desc: T('取负', 'Negate'), fn: (a, es) => ux(-a, es) },
  { opc: 0b11000, m: 'cls', sizes: 'bhsd', desc: T('从最高位起与符号位相同的位数（不含符号位）', 'Count leading sign bits (not counting the sign bit)'), fn: (a, es) => BigInt(cls(a, es)) },
  { opc: 0b11001, m: 'clz', sizes: 'bhsd', desc: T('从最高位起连续 0 的个数', 'Count leading zero bits'), fn: (a, es) => BigInt(clz(a, es)) },
  { opc: 0b11010, m: 'cnt', sizes: 'bhsd', desc: T('每个元素里 1 的个数', 'Count the one bits of each element'), fn: (a) => BigInt(popcount(a)) },
  { opc: 0b11011, m: 'cnot', sizes: 'bhsd', desc: T('逻辑非：元素为 0 得 1，否则得 0', 'Logical NOT: 1 where the element is 0, else 0'), fn: (a) => (a === 0n ? 1n : 0n) },
  { opc: 0b11100, m: 'fabs', sizes: 'hsd', desc: T('浮点绝对值：清除符号位', 'Floating-point absolute value: clear the sign bit'), fn: (a, es) => a & ~sign(es) },
  { opc: 0b11101, m: 'fneg', sizes: 'hsd', desc: T('浮点取负：翻转符号位', 'Floating-point negate: flip the sign bit'), fn: (a, es) => a ^ sign(es) },
  { opc: 0b11110, m: 'not', sizes: 'bhsd', desc: T('按位取反', 'Bitwise NOT'), fn: (a, es) => ~a & maskEs(es) },
]

for (const op of UN) {
  INSTRS.push({
    id: `sve-${op.m}`,
    mnemonic: op.m,
    group: op.m.startsWith('f') ? 'svefp' : 'sve',
    feature: 'sve',
    bits: `00000100 size:2 0 ${bin(op.opc, 5)} 101 Pg:3 Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Pg/m>, <Zn.size>',
    valid: sizes(op.sizes),
    desc: op.desc,
    exec(c, f) {
      const es = f.size!
      const z = zget(c, f.Zn!, es)
      predicated(c, f.Zd!, es, pget(c, f.Pg!, es), true, (i) => op.fn(z[i]!, es))
    },
  })
}

/* ------------------------------------------------------------------ shifts */

/** SQSHL, UQSHL, SQSHLU of one element by a left shift; saturating. */
const satShl = (a: bigint, sh: number, es: number, srcSigned: boolean, dstUnsigned: boolean) => satTo((srcSigned ? s(a, es) : a) << BigInt(sh), es, dstUnsigned)
/** Rounding shift right. */
const rshr = (a: bigint, sh: number, es: number, signed: boolean) => ux(((signed ? s(a, es) : a) + (1n << BigInt(sh - 1))) >> BigInt(sh), es)

interface ShImmOp {
  opc: number
  m: string
  right: boolean
  feature: string
  desc: Text
  fn: (a: bigint, sh: number, es: number) => bigint
}

const SH_IMM: ShImmOp[] = [
  { opc: 0b0000, m: 'asr', right: true, feature: 'sve', desc: T('算术右移（高位补符号位）', 'Arithmetic shift right (fills with the sign bit)'), fn: (a, sh, es) => shiftRight(a, BigInt(sh), es, true) },
  { opc: 0b0001, m: 'lsr', right: true, feature: 'sve', desc: T('逻辑右移（高位补 0）', 'Logical shift right (fills with zeros)'), fn: (a, sh, es) => shiftRight(a, BigInt(sh), es, false) },
  { opc: 0b0011, m: 'lsl', right: false, feature: 'sve', desc: T('逻辑左移', 'Logical shift left'), fn: (a, sh, es) => shiftLeft(a, BigInt(sh), es) },
  { opc: 0b0100, m: 'asrd', right: true, feature: 'sve', desc: T('为除法算术右移：向 0 舍入，等于除以 2 的 sh 次方', 'Arithmetic shift right for divide: rounds toward zero, dividing by 2^sh'), fn: (a, sh, es) => ux(s(a, es) / (1n << BigInt(sh)), es) },
  { opc: 0b0110, m: 'sqshl', right: false, feature: 'sve2', desc: T('有符号饱和左移', 'Signed saturating shift left'), fn: (a, sh, es) => satShl(a, sh, es, true, false) },
  { opc: 0b0111, m: 'uqshl', right: false, feature: 'sve2', desc: T('无符号饱和左移', 'Unsigned saturating shift left'), fn: (a, sh, es) => satShl(a, sh, es, false, true) },
  { opc: 0b1100, m: 'srshr', right: true, feature: 'sve2', desc: T('有符号舍入右移', 'Signed rounding shift right'), fn: (a, sh, es) => rshr(a, sh, es, true) },
  { opc: 0b1101, m: 'urshr', right: true, feature: 'sve2', desc: T('无符号舍入右移', 'Unsigned rounding shift right'), fn: (a, sh, es) => rshr(a, sh, es, false) },
  { opc: 0b1111, m: 'sqshlu', right: false, feature: 'sve2', desc: T('有符号数饱和左移成无符号数', 'Signed saturating shift left, unsigned result'), fn: (a, sh, es) => satShl(a, sh, es, true, true) },
]

/** The shift amount encoded in tsz:imm3 for an element size. */
export function tshAmount(f: Fields, right: boolean, tszBits: number): { es: number; sh: number } {
  const es = 31 - Math.clz32(tszBits)
  const total = (tszBits << 3) | f.imm3!
  const esize = ESIZE[es]!
  return { es, sh: right ? 2 * esize - total : total - esize }
}

for (const op of SH_IMM) {
  INSTRS.push({
    id: `sve-${op.m}-imm-pred`,
    mnemonic: op.m,
    group: 'sve',
    feature: op.feature,
    bits: `00000100 tszh:2 00 ${bin(op.opc, 4)} 100 Pg:3 tszl:2 imm3:3 Zdn:5`,
    syntax: `<Zdn.tsz>, <Pg/m>, <Zdn.tsz>, #<${op.right ? 'tsr' : 'tsl'}>`,
    valid: (f) => ((f.tszh! << 2) | f.tszl!) !== 0,
    desc: op.desc,
    exec(c, f) {
      const { es, sh } = tshAmount(f, op.right, (f.tszh! << 2) | f.tszl!)
      const z = zget(c, f.Zdn!, es)
      // SVE's saturating instructions do not set FPSR.QC.
      predicated(c, f.Zdn!, es, pget(c, f.Pg!, es), true, (i) => op.fn(z[i]!, sh, es))
    },
  })
}

interface ShVecOp {
  opc: number
  m: string
  desc: Text
  fn: (a: bigint, b: bigint, es: number) => bigint
}

const SH_VEC: ShVecOp[] = [
  { opc: 0b10000, m: 'asr', desc: T('算术右移，移位量是 Zm 对应元素', 'Arithmetic shift right by the matching Zm element'), fn: (a, b, es) => shiftRight(a, b, es, true) },
  { opc: 0b10001, m: 'lsr', desc: T('逻辑右移，移位量是 Zm 对应元素', 'Logical shift right by the matching Zm element'), fn: (a, b, es) => shiftRight(a, b, es, false) },
  { opc: 0b10011, m: 'lsl', desc: T('逻辑左移，移位量是 Zm 对应元素', 'Logical shift left by the matching Zm element'), fn: (a, b, es) => shiftLeft(a, b, es) },
  { opc: 0b10100, m: 'asrr', desc: T('反向算术右移：Zm 右移 Zdn 位', 'Reversed arithmetic shift right: Zm shifted by Zdn'), fn: (a, b, es) => shiftRight(b, a, es, true) },
  { opc: 0b10101, m: 'lsrr', desc: T('反向逻辑右移：Zm 右移 Zdn 位', 'Reversed logical shift right: Zm shifted by Zdn'), fn: (a, b, es) => shiftRight(b, a, es, false) },
  { opc: 0b10111, m: 'lslr', desc: T('反向逻辑左移：Zm 左移 Zdn 位', 'Reversed logical shift left: Zm shifted by Zdn'), fn: (a, b, es) => shiftLeft(b, a, es) },
]

for (const op of SH_VEC) {
  INSTRS.push({
    id: `sve-${op.m}-vec-pred`,
    mnemonic: op.m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 size:2 0 ${bin(op.opc, 5)} 100 Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>',
    desc: op.desc,
    exec: binPred(op.fn),
  })
}

/** The 64-bit element of a wide shift operand that covers element i of size es. */
const wideAt = (wide: bigint[], i: number, es: number) => wide[Math.floor((i * ESIZE[es]!) / 64)]!

for (const [opc, m, kind] of [
  [0b11000, 'asr', 'a'],
  [0b11001, 'lsr', 'r'],
  [0b11011, 'lsl', 'l'],
] as const) {
  const fn = (a: bigint, b: bigint, es: number) => (kind === 'l' ? shiftLeft(a, b, es) : shiftRight(a, b, es, kind === 'a'))
  INSTRS.push({
    id: `sve-${m}-wide-pred`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 size:2 0 ${bin(opc, 5)} 100 Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.d>',
    valid: sizes('bhs'),
    desc: T(`${m === 'lsl' ? '左移' : '右移'}，移位量是 Zm 中覆盖这个元素的 64 位元素`, `Shift ${m === 'lsl' ? 'left' : 'right'} by the 64-bit Zm element that covers each element`),
    exec(c, f) {
      const es = f.size!
      const a = zget(c, f.Zdn!, es)
      const w = zget(c, f.Zm!, 3)
      predicated(c, f.Zdn!, es, pget(c, f.Pg!, es), true, (i) => fn(a[i]!, wideAt(w, i, es), es))
    },
  })
}

/* ------------------------------------------------------------------ multiply-add */

for (const [op, m, sub] of [
  [0, 'mla', false],
  [1, 'mls', true],
] as const) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 size:2 0 Zm:5 01 ${op} Pg:3 Zn:5 Zda:5`,
    syntax: '<Zda.size>, <Pg/m>, <Zn.size>, <Zm.size>',
    desc: sub ? T('乘减：Zda − Zn × Zm', 'Multiply-subtract: Zda − Zn × Zm') : T('乘加：Zda + Zn × Zm', 'Multiply-add: Zda + Zn × Zm'),
    exec(c, f) {
      const es = f.size!
      const a = zget(c, f.Zda!, es)
      const n = zget(c, f.Zn!, es)
      const b = zget(c, f.Zm!, es)
      predicated(c, f.Zda!, es, pget(c, f.Pg!, es), true, (i) => ux(sub ? a[i]! - n[i]! * b[i]! : a[i]! + n[i]! * b[i]!, es))
    },
  })
}
for (const [op, m, sub] of [
  [0, 'mad', false],
  [1, 'msb', true],
] as const) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 size:2 0 Zm:5 11 ${op} Pg:3 Za:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zm.size>, <Za.size>',
    desc: sub ? T('乘减：Za − Zdn × Zm，结果放回 Zdn', 'Multiply-subtract: Za − Zdn × Zm into Zdn') : T('乘加：Za + Zdn × Zm，结果放回 Zdn', 'Multiply-add: Za + Zdn × Zm into Zdn'),
    exec(c, f) {
      const es = f.size!
      const d = zget(c, f.Zdn!, es)
      const b = zget(c, f.Zm!, es)
      const a = zget(c, f.Za!, es)
      predicated(c, f.Zdn!, es, pget(c, f.Pg!, es), true, (i) => ux(sub ? a[i]! - d[i]! * b[i]! : a[i]! + d[i]! * b[i]!, es))
    },
  })
}


/* ------------------------------------------------------------------ unpredicated arithmetic and logic */

const UNPRED: { opc: number; m: string; desc: Text; fn: (a: bigint, b: bigint, es: number) => bigint }[] = [
  { opc: 0b000, m: 'add', desc: T('加（所有元素）', 'Add (every element)'), fn: (a, b, es) => ux(a + b, es) },
  { opc: 0b001, m: 'sub', desc: T('减（所有元素）', 'Subtract (every element)'), fn: (a, b, es) => ux(a - b, es) },
  { opc: 0b100, m: 'sqadd', desc: T('有符号饱和加', 'Signed saturating add'), fn: (a, b, es) => satTo(s(a, es) + s(b, es), es, false) },
  { opc: 0b101, m: 'uqadd', desc: T('无符号饱和加', 'Unsigned saturating add'), fn: (a, b, es) => satTo(a + b, es, true) },
  { opc: 0b110, m: 'sqsub', desc: T('有符号饱和减', 'Signed saturating subtract'), fn: (a, b, es) => satTo(s(a, es) - s(b, es), es, false) },
  { opc: 0b111, m: 'uqsub', desc: T('无符号饱和减', 'Unsigned saturating subtract'), fn: (a, b, es) => satTo(a - b, es, true) },
]

/** Zd = fn(Zn, Zm) in every element. */
export function binAll(fn: (a: bigint, b: bigint, es: number) => bigint, esOf: (f: Fields) => number = (f) => f.size!) {
  return (c: Cpu, f: Fields) => {
    const es = esOf(f)
    const a = zget(c, f.Zn!, es)
    const b = zget(c, f.Zm!, es)
    zset(c, f.Zd!, a.map((x, i) => fn(x, b[i]!, es)), es)
  }
}

for (const op of UNPRED) {
  INSTRS.push({
    id: `sve-${op.m}-unpred`,
    mnemonic: op.m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 size:2 1 Zm:5 000 ${bin(op.opc, 3)} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc: op.desc,
    exec: binAll(op.fn),
  })
}

const LOGIC: [number, string, Text, (a: bigint, b: bigint) => bigint][] = [
  [0b00, 'and', T('按位与（整个向量）', 'Bitwise AND (whole vector)'), (a, b) => a & b],
  [0b01, 'orr', T('按位或（整个向量）', 'Bitwise OR (whole vector)'), (a, b) => a | b],
  [0b10, 'eor', T('按位异或（整个向量）', 'Bitwise exclusive OR (whole vector)'), (a, b) => a ^ b],
  [0b11, 'bic', T('按位清除：Zn AND NOT Zm（整个向量）', 'Bit clear: Zn AND NOT Zm (whole vector)'), (a, b) => a & ~b & maskEs(3)],
]
for (const [opc, m, desc, fn] of LOGIC) {
  INSTRS.push({
    id: `sve-${m}-unpred`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 ${bin(opc, 2)} 1 Zm:5 001100 Zn:5 Zd:5`,
    syntax: '<Zd.d>, <Zn.d>, <Zm.d>',
    desc,
    exec: binAll((a, b) => fn(a, b), () => 3),
  })
}
ALIASES.push({
  id: 'sve-mov-orr',
  of: 'sve-orr-unpred',
  mnemonic: 'mov',
  syntax: '<Zd.d>, <Zn.d>',
  encode: (f) => void (f.Zm = f.Zn),
  prefer: (f) => f.Zn === f.Zm,
  desc: T('复制整个 z 寄存器（orr 的别名）', 'Copy a whole z register (an alias of orr)'),
})

/* SVE2 bitwise ternary operations, on the whole vector. */
const TERN: [number, number, string, Text, (d: bigint, m: bigint, k: bigint) => bigint][] = [
  [0b00, 0, 'eor3', T('三路异或：Zdn ^ Zm ^ Zk', 'Three-way exclusive OR: Zdn ^ Zm ^ Zk'), (d, m, k) => d ^ m ^ k],
  [0b01, 0, 'bcax', T('清除再异或：Zdn ^ (Zm AND NOT Zk)', 'Bit clear and exclusive OR: Zdn ^ (Zm AND NOT Zk)'), (d, m, k) => d ^ (m & ~k & maskEs(3))],
  [0b00, 1, 'bsl', T('按位选择：Zk 为 1 的位取 Zdn，否则取 Zm', 'Bitwise select: Zdn where Zk is 1, else Zm'), (d, m, k) => (d & k) | (m & ~k & maskEs(3))],
  [0b01, 1, 'bsl1n', T('按位选择，第一个源取反', 'Bitwise select with the first source inverted'), (d, m, k) => (~d & k & maskEs(3)) | (m & ~k & maskEs(3))],
  [0b10, 1, 'bsl2n', T('按位选择，第二个源取反', 'Bitwise select with the second source inverted'), (d, m, k) => (d & k) | (~m & ~k & maskEs(3))],
  [0b11, 1, 'nbsl', T('按位选择后取反', 'Bitwise inverted select'), (d, m, k) => ~((d & k) | (m & ~k)) & maskEs(3)],
]
for (const [opc, o2, m, desc, fn] of TERN) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: 'sve2',
    feature: 'sve2',
    bits: `00000100 ${bin(opc, 2)} 1 Zm:5 00111 ${o2} Zk:5 Zdn:5`,
    syntax: '<Zdn.d>, <Zdn.d>, <Zm.d>, <Zk.d>',
    desc,
    exec(c, f) {
      const d = zget(c, f.Zdn!, 3)
      const b = zget(c, f.Zm!, 3)
      const k = zget(c, f.Zk!, 3)
      zset(c, f.Zdn!, d.map((x, i) => fn(x, b[i]!, k[i]!)), 3)
    },
  })
}

/* ------------------------------------------------------------------ index generation */

const indexExec = (start: (c: Cpu, f: Fields, es: number) => bigint, step: (c: Cpu, f: Fields, es: number) => bigint) => (c: Cpu, f: Fields) => {
  const es = f.size!
  const a = start(c, f, es)
  const b = step(c, f, es)
  zset(c, f.Zd!, Array.from({ length: count(c, es) }, (_, i) => ux(a + BigInt(i) * b, es)), es)
}
const simm5 = (v: number) => BigInt(BigInt.asIntN(5, BigInt(v)))
const scalar = (c: Cpu, n: number, es: number) => (es === 3 ? c.x(n) : c.r(0, n))
const INDEX_DESC = T('等差序列：元素 i = 起点 + i × 步长', 'Arithmetic sequence: element i = start + i × step')
INSTRS.push(
  {
    id: 'sve-index-ii',
    mnemonic: 'index',
    group: 'sve',
    feature: 'sve',
    bits: '00000100 size:2 1 imm5b:5 010000 imm5:5 Zd:5',
    syntax: '<Zd.size>, #<s:imm5>, #<s:imm5b>',
    desc: INDEX_DESC,
    exec: indexExec((_c, f) => simm5(f.imm5!), (_c, f) => simm5(f.imm5b!)),
  },
  {
    id: 'sve-index-ri',
    mnemonic: 'index',
    group: 'sve',
    feature: 'sve',
    bits: '00000100 size:2 1 imm5:5 010001 Rn:5 Zd:5',
    syntax: '<Zd.size>, <Rn:size>, #<s:imm5>',
    desc: INDEX_DESC,
    exec: indexExec((c, f, es) => scalar(c, f.Rn!, es), (_c, f) => simm5(f.imm5!)),
  },
  {
    id: 'sve-index-ir',
    mnemonic: 'index',
    group: 'sve',
    feature: 'sve',
    bits: '00000100 size:2 1 Rm:5 010010 imm5:5 Zd:5',
    syntax: '<Zd.size>, #<s:imm5>, <Rm:size>',
    desc: INDEX_DESC,
    exec: indexExec((_c, f) => simm5(f.imm5!), (c, f, es) => scalar(c, f.Rm!, es)),
  },
  {
    id: 'sve-index-rr',
    mnemonic: 'index',
    group: 'sve',
    feature: 'sve',
    bits: '00000100 size:2 1 Rm:5 010011 Rn:5 Zd:5',
    syntax: '<Zd.size>, <Rn:size>, <Rm:size>',
    desc: INDEX_DESC,
    exec: indexExec((c, f, es) => scalar(c, f.Rn!, es), (c, f, es) => scalar(c, f.Rm!, es)),
  },
)

/* ------------------------------------------------------------------ vector length arithmetic */

const M64 = 0xffff_ffff_ffff_ffffn
const simm6 = (v: number) => BigInt.asIntN(6, BigInt(v))
INSTRS.push(
  {
    id: 'sve-addvl',
    mnemonic: 'addvl',
    group: 'sve',
    feature: 'sve',
    bits: '00000100 001 Rn:5 01010 imm6:6 Rd:5',
    syntax: '<Xd|SP>, <Xn|SP>, #<s:imm6>',
    desc: T('Xd = Xn + imm × 向量的字节数（VL ÷ 8）：在栈上给 z 寄存器留空间', 'Xd = Xn + imm × the vector size in bytes (VL ÷ 8): room for z registers on the stack'),
    exec: (c, f) => c.setXsp(f.Rd!, (c.xsp(f.Rn!) + simm6(f.imm6!) * BigInt(c.vl)) & M64),
  },
  {
    id: 'sve-addpl',
    mnemonic: 'addpl',
    group: 'sve',
    feature: 'sve',
    bits: '00000100 011 Rn:5 01010 imm6:6 Rd:5',
    syntax: '<Xd|SP>, <Xn|SP>, #<s:imm6>',
    desc: T('Xd = Xn + imm × 谓词的字节数（VL ÷ 64）', 'Xd = Xn + imm × the predicate size in bytes (VL ÷ 64)'),
    exec: (c, f) => c.setXsp(f.Rd!, (c.xsp(f.Rn!) + simm6(f.imm6!) * BigInt(c.vl / 8)) & M64),
  },
  {
    id: 'sve-rdvl',
    mnemonic: 'rdvl',
    group: 'sve',
    feature: 'sve',
    bits: '00000100 101 11111 01010 imm6:6 Rd:5',
    syntax: '<Xd>, #<s:imm6>',
    desc: T('Xd = imm × 向量的字节数：读出向量长度', 'Xd = imm × the vector size in bytes: reads the vector length'),
    exec: (c, f) => c.setX(f.Rd!, (simm6(f.imm6!) * BigInt(c.vl)) & M64),
  },
)

/* ------------------------------------------------------------------ SVE2 multiply, unpredicated */

const MULU: [number, string, string, Text, (a: bigint, b: bigint, es: number) => bigint][] = [
  [0b00, 'mul', 'bhsd', T('乘（所有元素），结果取低位', 'Multiply (every element), keeping the low half'), (a, b, es) => ux(a * b, es)],
  [0b01, 'pmul', 'b', T('多项式乘（GF(2) 上的无进位乘法）', 'Polynomial multiply (carry-less, over GF(2))'), (a, b) => polyLow(a, b, 8)],
  [0b10, 'smulh', 'bhsd', T('有符号乘，取高半部分', 'Signed multiply, keeping the high half'), (a, b, es) => ux((s(a, es) * s(b, es)) >> BigInt(ESIZE[es]!), es)],
  [0b11, 'umulh', 'bhsd', T('无符号乘，取高半部分', 'Unsigned multiply, keeping the high half'), (a, b, es) => ux((a * b) >> BigInt(ESIZE[es]!), es)],
]
function polyLow(a: bigint, b: bigint, bits: number): bigint {
  let r = 0n
  for (let i = 0; i < bits; i++) if ((b >> BigInt(i)) & 1n) r ^= a << BigInt(i)
  return r & ((1n << BigInt(bits)) - 1n)
}
for (const [opc, m, sz, desc, fn] of MULU) {
  INSTRS.push({
    id: `sve-${m}-unpred`,
    mnemonic: m,
    group: 'sve2',
    feature: 'sve2',
    bits: `00000100 size:2 1 Zm:5 0110 ${bin(opc, 2)} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    valid: sizes(sz),
    desc,
    exec: binAll(fn),
  })
}

/* ------------------------------------------------------------------ unpredicated shifts */

for (const [opc, m] of [
  [0b00, 'asr'],
  [0b01, 'lsr'],
  [0b11, 'lsl'],
] as const) {
  const right = m !== 'lsl'
  INSTRS.push({
    id: `sve-${m}-imm-unpred`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 tszh:2 1 tszl:2 imm3:3 1001 ${bin(opc, 2)} Zn:5 Zd:5`,
    syntax: `<Zd.tsz>, <Zn.tsz>, #<${right ? 'tsr' : 'tsl'}>`,
    valid: (f) => ((f.tszh! << 2) | f.tszl!) !== 0,
    desc: right ? T(`${m === 'asr' ? '算术' : '逻辑'}右移（所有元素）`, `${m === 'asr' ? 'Arithmetic' : 'Logical'} shift right (every element)`) : T('逻辑左移（所有元素）', 'Logical shift left (every element)'),
    exec(c, f) {
      const { es, sh } = tshAmount(f, right, (f.tszh! << 2) | f.tszl!)
      const z = zget(c, f.Zn!, es)
      zset(c, f.Zd!, z.map((a) => (right ? shiftRight(a, BigInt(sh), es, m === 'asr') : shiftLeft(a, BigInt(sh), es))), es)
    },
  })
  INSTRS.push({
    id: `sve-${m}-wide-unpred`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 size:2 1 Zm:5 1000 ${bin(opc, 2)} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.d>',
    valid: sizes('bhs'),
    desc: T('移位，移位量是 Zm 中覆盖这个元素的 64 位元素', 'Shift by the 64-bit Zm element that covers each element'),
    exec(c, f) {
      const es = f.size!
      const z = zget(c, f.Zn!, es)
      const w = zget(c, f.Zm!, 3)
      zset(c, f.Zd!, z.map((a, i) => (right ? shiftRight(a, wideAt(w, i, es), es, m === 'asr') : shiftLeft(a, wideAt(w, i, es), es))), es)
    },
  })
}

/* ------------------------------------------------------------------ address generation */

const ADR: [number, string, string, (v: bigint) => bigint][] = [
  [0b00, 'd', 'sxtw', (v) => BigInt.asIntN(32, v)],
  [0b01, 'd', 'uxtw', (v) => BigInt.asUintN(32, v)],
  [0b10, 's', 'lsl', (v) => v],
  [0b11, 'd', 'lsl', (v) => v],
]
for (const [opc, t, mod, ext] of ADR) {
  const es = t === 's' ? 2 : 3
  INSTRS.push({
    id: `sve-adr-${t}-${mod}`,
    mnemonic: 'adr',
    group: 'sve',
    feature: 'sve',
    bits: `00000100 ${bin(opc, 2)} 1 Zm:5 1010 msz:2 Zn:5 Zd:5`,
    syntax: mod === 'lsl' ? `<Zd.${t}>, [<Zn.${t}>, <Zm.${t}>{, lsl #<u:msz>}]` : `<Zd.${t}>, [<Zn.${t}>, <Zm.${t}>, ${mod}{ #<u:msz>}]`,
    desc: T('向量地址：Zn + (Zm 扩展后左移 msz 位)', 'Vector of addresses: Zn + (Zm extended, shifted left by msz)'),
    exec(c, f) {
      const n = zget(c, f.Zn!, es)
      const m = zget(c, f.Zm!, es)
      zset(c, f.Zd!, n.map((a, i) => ux(a + (ext(m[i]!) << BigInt(f.msz!)), es)), es)
    },
  })
}

INSTRS.push({
  id: 'sve-movprfx',
  mnemonic: 'movprfx',
  group: 'sve',
  feature: 'sve',
  bits: '00000100 001 00000 101111 Zn:5 Zd:5',
  syntax: '<Zd>, <Zn>',
  desc: T('前缀：把 Zn 整个复制到 Zd，给紧跟的破坏性指令当初值', 'Prefix: copy all of Zn into Zd as the start value of the destructive instruction that follows'),
  exec: (c, f) => c.vwrite(f.Zd!, c.vread(f.Zn!, c.vl)),
})

/* ------------------------------------------------------------------ element counts */

/** How many elements of size es a pattern selects at the current vector length. */
export function patternCount(c: Cpu, pattern: number, es: number): number {
  const n = count(c, es)
  if (pattern === 0) return 2 ** Math.floor(Math.log2(n))
  if (pattern >= 1 && pattern <= 8) return pattern <= n ? pattern : 0
  if (pattern >= 9 && pattern <= 13) {
    const k = 16 << (pattern - 9)
    return k <= n ? k : 0
  }
  if (pattern === 29) return n - (n % 4)
  if (pattern === 30) return n - (n % 3)
  if (pattern === 31) return n
  return 0
}

const NAMES = 'bhwd'
const PAT = '{, <pattern>{, mul #<u:imm4+1=0>}}'
for (let es = 0; es < 4; es++) {
  const L = NAMES[es]!
  INSTRS.push({
    id: `sve-cnt${L}`,
    mnemonic: `cnt${L}`,
    group: 'sve',
    feature: 'sve',
    bits: `00000100 ${bin(es, 2)} 10 imm4:4 111000 pattern:5 Rd:5`,
    syntax: `<Xd>${PAT}`,
    desc: T(`Xd = 模式选中的${['字节', '半字', '字', '双字'][es]}个数 × mul`, `Xd = the number of ${['bytes', 'halfwords', 'words', 'doublewords'][es]} the pattern selects × mul`),
    exec: (c, f) => c.setX(f.Rd!, BigInt(patternCount(c, f.pattern!, es) * (f.imm4! + 1))),
  })
  for (const [D, op] of [
    [0, 'inc'],
    [1, 'dec'],
  ] as const) {
    INSTRS.push({
      id: `sve-${op}${L}`,
      mnemonic: `${op}${L}`,
      group: 'sve',
      feature: 'sve',
      bits: `00000100 ${bin(es, 2)} 11 imm4:4 11100 ${D} pattern:5 Rd:5`,
      syntax: `<Xd>${PAT}`,
      desc: T(`Xd ${D ? '减去' : '加上'}模式选中的元素个数 × mul`, `Xd ${D ? 'minus' : 'plus'} the number of elements the pattern selects × mul`),
      exec(c, f) {
        const k = BigInt(patternCount(c, f.pattern!, es) * (f.imm4! + 1))
        c.setX(f.Rd!, (D ? c.x(f.Rd!) - k : c.x(f.Rd!) + k) & M64)
      },
    })
    if (es > 0)
      INSTRS.push({
        id: `sve-${op}${L}-vec`,
        mnemonic: `${op}${L}`,
        group: 'sve',
        feature: 'sve',
        bits: `00000100 ${bin(es, 2)} 11 imm4:4 11000 ${D} pattern:5 Zdn:5`,
        syntax: `<Zdn.${'bhsd'[es]}>${PAT}`,
        desc: T(`每个元素${D ? '减去' : '加上'}模式选中的元素个数 × mul`, `Each element ${D ? 'minus' : 'plus'} the number of elements the pattern selects × mul`),
        exec(c, f) {
          const k = BigInt(patternCount(c, f.pattern!, es) * (f.imm4! + 1))
          zset(c, f.Zdn!, zget(c, f.Zdn!, es).map((a) => ux(D ? a - k : a + k, es)), es)
        },
      })
    for (const [U, sat] of [
      [0, 's'],
      [1, 'u'],
    ] as const) {
      const m = `${sat}q${op}${L}`
      const step = (c: Cpu, f: Fields) => BigInt(patternCount(c, f.pattern!, es) * (f.imm4! + 1)) * (D ? -1n : 1n)
      INSTRS.push({
        id: `sve-${m}-w`,
        mnemonic: m,
        group: 'sve',
        feature: 'sve',
        bits: `00000100 ${bin(es, 2)} 10 imm4:4 1111 ${D}${U} pattern:5 Rd:5`,
        syntax: U ? `<Wd>${PAT}` : `<Xd>, <Wd>${PAT}`,
        desc: T(`32 位${U ? '无' : '有'}符号饱和地${D ? '减去' : '加上'}元素个数 × mul${U ? '' : '，结果符号扩展到 64 位'}`, `${U ? 'Unsigned' : 'Signed'} saturating 32-bit ${D ? 'decrement' : 'increment'} by the element count × mul${U ? '' : ', sign-extended to 64 bits'}`),
        exec(c, f) {
          const v = U ? c.r(0, f.Rd!) : BigInt.asIntN(32, c.r(0, f.Rd!))
          const r = satTo(v + step(c, f), 2, U === 1)
          c.setX(f.Rd!, U ? r : BigInt.asUintN(64, BigInt.asIntN(32, r)))
        },
      })
      INSTRS.push({
        id: `sve-${m}-x`,
        mnemonic: m,
        group: 'sve',
        feature: 'sve',
        bits: `00000100 ${bin(es, 2)} 11 imm4:4 1111 ${D}${U} pattern:5 Rd:5`,
        syntax: `<Xd>${PAT}`,
        desc: T(`64 位${U ? '无' : '有'}符号饱和地${D ? '减去' : '加上'}元素个数 × mul`, `${U ? 'Unsigned' : 'Signed'} saturating 64-bit ${D ? 'decrement' : 'increment'} by the element count × mul`),
        exec(c, f) {
          const v = U ? c.x(f.Rd!) : BigInt.asIntN(64, c.x(f.Rd!))
          c.setX(f.Rd!, satTo(v + step(c, f), 3, U === 1))
        },
      })
      if (es > 0)
        INSTRS.push({
          id: `sve-${m}-vec`,
          mnemonic: m,
          group: 'sve',
          feature: 'sve',
          bits: `00000100 ${bin(es, 2)} 10 imm4:4 1100 ${D}${U} pattern:5 Zdn:5`,
          syntax: `<Zdn.${'bhsd'[es]}>${PAT}`,
          desc: T(`每个元素${U ? '无' : '有'}符号饱和地${D ? '减去' : '加上'}元素个数 × mul`, `${U ? 'Unsigned' : 'Signed'} saturating ${D ? 'decrement' : 'increment'} of each element by the element count × mul`),
          exec(c, f) {
            const k = step(c, f)
            zset(c, f.Zdn!, zget(c, f.Zdn!, es).map((a) => satTo((U ? a : s(a, es)) + k, es, U === 1)), es)
          },
        })
    }
  }
}

/* ------------------------------------------------------------------ immediates */

const limmOk = (f: Fields) => limmValue(f.imm13!) !== null
for (const [opc, m, fn] of [
  [0b00, 'orr', (a: bigint, b: bigint) => a | b],
  [0b01, 'eor', (a: bigint, b: bigint) => a ^ b],
  [0b10, 'and', (a: bigint, b: bigint) => a & b],
] as const) {
  INSTRS.push({
    id: `sve-${m}-imm`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00000101 ${bin(opc, 2)} 0000 imm13:13 Zdn:5`,
    syntax: '<Zdn.limm>, <Zdn.limm>, #<limm>',
    valid: limmOk,
    desc: T(`和逻辑立即数按位${{ orr: '或', eor: '异或', and: '与' }[m]}`, `Bitwise ${{ orr: 'OR', eor: 'exclusive OR', and: 'AND' }[m]} with a logical immediate`),
    exec(c, f) {
      const imm = limmValue(f.imm13!)!
      zset(c, f.Zdn!, zget(c, f.Zdn!, 3).map((a) => fn(a, imm)), 3)
    },
  })
}
INSTRS.push({
  id: 'sve-dupm',
  mnemonic: 'dupm',
  group: 'sve',
  feature: 'sve',
  bits: '00000101 11 0000 imm13:13 Zd:5',
  syntax: '<Zd.limm>, #<limm>',
  valid: limmOk,
  desc: T('把逻辑立即数复制到每个元素', 'Broadcast a logical immediate to every element'),
  exec: (c, f) => zset(c, f.Zd!, new Array(count(c, 3)).fill(limmValue(f.imm13!)!), 3),
})
/** Whether DUP (immediate) can hold a 64-bit value: a signed byte, or a signed byte times 256. */
const dupOk = (v: bigint) => (v >= -128n && v <= 127n) || ((v & 0xffn) === 0n && v >= -32768n && v <= 32767n)
/** DUPM prints as MOV unless DUP (immediate) could write the same value at some element size. */
function dupmIsMov(f: Fields): boolean {
  const V = limmValue(f.imm13!)!
  if (dupOk(BigInt.asIntN(64, V))) return false
  for (const bits of [32, 16, 8]) {
    const chunk = BigInt.asUintN(bits, V)
    let rep = chunk
    for (let b = bits; b < 64; b *= 2) rep |= rep << BigInt(b)
    if (rep === V && (bits === 8 || dupOk(BigInt.asIntN(bits, chunk)))) return false
  }
  return true
}
ALIASES.push(
  { id: 'sve-bic-imm', of: 'sve-and-imm', mnemonic: 'bic', syntax: '<Zdn.limm>, <Zdn.limm>, #<limm>', prefer: false, desc: T('和立即数取反后按位与（and 的写法）', 'AND with the inverted immediate (written as and)') },
  { id: 'sve-eon-imm', of: 'sve-eor-imm', mnemonic: 'eon', syntax: '<Zdn.limm>, <Zdn.limm>, #<limm>', prefer: false },
  { id: 'sve-orn-imm', of: 'sve-orr-imm', mnemonic: 'orn', syntax: '<Zdn.limm>, <Zdn.limm>, #<limm>', prefer: false },
)

/** A signed 8-bit immediate, shifted left by 8 when sh is set. */
export const cpyImm = (f: Fields) => BigInt.asIntN(8, BigInt(f.imm8!)) << BigInt(8 * f.sh!)
const shOk = (f: Fields) => !(f.size === 0 && f.sh === 1)

INSTRS.push({
  id: 'sve-cpy-imm',
  mnemonic: 'cpy',
  group: 'sve',
  feature: 'sve',
  bits: '00000101 size:2 01 Pg:4 0 M sh imm8:8 Zd:5',
  syntax: '<Zd.size>, <Pg/M>, #<imm8sh:s:size>',
  valid: shOk,
  desc: T('把立即数复制到活跃元素（/z 时其余清零，/m 时保留）', 'Copy an immediate into the active elements (others zeroed with /z, kept with /m)'),
  exec(c, f) {
    const es = f.size!
    const v = ux(cpyImm(f), es)
    predicated(c, f.Zd!, es, pget(c, f.Pg!, es), f.M === 1, () => v)
  },
})
ALIASES.push({ id: 'sve-mov-cpy-imm', of: 'sve-cpy-imm', mnemonic: 'mov', syntax: '<Zd.size>, <Pg/M>, #<imm8sh:s:size>' })

INSTRS.push({
  id: 'sve-dup-imm',
  mnemonic: 'dup',
  group: 'sve',
  feature: 'sve',
  bits: '00100101 size:2 111 00 011 sh imm8:8 Zd:5',
  syntax: '<Zd.size>, #<imm8sh:s:size>',
  valid: shOk,
  desc: T('把立即数复制到每个元素', 'Broadcast an immediate to every element'),
  exec(c, f) {
    const es = f.size!
    zset(c, f.Zd!, new Array(count(c, es)).fill(ux(cpyImm(f), es)), es)
  },
})
ALIASES.push({ id: 'sve-mov-dup-imm', of: 'sve-dup-imm', mnemonic: 'mov', syntax: '<Zd.size>, #<imm8sh:s:size>' })
// After DUP: MOV with an immediate is DUP when DUP can hold it, DUPM otherwise.
ALIASES.push({ id: 'sve-mov-dupm', of: 'sve-dupm', mnemonic: 'mov', syntax: '<Zd.limm>, #<limm>', prefer: dupmIsMov })

const WIDE: [number, string, Text, (a: bigint, b: bigint, es: number) => bigint][] = [
  [0b000, 'add', T('加立即数', 'Add an immediate'), (a, b, es) => ux(a + b, es)],
  [0b001, 'sub', T('减立即数', 'Subtract an immediate'), (a, b, es) => ux(a - b, es)],
  [0b011, 'subr', T('立即数减元素', 'Subtract each element from an immediate'), (a, b, es) => ux(b - a, es)],
  [0b100, 'sqadd', T('有符号饱和加立即数', 'Signed saturating add of an immediate'), (a, b, es) => satTo(s(a, es) + b, es, false)],
  [0b101, 'uqadd', T('无符号饱和加立即数', 'Unsigned saturating add of an immediate'), (a, b, es) => satTo(a + b, es, true)],
  [0b110, 'sqsub', T('有符号饱和减立即数', 'Signed saturating subtract of an immediate'), (a, b, es) => satTo(s(a, es) - b, es, false)],
  [0b111, 'uqsub', T('无符号饱和减立即数', 'Unsigned saturating subtract of an immediate'), (a, b, es) => satTo(a - b, es, true)],
]
for (const [opc, m, desc, fn] of WIDE) {
  INSTRS.push({
    id: `sve-${m}-imm`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00100101 size:2 100 ${bin(opc, 3)} 11 sh imm8:8 Zdn:5`,
    syntax: '<Zdn.size>, <Zdn.size>, #<imm8sh:u:size>',
    valid: shOk,
    desc,
    exec(c, f) {
      const es = f.size!
      const imm = BigInt(f.imm8!) << BigInt(8 * f.sh!)
      zset(c, f.Zdn!, zget(c, f.Zdn!, es).map((a) => fn(a, imm, es)), es)
    },
  })
}
const MINMAX: [number, string, boolean, (a: bigint, b: bigint) => boolean][] = [
  [0b00, 'smax', true, (a, b) => a > b],
  [0b01, 'umax', false, (a, b) => a > b],
  [0b10, 'smin', true, (a, b) => a < b],
  [0b11, 'umin', false, (a, b) => a < b],
]
for (const [opc, m, signed, better] of MINMAX) {
  INSTRS.push({
    id: `sve-${m}-imm`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `00100101 size:2 101 0${bin(opc, 2)} 11 0 imm8:8 Zdn:5`,
    syntax: signed ? '<Zdn.size>, <Zdn.size>, #<s8:imm8>' : '<Zdn.size>, <Zdn.size>, #<u:imm8>',
    desc: T(`和立即数比较取${m.startsWith('smax') || m.startsWith('umax') ? '大' : '小'}（${signed ? '有' : '无'}符号）`, `${m.includes('max') ? 'Maximum' : 'Minimum'} with an immediate (${signed ? 'signed' : 'unsigned'})`),
    exec(c, f) {
      const es = f.size!
      const imm = signed ? BigInt.asIntN(8, BigInt(f.imm8!)) : BigInt(f.imm8!)
      zset(c, f.Zdn!, zget(c, f.Zdn!, es).map((a) => {
        const x = signed ? s(a, es) : a
        return better(imm, x) ? ux(imm, es) : a
      }), es)
    },
  })
}
INSTRS.push({
  id: 'sve-mul-imm',
  mnemonic: 'mul',
  group: 'sve',
  feature: 'sve',
  bits: '00100101 size:2 110 000 11 0 imm8:8 Zdn:5',
  syntax: '<Zdn.size>, <Zdn.size>, #<s8:imm8>',
  desc: T('乘以有符号立即数，结果取低位', 'Multiply by a signed immediate, keeping the low half'),
  exec(c, f) {
    const es = f.size!
    const imm = BigInt.asIntN(8, BigInt(f.imm8!))
    zset(c, f.Zdn!, zget(c, f.Zdn!, es).map((a) => ux(a * imm, es)), es)
  },
})

export { allTrue, popcount }
