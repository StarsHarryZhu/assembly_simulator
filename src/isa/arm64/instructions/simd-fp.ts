/**
 * Advanced SIMD floating point, vector and scalar: three same, two-register miscellaneous (rounding,
 * conversions, estimates, compares with zero), across lanes, pairwise, by element, fixed-point conversions,
 * precision changes (FCVTN, FCVTL, FCVTXN, BFCVTN), FEAT_FHM (FMLAL), FEAT_FCMA (FCMLA, FCADD) and
 * FEAT_BF16 (BFDOT, BFMLALB/T, BFMMLA). Half precision (FEAT_FP16) has its own encodings of most forms.
 */
import { T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import * as sf from '../softfloat'
import type { Cpu, Fields } from './types'
import { ESIZE, readV, writeV, ones } from './vec'
import { indexedElem } from './simd-more'

type Env = sf.FpEnv
type Fmt = sf.Fmt
const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')
const FMT: Fmt[] = [sf.F16, sf.F16, sf.F32, sf.F64]
const INSTRS_: InstrSpec[] = []
const ALIASES_: AliasSpec[] = []

/** Vector lanes: R[i] = fn(i, A, B, D) with the FP environment; flags go to FPSR once. */
function fpVector(c: Cpu, f: Fields, es: number, fn: (e: Env, t: Fmt, a: bigint, b: bigint, d: bigint) => bigint, opts: { b?: boolean; acc?: boolean; pair?: boolean } = {}): void {
  const bytes = f.Q === 0 && es < 3 ? 8 : 16
  const t = FMT[es]!
  const env = c.fpEnv()
  const A = readV(c, f.Rn!, es, bytes)
  const B = opts.b === false ? A : readV(c, f.Rm!, es, bytes)
  const D = opts.acc ? readV(c, f.Rd!, es, bytes) : null
  let R: bigint[]
  if (opts.pair) {
    const cat = [...A, ...B]
    R = A.map((_, i) => fn(env, t, cat[2 * i]!, cat[2 * i + 1]!, 0n))
  } else R = A.map((a, i) => fn(env, t, a, B[i]!, D ? D[i]! : 0n))
  c.fpFlags(env)
  writeV(c, f.Rd!, R, es)
}

/**
 * A scalar of element size es: Vd = fn(Vn, Vm, Vd). With FPCR.NEP the rest of the register comes from
 * `merge` (as the CPU does it: the destination for one source, Vm for compares).
 */
function fpScalar(c: Cpu, f: Fields, es: number, fn: (e: Env, t: Fmt, a: bigint, b: bigint, d: bigint) => bigint, merge: 'n' | 'm' | 'd' | null, acc = false, useM = f.Rm !== undefined): void {
  const bytes = 1 << es
  const env = c.fpEnv()
  const r = fn(env, FMT[es]!, c.vget(f.Rn!, bytes), useM ? c.vget(f.Rm!, bytes) : 0n, acc ? c.vget(f.Rd!, bytes) : 0n)
  c.fpFlags(env)
  c.vset(f.Rd!, bytes, r, merge === null ? undefined : merge === 'n' ? f.Rn : merge === 'm' ? f.Rm : f.Rd)
}

const mask = (t: Fmt, v: boolean) => (v ? ones(t.n === 16 ? 1 : t.n === 32 ? 2 : 3) : 0n)
type F2 = (e: Env, t: Fmt, a: bigint, b: bigint, d: bigint) => bigint

/* ------------------------------------------------------------------ three same */

interface SameF {
  U: number
  a: number
  op: number
  m: string
  /** v: vector s/d and h; s: scalar s/d and h too. */
  scalar: boolean
  fn: F2
  desc: Text
  acc?: boolean
  pair?: boolean
  /** The result is a mask, not a number (no NEP merge). */
  cmp?: boolean
}
const cmpOp = (kind: 'eq' | 'ge' | 'gt', abs = false): F2 => (e, t, a, b) => mask(t, sf.fpCompareOp(e, t, abs ? sf.fpAbs(e, t, a) : a, abs ? sf.fpAbs(e, t, b) : b, kind))
const SAME: SameF[] = [
  { U: 0, a: 0, op: 0, m: 'fmaxnm', scalar: false, fn: (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, true), desc: T('浮点最大值，忽略单个安静 NaN', 'Floating-point maximum number (a single quiet NaN is ignored)') },
  { U: 0, a: 1, op: 0, m: 'fminnm', scalar: false, fn: (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, false), desc: T('浮点最小值，忽略单个安静 NaN', 'Floating-point minimum number (a single quiet NaN is ignored)') },
  { U: 0, a: 0, op: 1, m: 'fmla', scalar: false, fn: (e, t, a, b, d) => sf.fpMulAdd(e, t, d, a, b), acc: true, desc: T('浮点融合乘加：Vd += Vn × Vm（只舍入一次）', 'Floating-point fused multiply-add: Vd += Vn × Vm (one rounding)') },
  { U: 0, a: 1, op: 1, m: 'fmls', scalar: false, fn: (e, t, a, b, d) => sf.fpMulAdd(e, t, d, sf.fpNeg(e, t, a), b), acc: true, desc: T('浮点融合乘减：Vd −= Vn × Vm（只舍入一次）', 'Floating-point fused multiply-subtract: Vd −= Vn × Vm (one rounding)') },
  { U: 0, a: 0, op: 2, m: 'fadd', scalar: false, fn: (e, t, a, b) => sf.fpAdd(e, t, a, b), desc: T('浮点加', 'Floating-point add') },
  { U: 0, a: 1, op: 2, m: 'fsub', scalar: false, fn: (e, t, a, b) => sf.fpSub(e, t, a, b), desc: T('浮点减', 'Floating-point subtract') },
  { U: 0, a: 0, op: 3, m: 'fmulx', scalar: true, fn: (e, t, a, b) => sf.fpMulX(e, t, a, b), desc: T('浮点扩展乘：和 fmul 相同，只是 0 × ∞ 得 ±2.0', 'Floating-point multiply extended: as fmul, but 0 × ∞ gives ±2.0') },
  { U: 0, a: 0, op: 4, m: 'fcmeq', scalar: true, fn: cmpOp('eq'), cmp: true, desc: T('浮点比较相等：成立时元素全 1', 'Floating-point compare equal: all ones where true') },
  { U: 0, a: 0, op: 6, m: 'fmax', scalar: false, fn: (e, t, a, b) => sf.fpMaxMin(e, t, a, b, true, true), desc: T('浮点最大值（有 NaN 时结果是 NaN）', 'Floating-point maximum (a NaN gives NaN)') },
  { U: 0, a: 1, op: 6, m: 'fmin', scalar: false, fn: (e, t, a, b) => sf.fpMaxMin(e, t, a, b, false, true), desc: T('浮点最小值（有 NaN 时结果是 NaN）', 'Floating-point minimum (a NaN gives NaN)') },
  { U: 0, a: 0, op: 7, m: 'frecps', scalar: true, fn: (e, t, a, b) => sf.fpRecipStep(e, t, a, b), desc: T('倒数迭代步：2 − Vn × Vm（牛顿法求倒数）', 'Reciprocal step: 2 − Vn × Vm (Newton iteration for 1/x)') },
  { U: 0, a: 1, op: 7, m: 'frsqrts', scalar: true, fn: (e, t, a, b) => sf.fpRSqrtStep(e, t, a, b), desc: T('平方根倒数迭代步：(3 − Vn × Vm) / 2', 'Reciprocal square root step: (3 − Vn × Vm) / 2') },
  { U: 1, a: 0, op: 0, m: 'fmaxnmp', scalar: false, fn: (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, true), pair: true, desc: T('相邻元素两两取浮点最大值（忽略单个 NaN）', 'Floating-point maximum number of adjacent pairs') },
  { U: 1, a: 1, op: 0, m: 'fminnmp', scalar: false, fn: (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, false), pair: true, desc: T('相邻元素两两取浮点最小值（忽略单个 NaN）', 'Floating-point minimum number of adjacent pairs') },
  { U: 1, a: 0, op: 2, m: 'faddp', scalar: false, fn: (e, t, a, b) => sf.fpAdd(e, t, a, b), pair: true, desc: T('相邻元素两两浮点相加', 'Floating-point add of adjacent pairs') },
  { U: 1, a: 1, op: 2, m: 'fabd', scalar: true, fn: (e, t, a, b) => sf.fpAbs(e, t, sf.fpSub(e, t, a, b)), desc: T('浮点差的绝对值', 'Floating-point absolute difference') },
  { U: 1, a: 0, op: 3, m: 'fmul', scalar: false, fn: (e, t, a, b) => sf.fpMul(e, t, a, b), desc: T('浮点乘', 'Floating-point multiply') },
  { U: 1, a: 0, op: 4, m: 'fcmge', scalar: true, fn: cmpOp('ge'), cmp: true, desc: T('浮点比较大于等于', 'Floating-point compare greater than or equal') },
  { U: 1, a: 1, op: 4, m: 'fcmgt', scalar: true, fn: cmpOp('gt'), cmp: true, desc: T('浮点比较大于', 'Floating-point compare greater than') },
  { U: 1, a: 0, op: 5, m: 'facge', scalar: true, fn: cmpOp('ge', true), cmp: true, desc: T('比较绝对值大于等于', 'Floating-point absolute compare greater than or equal') },
  { U: 1, a: 1, op: 5, m: 'facgt', scalar: true, fn: cmpOp('gt', true), cmp: true, desc: T('比较绝对值大于', 'Floating-point absolute compare greater than') },
  { U: 1, a: 0, op: 6, m: 'fmaxp', scalar: false, fn: (e, t, a, b) => sf.fpMaxMin(e, t, a, b, true, true), pair: true, desc: T('相邻元素两两取浮点最大值', 'Floating-point maximum of adjacent pairs') },
  { U: 1, a: 1, op: 6, m: 'fminp', scalar: false, fn: (e, t, a, b) => sf.fpMaxMin(e, t, a, b, false, true), pair: true, desc: T('相邻元素两两取浮点最小值', 'Floating-point minimum of adjacent pairs') },
  { U: 1, a: 0, op: 7, m: 'fdiv', scalar: false, fn: (e, t, a, b) => sf.fpDiv(e, t, a, b), desc: T('浮点除', 'Floating-point divide') },
]
const szOk = (f: Fields) => !(f.sz === 1 && f.Q === 0)
for (const op of SAME) {
  const opts = { acc: op.acc, pair: op.pair }
  INSTRS_.push({
    id: `${op.m}-v`,
    mnemonic: op.m,
    group: 'simdfp',
    bits: `0 Q ${op.U} 01110 ${op.a} sz 1 Rm:5 11${bin(op.op, 3)} 1 Rn:5 Rd:5`,
    syntax: '<Vd:sz+2:Q>, <Vn:sz+2:Q>, <Vm:sz+2:Q>',
    valid: szOk,
    desc: op.desc,
    exec: (c, f) => fpVector(c, f, f.sz! + 2, op.fn, opts),
  })
  INSTRS_.push({
    id: `${op.m}-vh`,
    mnemonic: op.m,
    group: 'simdfp',
    feature: 'fp16',
    bits: `0 Q ${op.U} 01110 ${op.a} 10 Rm:5 00 ${bin(op.op, 3)} 1 Rn:5 Rd:5`,
    syntax: '<Vd:h:Q>, <Vn:h:Q>, <Vm:h:Q>',
    desc: op.desc,
    example: `${op.m} v0.8h, v1.8h, v2.8h`,
    exec: (c, f) => fpVector(c, f, 1, op.fn, opts),
  })
  if (!op.scalar) continue
  INSTRS_.push({
    id: `${op.m}-sc`,
    mnemonic: op.m,
    group: 'simdfp',
    bits: `01 ${op.U} 11110 ${op.a} sz 1 Rm:5 11${bin(op.op, 3)} 1 Rn:5 Rd:5`,
    syntax: '<Ed:sz+2>, <En:sz+2>, <Em:sz+2>',
    desc: op.desc,
    example: `${op.m} s0, s1, s2`,
    exec: (c, f) => fpScalar(c, f, f.sz! + 2, op.fn, op.cmp ? 'm' : 'n'),
  })
  INSTRS_.push({
    id: `${op.m}-sch`,
    mnemonic: op.m,
    group: 'simdfp',
    feature: 'fp16',
    bits: `01 ${op.U} 11110 ${op.a} 10 Rm:5 00 ${bin(op.op, 3)} 1 Rn:5 Rd:5`,
    syntax: '<Hd>, <Hn>, <Hm>',
    desc: op.desc,
    exec: (c, f) => fpScalar(c, f, 1, op.fn, op.cmp ? 'm' : 'n'),
  })
}

/* ------------------------------------------------------------------ two-register miscellaneous */

type F1 = (e: Env, t: Fmt, a: bigint) => bigint
interface MiscF {
  U: number
  a: number
  opc: number
  m: string
  /** v: vectors s/d; h: FP16 vectors; s: scalars s/d and h. */
  forms: string
  fn: F1
  desc: Text
  zero?: boolean
  /** Integer or mask result: no NEP merge. */
  int?: boolean
  feature?: string
}
const esz = (t: Fmt) => t.n
const toInt = (unsigned: boolean, rounding: number | null): F1 => (e, t, a) => sf.fpToFixed(e, t, a, 0, unsigned, rounding ?? e.rmode, esz(t))
const fromInt = (unsigned: boolean): F1 => (e, t, a) => sf.fixedToFp(e, t, a, 0, unsigned, esz(t))
const rint = (rounding: number | null, exact = false): F1 => (e, t, a) => sf.fpRoundInt(e, t, a, rounding ?? e.rmode, exact)
const rintN = (rounding: number | null, n: number): F1 => (e, t, a) => sf.fpRoundIntN(e, t, a, rounding ?? e.rmode, n)
const zcmp = (kind: 'eq' | 'ge' | 'gt', swap = false): F1 => (e, t, a) => mask(t, swap ? sf.fpCompareOp(e, t, 0n, a, kind) : sf.fpCompareOp(e, t, a, 0n, kind))
const CVT_DESC = (s: string, how: Text) => T(`浮点转${s === 's' ? '有' : '无'}符号整数（${how.zh}）`, `Floating-point convert to ${s === 's' ? 'signed' : 'unsigned'} integer (${how.en})`)
const RN_ = T('舍入到最近，平局取偶数', 'round to nearest, ties to even')
const RM_ = T('向负无穷舍入', 'round toward minus infinity')
const RA_ = T('舍入到最近，平局远离 0', 'round to nearest, ties away from zero')
const RP_ = T('向正无穷舍入', 'round toward plus infinity')
const RZ_ = T('向 0 舍入', 'round toward zero')
const MISC: MiscF[] = [
  { U: 0, a: 0, opc: 0b11000, m: 'frintn', forms: 'vh', fn: rint(sf.RN), desc: T(`舍入到整数值（${RN_.zh}）`, `Round to an integral value (${RN_.en})`) },
  { U: 0, a: 0, opc: 0b11001, m: 'frintm', forms: 'vh', fn: rint(sf.RM), desc: T(`舍入到整数值（${RM_.zh}）`, `Round to an integral value (${RM_.en})`) },
  { U: 0, a: 0, opc: 0b11010, m: 'fcvtns', forms: 'vhs', fn: toInt(false, sf.RN), int: true, desc: CVT_DESC('s', RN_) },
  { U: 0, a: 0, opc: 0b11011, m: 'fcvtms', forms: 'vhs', fn: toInt(false, sf.RM), int: true, desc: CVT_DESC('s', RM_) },
  { U: 0, a: 0, opc: 0b11100, m: 'fcvtas', forms: 'vhs', fn: toInt(false, sf.RA), int: true, desc: CVT_DESC('s', RA_) },
  { U: 0, a: 0, opc: 0b11101, m: 'scvtf', forms: 'vhs', fn: fromInt(false), desc: T('有符号整数转浮点', 'Signed integer convert to floating point') },
  { U: 0, a: 0, opc: 0b11110, m: 'frint32z', forms: 'v', fn: rintN(sf.RZ, 32), feature: 'frintts', desc: T('向 0 舍入到 32 位整数范围内的整数值（超出范围得最小负数）', 'Round toward zero to an integral value in 32-bit range (out of range gives the most negative)') },
  { U: 0, a: 0, opc: 0b11111, m: 'frint64z', forms: 'v', fn: rintN(sf.RZ, 64), feature: 'frintts', desc: T('向 0 舍入到 64 位整数范围内的整数值', 'Round toward zero to an integral value in 64-bit range') },
  { U: 0, a: 1, opc: 0b01100, m: 'fcmgt', forms: 'vhs', fn: zcmp('gt'), int: true, zero: true, desc: T('浮点比较大于 0', 'Floating-point compare greater than zero') },
  { U: 0, a: 1, opc: 0b01101, m: 'fcmeq', forms: 'vhs', fn: zcmp('eq'), int: true, zero: true, desc: T('浮点比较等于 0', 'Floating-point compare equal to zero') },
  { U: 0, a: 1, opc: 0b01110, m: 'fcmlt', forms: 'vhs', fn: zcmp('gt', true), int: true, zero: true, desc: T('浮点比较小于 0', 'Floating-point compare less than zero') },
  { U: 0, a: 1, opc: 0b01111, m: 'fabs', forms: 'vh', fn: (e, t, a) => sf.fpAbs(e, t, a), desc: T('浮点绝对值', 'Floating-point absolute value') },
  { U: 0, a: 1, opc: 0b11000, m: 'frintp', forms: 'vh', fn: rint(sf.RP), desc: T(`舍入到整数值（${RP_.zh}）`, `Round to an integral value (${RP_.en})`) },
  { U: 0, a: 1, opc: 0b11001, m: 'frintz', forms: 'vh', fn: rint(sf.RZ), desc: T(`舍入到整数值（${RZ_.zh}）`, `Round to an integral value (${RZ_.en})`) },
  { U: 0, a: 1, opc: 0b11010, m: 'fcvtps', forms: 'vhs', fn: toInt(false, sf.RP), int: true, desc: CVT_DESC('s', RP_) },
  { U: 0, a: 1, opc: 0b11011, m: 'fcvtzs', forms: 'vhs', fn: toInt(false, sf.RZ), int: true, desc: CVT_DESC('s', RZ_) },
  { U: 0, a: 1, opc: 0b11101, m: 'frecpe', forms: 'vhs', fn: (e, t, a) => sf.fpRecipEstimate(e, t, a), desc: T('倒数估计值（约 8 位精度）', 'Reciprocal estimate (about 8 bits)') },
  { U: 0, a: 1, opc: 0b11111, m: 'frecpx', forms: 's', fn: (e, t, a) => sf.fpRecpX(e, t, a), desc: T('倒数的指数部分（用于缩放）', 'Reciprocal exponent (for scaling)') },
  { U: 1, a: 0, opc: 0b11000, m: 'frinta', forms: 'vh', fn: rint(sf.RA), desc: T(`舍入到整数值（${RA_.zh}）`, `Round to an integral value (${RA_.en})`) },
  { U: 1, a: 0, opc: 0b11001, m: 'frintx', forms: 'vh', fn: rint(null, true), desc: T('按 FPCR 的方式舍入到整数值，结果不精确时置 IXC', 'Round to an integral value in the FPCR mode, signalling inexact') },
  { U: 1, a: 0, opc: 0b11010, m: 'fcvtnu', forms: 'vhs', fn: toInt(true, sf.RN), int: true, desc: CVT_DESC('u', RN_) },
  { U: 1, a: 0, opc: 0b11011, m: 'fcvtmu', forms: 'vhs', fn: toInt(true, sf.RM), int: true, desc: CVT_DESC('u', RM_) },
  { U: 1, a: 0, opc: 0b11100, m: 'fcvtau', forms: 'vhs', fn: toInt(true, sf.RA), int: true, desc: CVT_DESC('u', RA_) },
  { U: 1, a: 0, opc: 0b11101, m: 'ucvtf', forms: 'vhs', fn: fromInt(true), desc: T('无符号整数转浮点', 'Unsigned integer convert to floating point') },
  { U: 1, a: 0, opc: 0b11110, m: 'frint32x', forms: 'v', fn: rintN(null, 32), feature: 'frintts', desc: T('按 FPCR 的方式舍入到 32 位整数范围内的整数值', 'Round in the FPCR mode to an integral value in 32-bit range') },
  { U: 1, a: 0, opc: 0b11111, m: 'frint64x', forms: 'v', fn: rintN(null, 64), feature: 'frintts', desc: T('按 FPCR 的方式舍入到 64 位整数范围内的整数值', 'Round in the FPCR mode to an integral value in 64-bit range') },
  { U: 1, a: 1, opc: 0b01100, m: 'fcmge', forms: 'vhs', fn: zcmp('ge'), int: true, zero: true, desc: T('浮点比较大于等于 0', 'Floating-point compare greater than or equal to zero') },
  { U: 1, a: 1, opc: 0b01101, m: 'fcmle', forms: 'vhs', fn: zcmp('ge', true), int: true, zero: true, desc: T('浮点比较小于等于 0', 'Floating-point compare less than or equal to zero') },
  { U: 1, a: 1, opc: 0b01111, m: 'fneg', forms: 'vh', fn: (e, t, a) => sf.fpNeg(e, t, a), desc: T('浮点取负', 'Floating-point negate') },
  { U: 1, a: 1, opc: 0b11001, m: 'frinti', forms: 'vh', fn: rint(null), desc: T('按 FPCR 的方式舍入到整数值', 'Round to an integral value in the FPCR mode') },
  { U: 1, a: 1, opc: 0b11010, m: 'fcvtpu', forms: 'vhs', fn: toInt(true, sf.RP), int: true, desc: CVT_DESC('u', RP_) },
  { U: 1, a: 1, opc: 0b11011, m: 'fcvtzu', forms: 'vhs', fn: toInt(true, sf.RZ), int: true, desc: CVT_DESC('u', RZ_) },
  { U: 1, a: 1, opc: 0b11101, m: 'frsqrte', forms: 'vhs', fn: (e, t, a) => sf.fpRSqrtEstimate(e, t, a), desc: T('平方根倒数估计值（约 8 位精度）', 'Reciprocal square root estimate (about 8 bits)') },
  { U: 1, a: 1, opc: 0b11111, m: 'fsqrt', forms: 'vh', fn: (e, t, a) => sf.fpSqrt(e, t, a), desc: T('浮点平方根', 'Floating-point square root') },
]
const un = (fn: F1): F2 => (e, t, a) => fn(e, t, a)
for (const op of MISC) {
  const z = op.zero ? ', #<fzero>' : ''
  const id = `${op.m}${op.zero ? 'z' : ''}`
  if (op.forms.includes('v'))
    INSTRS_.push({
      id: `${id}-v`,
      mnemonic: op.m,
      group: 'simdfp',
      feature: op.feature,
      bits: `0 Q ${op.U} 01110 ${op.a} sz 10000 ${bin(op.opc, 5)} 10 Rn:5 Rd:5`,
      syntax: `<Vd:sz+2:Q>, <Vn:sz+2:Q>${z}`,
      valid: szOk,
      desc: op.desc,
      exec: (c, f) => fpVector(c, f, f.sz! + 2, un(op.fn), { b: false }),
    })
  if (op.forms.includes('h'))
    INSTRS_.push({
      id: `${id}-vh`,
      mnemonic: op.m,
      group: 'simdfp',
      feature: 'fp16',
      bits: `0 Q ${op.U} 01110 ${op.a} 1111 00 ${bin(op.opc, 5)} 10 Rn:5 Rd:5`,
      syntax: `<Vd:h:Q>, <Vn:h:Q>${z}`,
      desc: op.desc,
      example: `${op.m} v0.8h, v1.8h${z ? ', #0.0' : ''}`,
      exec: (c, f) => fpVector(c, f, 1, un(op.fn), { b: false }),
    })
  if (op.forms.includes('s')) {
    INSTRS_.push({
      id: `${id}-sc`,
      mnemonic: op.m,
      group: 'simdfp',
      bits: `01 ${op.U} 11110 ${op.a} sz 10000 ${bin(op.opc, 5)} 10 Rn:5 Rd:5`,
      syntax: `<Ed:sz+2>, <En:sz+2>${z}`,
      desc: op.desc,
      example: `${op.m} s0, s1${z ? ', #0.0' : ''}`,
      exec: (c, f) => fpScalar(c, f, f.sz! + 2, un(op.fn), op.zero ? null : 'd'),
    })
    INSTRS_.push({
      id: `${id}-sch`,
      mnemonic: op.m,
      group: 'simdfp',
      feature: 'fp16',
      bits: `01 ${op.U} 11110 ${op.a} 1111 00 ${bin(op.opc, 5)} 10 Rn:5 Rd:5`,
      syntax: `<Hd>, <Hn>${z}`,
      desc: op.desc,
      exec: (c, f) => fpScalar(c, f, 1, un(op.fn), op.zero ? null : 'd'),
    })
  }
}

/* URECPE, URSQRTE: estimates on unsigned 32-bit fixed-point values with the binary point at the top. */
for (const [U, m, desc] of [
  [0, 'urecpe', T('无符号定点数的倒数估计值', 'Unsigned reciprocal estimate (fixed point)')],
  [1, 'ursqrte', T('无符号定点数的平方根倒数估计值', 'Unsigned reciprocal square root estimate (fixed point)')],
] as const)
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simdfp',
    bits: `0 Q ${U} 01110 1 0 10000 11100 10 Rn:5 Rd:5`,
    syntax: '<Vd:s:Q>, <Vn:s:Q>',
    desc,
    exec: (c, f) =>
      writeV(
        c,
        f.Rd!,
        readV(c, f.Rn!, 2, f.Q ? 16 : 8).map((v) => {
          if (U ? v >> 30n === 0n : v >> 31n === 0n) return 0xffffffffn
          const est = U ? sf.recipSqrtEstimate(Number(v >> 23n), false) : sf.recipEstimate(Number(v >> 23n), false)
          return BigInt(est & 0x1ff) << 23n
        }),
        2,
      ),
  })

/* ------------------------------------------------------------------ precision changes */

/** Narrow: each wide element converted, into the lower (or with "2", upper) half of Vd. */
function narrowFp(c: Cpu, f: Fields, es: number, upper: boolean, fn: (e: Env, a: bigint) => bigint): void {
  const env = c.fpEnv()
  const R = readV(c, f.Rn!, es + 1, 16).map((a) => fn(env, a))
  c.fpFlags(env)
  if (!upper) return writeV(c, f.Rd!, R, es)
  const old = readV(c, f.Rd!, es, 16)
  writeV(c, f.Rd!, [...old.slice(0, R.length), ...R], es)
}
for (const [sz, n, w] of [
  [0, 'h', 's'],
  [1, 's', 'd'],
] as const) {
  const es = 'bhsd'.indexOf(n)
  for (const Q of [0, 1]) {
    const two = Q ? '2' : ''
    INSTRS_.push({
      id: `fcvtn${two}-${n}`,
      mnemonic: `fcvtn${two}`,
      group: 'simdfp',
      bits: `0 ${Q} 0 01110 0 ${sz} 10000 10110 10 Rn:5 Rd:5`,
      syntax: `<Vd:${n}:${Q}>, <Vn:${w}:1>`,
      desc: T(`把每个元素转成低一级的精度，写进 Vd 的${Q ? '高' : '低'}半部分`, `Convert each element to the lower precision, into the ${Q ? 'upper' : 'lower'} half of Vd`),
      exec: (c, f) => narrowFp(c, f, es, Q === 1, (e, a) => sf.fpConvert(e, FMT[es + 1]!, FMT[es]!, a)),
    })
    INSTRS_.push({
      id: `fcvtl${two}-${w}`,
      mnemonic: `fcvtl${two}`,
      group: 'simdfp',
      bits: `0 ${Q} 0 01110 0 ${sz} 10000 10111 10 Rn:5 Rd:5`,
      syntax: `<Vd:${w}:1>, <Vn:${n}:${Q}>`,
      desc: T(`把 Vn ${Q ? '高' : '低'}半部分的每个元素转成高一级的精度`, `Convert each element of the ${Q ? 'upper' : 'lower'} half of Vn to the higher precision`),
      exec: (c, f) => {
        const env = c.fpEnv()
        const A = readV(c, f.Rn!, es, 16)
        const R = (Q ? A.slice(A.length / 2) : A.slice(0, A.length / 2)).map((a) => sf.fpConvert(env, FMT[es]!, FMT[es + 1]!, a))
        c.fpFlags(env)
        writeV(c, f.Rd!, R, es + 1)
      },
    })
  }
}
for (const Q of [0, 1]) {
  const two = Q ? '2' : ''
  INSTRS_.push({
    id: `fcvtxn${two}-v`,
    mnemonic: `fcvtxn${two}`,
    group: 'simdfp',
    bits: `0 ${Q} 1 01110 0 1 10000 10110 10 Rn:5 Rd:5`,
    syntax: `<Vd:s:${Q}>, <Vn:d:1>`,
    desc: T(`双精度转单精度，向奇数舍入（再舍入一次也不会有双重舍入误差），写进 Vd 的${Q ? '高' : '低'}半部分`, `Convert double to single precision, rounding to odd (safe to round again later), into the ${Q ? 'upper' : 'lower'} half of Vd`),
    exec: (c, f) => narrowFp(c, f, 2, Q === 1, (e, a) => sf.fpConvert(e, sf.F64, sf.F32, a, sf.RO)),
  })
  INSTRS_.push({
    id: `bfcvtn${two}`,
    mnemonic: `bfcvtn${two}`,
    group: 'simdfp',
    feature: 'bf16',
    bits: `0 ${Q} 0 01110 1 0 10000 10110 10 Rn:5 Rd:5`,
    syntax: `<Vd:h:${Q}>, <Vn:s:1>`,
    desc: T(`单精度转 BFloat16，写进 Vd 的${Q ? '高' : '低'}半部分`, `Convert single precision to BFloat16, into the ${Q ? 'upper' : 'lower'} half of Vd`),
    exec: (c, f) => narrowFp(c, f, 1, Q === 1, (e, a) => sf.fpConvertBF(e, a)),
  })
}
INSTRS_.push({
  id: 'fcvtxn-sc',
  mnemonic: 'fcvtxn',
  group: 'simdfp',
  bits: '01 1 11110 0 1 10000 10110 10 Rn:5 Rd:5',
  syntax: '<Sd>, <Dn>',
  desc: T('双精度转单精度，向奇数舍入', 'Convert double to single precision, rounding to odd'),
  exec: (c, f) => {
    const env = c.fpEnv()
    const r = sf.fpConvert(env, sf.F64, sf.F32, c.vget(f.Rn!, 8), sf.RO)
    c.fpFlags(env)
    c.vset(f.Rd!, 4, r, f.Rd)
  },
})

/* ------------------------------------------------------------------ across lanes and pairwise */

/** Arm's Reduce: op(reduce(lower half), reduce(upper half)), recursively. */
function reduce(vals: bigint[], op: (a: bigint, b: bigint) => bigint): bigint {
  if (vals.length === 1) return vals[0]!
  const h = vals.length >> 1
  return op(reduce(vals.slice(0, h), op), reduce(vals.slice(h), op))
}
const RED: [number, number, string, Text, F2][] = [
  [0, 0b01100, 'fmaxnmv', T('所有元素的浮点最大值（忽略单个 NaN）', 'Floating-point maximum number of all elements'), (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, true)],
  [0, 0b01111, 'fmaxv', T('所有元素的浮点最大值', 'Floating-point maximum of all elements'), (e, t, a, b) => sf.fpMaxMin(e, t, a, b, true, true)],
  [1, 0b01100, 'fminnmv', T('所有元素的浮点最小值（忽略单个 NaN）', 'Floating-point minimum number of all elements'), (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, false)],
  [1, 0b01111, 'fminv', T('所有元素的浮点最小值', 'Floating-point minimum of all elements'), (e, t, a, b) => sf.fpMaxMin(e, t, a, b, false, true)],
]
for (const [a, opc, m, desc, fn] of RED)
  for (const [U, sz, Q, d, v, es] of [
    [1, 0, '1', 'Sd', 'Vn:s:1', 2],
    [0, 0, 'Q', 'Hd', 'Vn:h:Q', 1],
  ] as const)
    INSTRS_.push({
      id: `${m}-${d[0]!.toLowerCase()}`,
      mnemonic: m,
      group: 'simdfp',
      feature: es === 1 ? 'fp16' : undefined,
      bits: `0 ${Q} ${U} 01110 ${a} ${sz} 11000 ${bin(opc, 5)} 10 Rn:5 Rd:5`,
      syntax: `<${d}>, <${v}>`,
      desc,
      exec: (c, f) => {
        const env = c.fpEnv()
        const r = reduce(readV(c, f.Rn!, es, es === 2 || f.Q ? 16 : 8), (x, y) => fn(env, FMT[es]!, x, y, 0n))
        c.fpFlags(env)
        c.vset(f.Rd!, 1 << es, r)
      },
    })

const PAIR: [number, number, string, Text, F2][] = [
  [0, 0b01100, 'fmaxnmp', T('两个元素的浮点最大值（忽略单个 NaN）', 'Floating-point maximum number of the two elements'), (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, true)],
  [0, 0b01101, 'faddp', T('两个元素浮点相加', 'Floating-point add of the two elements'), (e, t, a, b) => sf.fpAdd(e, t, a, b)],
  [0, 0b01111, 'fmaxp', T('两个元素的浮点最大值', 'Floating-point maximum of the two elements'), (e, t, a, b) => sf.fpMaxMin(e, t, a, b, true, true)],
  [1, 0b01100, 'fminnmp', T('两个元素的浮点最小值（忽略单个 NaN）', 'Floating-point minimum number of the two elements'), (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, false)],
  [1, 0b01111, 'fminp', T('两个元素的浮点最小值', 'Floating-point minimum of the two elements'), (e, t, a, b) => sf.fpMaxMin(e, t, a, b, false, true)],
]
for (const [a, opc, m, desc, fn] of PAIR)
  for (const [U, sz, d, v, es] of [
    [1, '0', 'Sd', 'Vn:s:0', 2],
    [1, '1', 'Dd', 'Vn:d:1', 3],
    [0, '0', 'Hd', 'Vn:h:h', 1],
  ] as const)
    INSTRS_.push({
      id: `${m}-s${d[0]!.toLowerCase()}`,
      mnemonic: m,
      group: 'simdfp',
      feature: es === 1 ? 'fp16' : undefined,
      bits: `01 ${U} 11110 ${a} ${sz} 11000 ${bin(opc, 5)} 10 Rn:5 Rd:5`,
      syntax: `<${d}>, <${v}>`,
      desc,
      exec: (c, f) => {
        const env = c.fpEnv()
        const [x, y] = readV(c, f.Rn!, es, 16)
        const r = fn(env, FMT[es]!, x!, y!, 0n)
        c.fpFlags(env)
        c.vset(f.Rd!, 1 << es, r)
      },
    })

/* ------------------------------------------------------------------ by element */

const BY: [number, number, string, Text, F2][] = [
  [0, 0b0001, 'fmla', T('浮点融合乘以元素后加到 Vd', 'Floating-point fused multiply-add by element'), (e, t, a, b, d) => sf.fpMulAdd(e, t, d, a, b)],
  [0, 0b0101, 'fmls', T('浮点融合乘以元素后从 Vd 减去', 'Floating-point fused multiply-subtract by element'), (e, t, a, b, d) => sf.fpMulAdd(e, t, d, sf.fpNeg(e, t, a), b)],
  [0, 0b1001, 'fmul', T('浮点乘以 Vm 的一个元素', 'Floating-point multiply by an element'), (e, t, a, b) => sf.fpMul(e, t, a, b)],
  [1, 0b1001, 'fmulx', T('浮点扩展乘以元素（0 × ∞ 得 ±2.0）', 'Floating-point multiply extended by element (0 × ∞ gives ±2.0)'), (e, t, a, b) => sf.fpMulX(e, t, a, b)],
]
for (const [U, opc, m, desc, fn] of BY) {
  const acc = opc !== 0b1001
  const byVec = (es: number) => (c: Cpu, f: Fields) => {
    const b = indexedElem(c, f, es)
    fpVector(c, f, es, (e, t, a, _b, d) => fn(e, t, a, b, d), { b: false, acc })
  }
  const byScalar = (es: number) => (c: Cpu, f: Fields) => {
    const b = indexedElem(c, f, es)
    fpScalar(c, f, es, (e, t, a, _b, d) => fn(e, t, a, b, d), acc ? 'd' : 'n', acc, false)
  }
  INSTRS_.push({
    id: `${m}-ve`,
    mnemonic: m,
    group: 'simdfp',
    bits: `0 Q ${U} 01111 1 sz L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
    syntax: '<Vd:sz+2:Q>, <Vn:sz+2:Q>, <E@fmul>',
    valid: (f) => szOk(f) && !(f.sz === 1 && f.L === 1),
    desc,
    exec: (c, f) => byVec(f.sz! + 2)(c, f),
  })
  INSTRS_.push({
    id: `${m}-veh`,
    mnemonic: m,
    group: 'simdfp',
    feature: 'fp16',
    bits: `0 Q ${U} 01111 00 L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
    syntax: '<Vd:h:Q>, <Vn:h:Q>, <E@fmulh>',
    desc,
    example: `${m} v0.8h, v1.8h, v2.h[7]`,
    exec: byVec(1),
  })
  INSTRS_.push({
    id: `${m}-se`,
    mnemonic: m,
    group: 'simdfp',
    bits: `01 ${U} 11111 1 sz L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
    syntax: '<Ed:sz+2>, <En:sz+2>, <E@fmul>',
    valid: (f) => !(f.sz === 1 && f.L === 1),
    desc,
    example: `${m} s0, s1, v2.s[3]`,
    exec: (c, f) => byScalar(f.sz! + 2)(c, f),
  })
  INSTRS_.push({
    id: `${m}-seh`,
    mnemonic: m,
    group: 'simdfp',
    feature: 'fp16',
    bits: `01 ${U} 11111 00 L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
    syntax: '<Hd>, <Hn>, <E@fmulh>',
    desc,
    exec: byScalar(1),
  })
}

/* ------------------------------------------------------------------ fixed-point conversions */

const SH_BITS = ['', '001 sh:4', '01 sh:5', '1 sh:6']
for (const [U, opc, m, desc] of [
  [0, 0b11100, 'scvtf', T('有符号定点数转浮点：#fbits 是小数位数', 'Signed fixed-point convert to floating point: #fbits fraction bits')],
  [1, 0b11100, 'ucvtf', T('无符号定点数转浮点：#fbits 是小数位数', 'Unsigned fixed-point convert to floating point: #fbits fraction bits')],
  [0, 0b11111, 'fcvtzs', T('浮点转有符号定点数（向 0 舍入）：#fbits 是小数位数', 'Floating-point convert to signed fixed point (toward zero): #fbits fraction bits')],
  [1, 0b11111, 'fcvtzu', T('浮点转无符号定点数（向 0 舍入）：#fbits 是小数位数', 'Floating-point convert to unsigned fixed point (toward zero): #fbits fraction bits')],
] as const)
  for (const L of 'hsd') {
    const es = 'bhsd'.indexOf(L)
    const bits = ESIZE[es]!
    const q = es === 3 ? '1' : 'Q'
    const at = (fb: number): F1 => (opc === 0b11100 ? (e, t, a) => sf.fixedToFp(e, t, a, fb, U === 1, bits) : (e, t, a) => sf.fpToFixed(e, t, a, fb, U === 1, sf.RZ, bits))
    INSTRS_.push({
      id: `${m}-fx-v${L}`,
      mnemonic: m,
      group: 'simdfp',
      feature: es === 1 ? 'fp16' : undefined,
      bits: `0 ${q} ${U} 011110 ${SH_BITS[es]} ${bin(opc, 5)} 1 Rn:5 Rd:5`,
      syntax: `<Vd:${L}:${q}>, <Vn:${L}:${q}>, #<rsh:${bits}>`,
      desc,
      exec: (c, f) => fpVector(c, f, es, un(at(bits - f.sh!)), { b: false }),
    })
    INSTRS_.push({
      id: `${m}-fx-s${L}`,
      mnemonic: m,
      group: 'simdfp',
      feature: es === 1 ? 'fp16' : undefined,
      bits: `01 ${U} 111110 ${SH_BITS[es]} ${bin(opc, 5)} 1 Rn:5 Rd:5`,
      syntax: `<${L.toUpperCase()}d>, <${L.toUpperCase()}n>, #<rsh:${bits}>`,
      desc,
      exec: (c, f) => fpScalar(c, f, es, un(at(bits - f.sh!)), 'd'),
    })
  }

/* ------------------------------------------------------------------ FMLAL, FMLSL (FEAT_FHM) */

/** A half-precision value as single precision, exactly (FZ16 flushes denormals; NaNs keep signalling). */
function widenHalf(e: Env, h: bigint): bigint {
  const s = (h >> 15n) & 1n
  const exp = (h >> 10n) & 31n
  const frac = h & 0x3ffn
  if (exp === 31n) return (s << 31n) | (0xffn << 23n) | (frac << 13n)
  if (exp === 0n && (frac === 0n || e.fpcr & sf.FZ16)) return s << 31n
  return sf.fromNumber(sf.F32, sf.toNumber(sf.F16, h))
}

/** Vd.s[i] += Vn.h[i + base] × Vm.h[i + base] (or by one element), fused in single precision. */
function fmlal(c: Cpu, f: Fields, sub: boolean, upper: boolean, m: ((i: number) => bigint) | null): void {
  const n = f.Q ? 4 : 2
  const base = upper ? n : 0
  const env = c.fpEnv()
  const N = readV(c, f.Rn!, 1, 16)
  const M = m ? null : readV(c, f.Rm!, 1, 16)
  const D = readV(c, f.Rd!, 2, 16)
  const R = Array.from({ length: n }, (_, i) => {
    let a = widenHalf(env, N[base + i]!)
    if (sub) a = sf.fpNeg(env, sf.F32, a)
    const b = widenHalf(env, m ? m(i) : M![base + i]!)
    return sf.fpMulAdd(env, sf.F32, D[i]!, a, b)
  })
  c.fpFlags(env)
  writeV(c, f.Rd!, R, 2)
}
for (const [m, U, a, opc, eopc] of [
  ['fmlal', 0, 0, 0b11101, 0b0000],
  ['fmlsl', 0, 1, 0b11101, 0b0100],
  ['fmlal2', 1, 0, 0b11001, 0b1000],
  ['fmlsl2', 1, 1, 0b11001, 0b1100],
] as const) {
  const sub = a === 1
  const upper = U === 1
  const what = T(`半精度乘积加宽到单精度后${sub ? '从 Vd 减去' : '加到 Vd'}（融合）；用 Vn、Vm 的${upper ? '高' : '低'}半部分`, `Widening half-precision fused multiply-${sub ? 'subtract from' : 'add to'} single precision, from the ${upper ? 'upper' : 'lower'} halves of Vn and Vm`)
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simdfp',
    feature: 'fhm',
    bits: `0 Q ${U} 01110 ${a} 0 1 Rm:5 ${bin(opc, 5)} 1 Rn:5 Rd:5`,
    syntax: '<Vd:s:Q>, <Vn:h:Qh>, <Vm:h:Qh>',
    desc: what,
    exec: (c, f) => fmlal(c, f, sub, upper, null),
  })
  INSTRS_.push({
    id: `${m}-ve`,
    mnemonic: m,
    group: 'simdfp',
    feature: 'fhm',
    bits: `0 Q ${U} 01111 1 0 L M Rm:4 ${bin(eopc, 4)} H 0 Rn:5 Rd:5`,
    syntax: '<Vd:s:Q>, <Vn:h:Qh>, <E@fhm>',
    desc: T(`${what.zh}；乘以 Vm 的一个元素`, `${what.en}; by an element of Vm`),
    exec: (c, f) => {
      const b = indexedElem(c, f, 1)
      fmlal(c, f, sub, upper, () => b)
    },
  })
}

/* ------------------------------------------------------------------ complex numbers (FEAT_FCMA) */

/** FCMLA on pairs (real, imaginary): one rotation of the complex product added to Vd. */
function fcmla(c: Cpu, f: Fields, es: number, rot: number, mPair: ((e: number) => [bigint, bigint]) | null): void {
  const bytes = f.Q ? 16 : 8
  const t = FMT[es]!
  const env = c.fpEnv()
  const N = readV(c, f.Rn!, es, bytes)
  const M = readV(c, f.Rm!, es, 16)
  const D = readV(c, f.Rd!, es, bytes)
  const R = [...D]
  const neg = (x: bigint) => sf.fpNeg(env, t, x)
  for (let e = 0; e < N.length / 2; e++) {
    const [mr, mi] = mPair ? mPair(e) : [M[2 * e]!, M[2 * e + 1]!]
    const nr = N[2 * e]!
    const ni = N[2 * e + 1]!
    let e1: bigint, e2: bigint, e3: bigint, e4: bigint
    if (rot === 0) [e1, e2, e3, e4] = [mr, nr, mi, nr]
    else if (rot === 1) [e1, e2, e3, e4] = [neg(mi), ni, mr, ni]
    else if (rot === 2) [e1, e2, e3, e4] = [neg(mr), nr, neg(mi), nr]
    else [e1, e2, e3, e4] = [mi, ni, neg(mr), ni]
    R[2 * e] = sf.fpMulAdd(env, t, D[2 * e]!, e2, e1)
    R[2 * e + 1] = sf.fpMulAdd(env, t, D[2 * e + 1]!, e4, e3)
  }
  c.fpFlags(env)
  writeV(c, f.Rd!, R, es)
}
const FCMLA_DESC = T('复数乘加：每对元素是（实部，虚部），把 Vn × Vm 旋转 #rot 度后的一部分加到 Vd；#0 和 #90 两条合起来是完整的复数乘加', 'Complex multiply-add: element pairs are (real, imaginary); adds one part of Vn × Vm rotated by #rot to Vd; #0 then #90 make a full complex multiply-add')
INSTRS_.push({
  id: 'fcmla-v',
  mnemonic: 'fcmla',
  group: 'simdfp',
  feature: 'fcma',
  bits: '0 Q 1 01110 size:2 0 Rm:5 1 10 rot:2 1 Rn:5 Rd:5',
  syntax: '<Vd:size:Q>, <Vn:size:Q>, <Vm:size:Q>, #<rot:rot>',
  valid: (f) => f.size !== 0 && !(f.size === 3 && f.Q === 0),
  desc: FCMLA_DESC,
  example: 'fcmla v0.4s, v1.4s, v2.4s, #90',
  exec: (c, f) => fcmla(c, f, f.size!, f.rot!, null),
})
INSTRS_.push({
  id: 'fcmla-ve',
  mnemonic: 'fcmla',
  group: 'simdfp',
  feature: 'fcma',
  bits: '0 Q 1 01111 size:2 L M Rm:4 0 rot:2 1 H 0 Rn:5 Rd:5',
  syntax: '<Vd:size:Q>, <Vn:size:Q>, <E@fcmla>, #<rot:rot>',
  valid: (f) => (f.size === 1 && !(f.Q === 0 && f.H === 1)) || (f.size === 2 && f.Q === 1 && f.L === 0),
  desc: T(`${FCMLA_DESC.zh}；Vm 用下标选出的一对`, `${FCMLA_DESC.en}; Vm is the indexed pair`),
  example: 'fcmla v0.4s, v1.4s, v2.s[1], #90',
  exec: (c, f) => {
    const es = f.size!
    const reg = (f.M! << 4) | f.Rm!
    const idx = es === 1 ? (f.H! << 1) | f.L! : f.H!
    const M = readV(c, reg, es, 16)
    fcmla(c, f, es, f.rot!, () => [M[2 * idx]!, M[2 * idx + 1]!])
  },
})
INSTRS_.push({
  id: 'fcadd-v',
  mnemonic: 'fcadd',
  group: 'simdfp',
  feature: 'fcma',
  bits: '0 Q 1 01110 size:2 0 Rm:5 1 11 rot 0 1 Rn:5 Rd:5',
  syntax: '<Vd:size:Q>, <Vn:size:Q>, <Vm:size:Q>, #<crot:rot>',
  valid: (f) => f.size !== 0 && !(f.size === 3 && f.Q === 0),
  desc: T('复数加：Vn 加上旋转 90° 或 270° 的 Vm（每对元素是实部、虚部）', 'Complex add: Vn plus Vm rotated by 90° or 270° (element pairs are real, imaginary)'),
  example: 'fcadd v0.4s, v1.4s, v2.4s, #90',
  exec: (c, f) => {
    const es = f.size!
    const t = FMT[es]!
    const bytes = f.Q ? 16 : 8
    const env = c.fpEnv()
    const N = readV(c, f.Rn!, es, bytes)
    const M = readV(c, f.Rm!, es, bytes)
    const R = N.map((n, i) => {
      const e = i >> 1
      const other = i & 1 ? M[2 * e]! : M[2 * e + 1]!
      // rot 0 (90°): re − m.im, im + m.re; rot 1 (270°): re + m.im, im − m.re.
      const negate = (i & 1) === f.rot
      return sf.fpAdd(env, t, n, negate ? sf.fpNeg(env, t, other) : other)
    })
    c.fpFlags(env)
    writeV(c, f.Rd!, R, es)
  },
})

/* ------------------------------------------------------------------ BFloat16 (FEAT_BF16) */

/** BFloat16 to single precision: the bits shifted up. */
const bf = (h: bigint) => h << 16n
/**
 * The BFloat16 dot product step with FPCR.EBF = 0: addend + (a1 × b1 + a2 × b2), unfused, whatever the
 * FPCR says: BFRound (to odd, overflow to infinity), denormals flushed, default NaN, no exception flags.
 */
function bfDotAdd(addend: bigint, a1: bigint, a2: bigint, b1: bigint, b2: bigint): bigint {
  const env = new sf.FpEnv(sf.DN | sf.FZ | sf.FIZ)
  env.mode = sf.RBF
  const p1 = sf.fpMul(env, sf.F32, bf(a1), bf(b1), false)
  const p2 = sf.fpMul(env, sf.F32, bf(a2), bf(b2), false)
  return sf.fpAdd(env, sf.F32, addend, sf.fpAdd(env, sf.F32, p1, p2, false, false), false, false)
}
function bfdot(c: Cpu, f: Fields, m: ((i: number) => [bigint, bigint]) | null): void {
  const bytes = f.Q ? 16 : 8
  const N = readV(c, f.Rn!, 1, bytes)
  const M = readV(c, f.Rm!, 1, bytes)
  const D = readV(c, f.Rd!, 2, bytes)
  writeV(
    c,
    f.Rd!,
    D.map((d, i) => {
      const [m1, m2] = m ? m(i) : [M[2 * i]!, M[2 * i + 1]!]
      return bfDotAdd(d, N[2 * i]!, N[2 * i + 1]!, m1, m2)
    }),
    2,
  )
}
const BFDOT_DESC = T('BFloat16 点积：每两个 BF16 相乘求和，加到 Vd 的单精度元素（向奇数舍入，非规格化数当 0，不置标志）', 'BFloat16 dot product: pairs of BF16 multiplied and summed into a single-precision element of Vd (round to odd, denormals as zero, no flags)')
INSTRS_.push({
  id: 'bfdot-v',
  mnemonic: 'bfdot',
  group: 'simdfp',
  feature: 'bf16',
  bits: '0 Q 1 01110 01 0 Rm:5 1 1111 1 Rn:5 Rd:5',
  syntax: '<Vd:s:Q>, <Vn:h:Q>, <Vm:h:Q>',
  desc: BFDOT_DESC,
  exec: (c, f) => bfdot(c, f, null),
})
INSTRS_.push({
  id: 'bfdot-ve',
  mnemonic: 'bfdot',
  group: 'simdfp',
  feature: 'bf16',
  bits: '0 Q 0 01111 01 L M Rm:4 1111 H 0 Rn:5 Rd:5',
  syntax: '<Vd:s:Q>, <Vn:h:Q>, <E@dot2h>',
  desc: T(`${BFDOT_DESC.zh}；Vm 用下标选出的一对`, `${BFDOT_DESC.en}; Vm is the indexed pair`),
  exec: (c, f) => {
    const M = readV(c, (f.M! << 4) | f.Rm!, 1, 16)
    const i = (f.H! << 1) | f.L!
    bfdot(c, f, () => [M[2 * i]!, M[2 * i + 1]!])
  },
})
for (const [Q, m] of [
  [0, 'bfmlalb'],
  [1, 'bfmlalt'],
] as const) {
  const desc = T(`把 Vn、Vm 的${Q ? '奇数号（高位）' : '偶数号（低位）'} BF16 元素相乘，融合加到 Vd 的单精度元素`, `Multiply the ${Q ? 'odd (top)' : 'even (bottom)'} BF16 elements of Vn and Vm and add them, fused, to the single-precision elements of Vd`)
  const run = (c: Cpu, f: Fields, m: ((i: number) => bigint) | null) => {
    const env = c.fpEnv()
    const N = readV(c, f.Rn!, 1, 16)
    const M = m ? null : readV(c, f.Rm!, 1, 16)
    // BFMulAdd: a plain fused multiply-add, except that with FPCR.AH it flushes denormals, rounds to nearest and raises no flags.
    const alt = env.altfp ? env.with(sf.FIZ | sf.FZ, 3 << 22) : env
    const R = readV(c, f.Rd!, 2, 16).map((d, i) => sf.fpMulAdd(alt, sf.F32, d, bf(N[2 * i + Q]!), bf(m ? m(i) : M![2 * i + Q]!), !env.altfp))
    c.fpFlags(env)
    writeV(c, f.Rd!, R, 2)
  }
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simdfp',
    feature: 'bf16',
    bits: `0 ${Q} 1 01110 11 0 Rm:5 1 1111 1 Rn:5 Rd:5`,
    syntax: '<Vd:s:1>, <Vn:h:1>, <Vm:h:1>',
    desc,
    exec: (c, f) => run(c, f, null),
  })
  INSTRS_.push({
    id: `${m}-ve`,
    mnemonic: m,
    group: 'simdfp',
    feature: 'bf16',
    bits: `0 ${Q} 0 01111 11 L M Rm:4 1111 H 0 Rn:5 Rd:5`,
    syntax: '<Vd:s:1>, <Vn:h:1>, <E@fmulh>',
    desc: T(`${desc.zh}；乘以 Vm 的一个元素`, `${desc.en}; by an element of Vm`),
    exec: (c, f) => {
      const b = indexedElem(c, f, 1)
      run(c, f, () => b)
    },
  })
}
INSTRS_.push({
  id: 'bfmmla',
  mnemonic: 'bfmmla',
  group: 'simdfp',
  feature: 'bf16',
  bits: '0 1 1 01110 01 0 Rm:5 1 1101 1 Rn:5 Rd:5',
  syntax: '<Vd:s:1>, <Vn:h:1>, <Vm:h:1>',
  desc: T('BFloat16 矩阵乘加：Vd（2×2 单精度）+= Vn（2×4）× Vm（2×4）的转置', 'BFloat16 matrix multiply-accumulate: Vd (2×2 single) += Vn (2×4) × transpose of Vm (2×4)'),
  exec: (c, f) => {
    const N = readV(c, f.Rn!, 1, 16)
    const M = readV(c, f.Rm!, 1, 16)
    const R = readV(c, f.Rd!, 2, 16).map((d, k) => {
      const i = k >> 1
      const j = k & 1
      const s = bfDotAdd(d, N[4 * i]!, N[4 * i + 1]!, M[4 * j]!, M[4 * j + 1]!)
      return bfDotAdd(s, N[4 * i + 2]!, N[4 * i + 3]!, M[4 * j + 2]!, M[4 * j + 3]!)
    })
    writeV(c, f.Rd!, R, 2)
  },
})

export const INSTRS = INSTRS_
export const ALIASES = ALIASES_
