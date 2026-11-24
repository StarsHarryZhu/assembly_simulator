/**
 * SVE floating point: predicated and unpredicated arithmetic (with the B16B16 BFloat16 forms in the size 00
 * slots), immediates, multiply-add (vectors and indexed), complex arithmetic, reductions (tree, ordered and
 * per 128-bit segment), compares, rounding, conversions, estimates, FMOV of immediates, the trigonometric
 * helpers (FTMAD, FTSMUL, FTSSEL, FEXPA), and the SVE2 / SVE2.1 additions: pairwise operations, widening
 * multiply-add (FMLALB…), FLOGB, FCVTNT/FCVTLT, the 2-way FDOT, FCLAMP, matrix multiply (FMMLA, BFMMLA) and
 * the BFloat16 dot products.
 */
import { L, T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import * as sf from '../softfloat'
import { bf, bfDotAdd, widenHalf } from './simd-fp'
import { fpImmBits } from './simd-more'
import { sizes } from './sve-int'
import type { Cpu, Fields } from './types'
import { ESIZE, sx, ux } from './vec'
import { allTrue, pget, predicated, pset, zget, zset } from './zvec'

export const INSTRS: InstrSpec[] = []
export const ALIASES: AliasSpec[] = []
const G = 'svefp'
type Env = sf.FpEnv
type Fmt = sf.Fmt
type F2 = (e: Env, t: Fmt, a: bigint, b: bigint) => bigint
type F1 = (e: Env, t: Fmt, a: bigint) => bigint
/** Formats by element size; size 00 holds the B16B16 BFloat16 forms. */
const FMT: Fmt[] = [sf.BF16, sf.F16, sf.F32, sf.F64]
/** The element size in the register of format index k: BFloat16 elements are halfwords. */
const storage = (k: number) => Math.max(k, 1)
const HSD = sizes('hsd')
const fmtName = (es: number) => ['BF16', '半精度', '单精度', '双精度'][es]!

/** Elements per 128-bit segment. */
const perSeg = (es: number) => 128 / ESIZE[es]!
/** For element i, element `idx` of the same 128-bit segment of M. */
const segElem = (M: bigint[], es: number, i: number, idx: number) => M[i - (i % perSeg(es)) + idx]!

/** Zd's active elements = fn(i) under Pg, merging; FP flags raised once. */
function fpPred(c: Cpu, f: Fields, d: number, es: number, fn: (e: Env, i: number) => bigint, pg = pget(c, f.Pg!, es)): void {
  const env = c.fpEnv()
  predicated(c, d, es, pg, true, (i) => fn(env, i))
  c.fpFlags(env)
}

/* ------------------------------------------------------------------ predicated binary */

const negOf = (e: Env, t: Fmt, a: bigint) => sf.fpNeg(e, t, a)
interface BinOp {
  m: string
  opc: number
  /** The BFloat16 mnemonic of the size 00 slot, if any. */
  bfm?: string
  fn: F2
  desc: Text
}
const BIN: BinOp[] = [
  { m: 'fadd', opc: 0, bfm: 'bfadd', fn: (e, t, a, b) => sf.fpAdd(e, t, a, b), desc: T('加', 'Add') },
  { m: 'fsub', opc: 1, bfm: 'bfsub', fn: (e, t, a, b) => sf.fpSub(e, t, a, b), desc: T('减', 'Subtract') },
  { m: 'fmul', opc: 2, bfm: 'bfmul', fn: (e, t, a, b) => sf.fpMul(e, t, a, b), desc: T('乘', 'Multiply') },
  { m: 'fsubr', opc: 3, fn: (e, t, a, b) => sf.fpSub(e, t, b, a), desc: T('反向减（第二个减第一个）', 'Reversed subtract (the second minus the first)') },
  { m: 'fmaxnm', opc: 4, bfm: 'bfmaxnm', fn: (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, true), desc: T('最大值（一个是 NaN 时取另一个数）', 'Maximum number (a quiet NaN loses to a number)') },
  { m: 'fminnm', opc: 5, bfm: 'bfminnm', fn: (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, false), desc: T('最小值（一个是 NaN 时取另一个数）', 'Minimum number (a quiet NaN loses to a number)') },
  { m: 'fmax', opc: 6, bfm: 'bfmax', fn: (e, t, a, b) => sf.fpMaxMin(e, t, a, b, true, true), desc: T('最大值（有 NaN 时结果是 NaN）', 'Maximum (a NaN gives NaN)') },
  { m: 'fmin', opc: 7, bfm: 'bfmin', fn: (e, t, a, b) => sf.fpMaxMin(e, t, a, b, false, true), desc: T('最小值（有 NaN 时结果是 NaN）', 'Minimum (a NaN gives NaN)') },
  { m: 'fabd', opc: 8, fn: (e, t, a, b) => sf.fpAbs(e, t, sf.fpSub(e, t, a, b)), desc: T('差的绝对值', 'Absolute difference') },
  { m: 'fscale', opc: 9, fn: (e, t, a, b) => sf.fpScale(e, t, a, Number(sx(b, t.n === 16 ? 1 : t.n === 32 ? 2 : 3))), desc: T('乘以 2 的 Zm 次方（Zm 是有符号整数）', 'Multiply by 2 to the power Zm (a signed integer)') },
  { m: 'fmulx', opc: 10, fn: (e, t, a, b) => sf.fpMulX(e, t, a, b), desc: T('乘（无穷乘 0 得 ±2）', 'Multiply extended (infinity times zero gives ±2)') },
  { m: 'fdivr', opc: 12, fn: (e, t, a, b) => sf.fpDiv(e, t, b, a), desc: T('反向除（第二个除以第一个）', 'Reversed divide (the second by the first)') },
  { m: 'fdiv', opc: 13, fn: (e, t, a, b) => sf.fpDiv(e, t, a, b), desc: T('除', 'Divide') },
]
for (const op of BIN) {
  const bin4 = op.opc.toString(2).padStart(4, '0')
  const run = (c: Cpu, f: Fields, k: number) => {
    const es = storage(k)
    const A = zget(c, f.Zdn!, es)
    const B = zget(c, f.Zm!, es)
    fpPred(c, f, f.Zdn!, es, (e, i) => op.fn(e, FMT[k]!, A[i]!, B[i]!))
  }
  INSTRS.push({
    id: `sve-${op.m}-pred`,
    mnemonic: op.m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 00 ${bin4} 100 Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>',
    valid: HSD,
    desc: T(`浮点${op.desc.zh}：Zdn 的活跃元素和 Zm 运算，结果写回 Zdn`, `Floating-point ${op.desc.en.toLowerCase()}: the active elements of Zdn with Zm, back into Zdn`),
    exec: (c, f) => run(c, f, f.size!),
  })
  if (op.bfm)
    INSTRS.push({
      id: `sve-${op.bfm}-pred`,
      mnemonic: op.bfm,
      group: G,
      feature: 'sve-b16b16',
      bits: `01100101 00 00 ${bin4} 100 Pg:3 Zm:5 Zdn:5`,
      syntax: '<Zdn.h>, <Pg/m>, <Zdn.h>, <Zm.h>',
      desc: T(`BFloat16 ${op.desc.zh}：Zdn 的活跃元素和 Zm 运算，结果写回 Zdn`, `BFloat16 ${op.desc.en.toLowerCase()}: the active elements of Zdn with Zm, back into Zdn`),
      exec: (c, f) => run(c, f, 0),
    })
}

// With an immediate: [mnemonic, opc, the two values i1 picks].
for (const [m, opc, v0, v1] of [
  ['fadd', 0, '0.5', '1.0'],
  ['fsub', 1, '0.5', '1.0'],
  ['fmul', 2, '0.5', '2.0'],
  ['fsubr', 3, '0.5', '1.0'],
  ['fmaxnm', 4, '0.0', '1.0'],
  ['fminnm', 5, '0.0', '1.0'],
  ['fmax', 6, '0.0', '1.0'],
  ['fmin', 7, '0.0', '1.0'],
] as const) {
  const op = BIN.find((o) => o.m === m)!
  INSTRS.push({
    id: `sve-${m}-imm`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 011 ${opc.toString(2).padStart(3, '0')} 100 Pg:3 0000 i1 Zdn:5`,
    syntax: `<Zdn.size>, <Pg/m>, <Zdn.size>, #<fimm1:${v0}:${v1}>`,
    valid: HSD,
    desc: T(`浮点${op.desc.zh}：Zdn 的活跃元素和立即数 ${v0} 或 ${v1} 运算`, `Floating-point ${op.desc.en.toLowerCase()}: the active elements of Zdn with the immediate ${v0} or ${v1}`),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      const imm = sf.fromNumber(t, Number(f.i1 ? v1 : v0))
      const A = zget(c, f.Zdn!, es)
      fpPred(c, f, f.Zdn!, es, (e, i) => op.fn(e, t, A[i]!, imm))
    },
  })
}

/* ------------------------------------------------------------------ unpredicated */

/** Zd = fn(Zn, Zm) element by element, in format index k. */
function fpAll(c: Cpu, d: number, k: number, A: bigint[], B: bigint[], fn: F2): void {
  const env = c.fpEnv()
  const t = FMT[k]!
  zset(c, d, A.map((a, i) => fn(env, t, a, B[i]!)), storage(k))
  c.fpFlags(env)
}
const UNPRED: [string, number, Text, F2, string?][] = [
  ['fadd', 0, T('加', 'Add'), BIN[0]!.fn, 'bfadd'],
  ['fsub', 1, T('减', 'Subtract'), BIN[1]!.fn, 'bfsub'],
  ['fmul', 2, T('乘', 'Multiply'), BIN[2]!.fn, 'bfmul'],
  [
    'ftsmul',
    3,
    T('三角函数辅助：Zn 的平方，符号取 Zm 的最低位（NaN 除外）', 'Trigonometric starting value: Zn squared, with the sign taken from bit 0 of Zm (NaNs excepted)'),
    (e, t, a, b) => {
      const r = sf.fpMul(e, t, a, a)
      if (sf.isNaN_(t, r)) return r
      const sign = 1n << BigInt(t.n - 1)
      return (r & ~sign) | (b & 1n ? sign : 0n)
    },
  ],
  ['frecps', 6, T('倒数迭代步：2 − Zn × Zm', 'Reciprocal step: 2 − Zn × Zm'), (e, t, a, b) => sf.fpRecipStep(e, t, a, b)],
  ['frsqrts', 7, T('平方根倒数迭代步：(3 − Zn × Zm) / 2', 'Reciprocal square root step: (3 − Zn × Zm) / 2'), (e, t, a, b) => sf.fpRSqrtStep(e, t, a, b)],
]
for (const [m, opc, desc, fn, bfm] of UNPRED) {
  const b3 = opc.toString(2).padStart(3, '0')
  INSTRS.push({
    id: `sve-${m}-unpred`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 0 Zm:5 000 ${b3} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    valid: HSD,
    desc: T(`浮点${desc.zh}（不带谓词）`, `Floating point: ${desc.en} (unpredicated)`),
    exec: (c, f) => fpAll(c, f.Zd!, f.size!, zget(c, f.Zn!, f.size!), zget(c, f.Zm!, f.size!), fn),
  })
  if (bfm)
    INSTRS.push({
      id: `sve-${bfm}-unpred`,
      mnemonic: bfm,
      group: G,
      feature: 'sve-b16b16',
      bits: `01100101 00 0 Zm:5 000 ${b3} Zn:5 Zd:5`,
      syntax: '<Zd.h>, <Zn.h>, <Zm.h>',
      desc: T(`BFloat16 ${desc.zh}（不带谓词）`, `BFloat16: ${desc.en} (unpredicated)`),
      exec: (c, f) => fpAll(c, f.Zd!, 0, zget(c, f.Zn!, 1), zget(c, f.Zm!, 1), fn),
    })
}

/* ------------------------------------------------------------------ multiply-add */

// [mnemonic, opc, negate the product, negate the addend]
const FMA: [string, number, boolean, boolean, Text][] = [
  ['fmla', 0, false, false, T('Zda + Zn × Zm', 'Zda + Zn × Zm')],
  ['fmls', 1, true, false, T('Zda − Zn × Zm', 'Zda − Zn × Zm')],
  ['fnmla', 2, true, true, T('−Zda − Zn × Zm', '−Zda − Zn × Zm')],
  ['fnmls', 3, false, true, T('−Zda + Zn × Zm', '−Zda + Zn × Zm')],
]
const fma = (e: Env, t: Fmt, acc: bigint, a: bigint, b: bigint, negP: boolean, negA: boolean) => sf.fpMulAdd(e, t, negA ? negOf(e, t, acc) : acc, negP ? negOf(e, t, a) : a, b)
for (const [m, opc, negP, negA, what] of FMA) {
  const b2 = opc.toString(2).padStart(2, '0')
  const run = (c: Cpu, f: Fields, k: number) => {
    const t = FMT[k]!
    const es = storage(k)
    const D = zget(c, f.Zda!, es)
    const A = zget(c, f.Zn!, es)
    const B = zget(c, f.Zm!, es)
    fpPred(c, f, f.Zda!, es, (e, i) => fma(e, t, D[i]!, A[i]!, B[i]!, negP, negA))
  }
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 1 Zm:5 0 ${b2} Pg:3 Zn:5 Zda:5`,
    syntax: '<Zda.size>, <Pg/m>, <Zn.size>, <Zm.size>',
    valid: HSD,
    desc: T(`浮点融合乘加：活跃元素 Zda = ${what.zh}（只舍入一次）`, `Floating-point fused multiply-add: active elements Zda = ${what.en} (rounded once)`),
    exec: (c, f) => run(c, f, f.size!),
  })
  if (opc < 2)
    INSTRS.push({
      id: `sve-bf${m.slice(1)}`,
      mnemonic: `bf${m.slice(1)}`,
      group: G,
      feature: 'sve-b16b16',
      bits: `01100101 00 1 Zm:5 0 ${b2} Pg:3 Zn:5 Zda:5`,
      syntax: '<Zda.h>, <Pg/m>, <Zn.h>, <Zm.h>',
      desc: T(`BFloat16 融合乘加：活跃元素 Zda = ${what.zh}`, `BFloat16 fused multiply-add: active elements Zda = ${what.en}`),
      exec: (c, f) => run(c, f, 0),
    })
  const m2 = ['fmad', 'fmsb', 'fnmad', 'fnmsb'][opc]!
  INSTRS.push({
    id: `sve-${m2}`,
    mnemonic: m2,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 1 Za:5 1 ${b2} Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zm.size>, <Za.size>',
    valid: HSD,
    desc: T(`浮点融合乘加：活跃元素 Zdn = ${what.zh.replace('Zda', 'Za').replace('Zn', 'Zdn')}`, `Floating-point fused multiply-add: active elements Zdn = ${what.en.replace('Zda', 'Za').replace('Zn', 'Zdn')}`),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      const A = zget(c, f.Zdn!, es)
      const B = zget(c, f.Zm!, es)
      const D = zget(c, f.Za!, es)
      fpPred(c, f, f.Zdn!, es, (e, i) => fma(e, t, D[i]!, A[i]!, B[i]!, negP, negA))
    },
  })
}

// Indexed: one element of Zm per 128-bit segment. [element size, size bits with the index and Zm, index fields]
const IDX: [number, string, string][] = [
  [1, '0 i3h 1 i3l:2 Zm:3', 'i3h+i3l'],
  [2, '1 0 1 i2:2 Zm:3', 'i2'],
  [3, '1 1 1 i1 Zm:4', 'i1'],
]
const idxOf = (f: Fields, es: number) => (es === 1 ? (f.i3h! << 2) | f.i3l! : es === 2 ? f.i2! : f.i1!)
for (const [es, head, idx] of IDX) {
  const t = 'hsd'[es - 1]!
  for (const [op, m, negP] of [
    [0, 'fmla', false],
    [1, 'fmls', true],
  ] as const) {
    const run = (c: Cpu, f: Fields, fk: number) => {
      const ft = FMT[fk]!
      const ves = storage(fk)
      const D = zget(c, f.Zda!, ves)
      const A = zget(c, f.Zn!, ves)
      const M = zget(c, f.Zm!, ves)
      const k = idxOf(f, es)
      const env = c.fpEnv()
      zset(c, f.Zda!, D.map((d, i) => fma(env, ft, d, A[i]!, segElem(M, ves, i, k), negP, false)), ves)
      c.fpFlags(env)
    }
    INSTRS.push({
      id: `sve-${m}-idx-${t}`,
      mnemonic: m,
      group: G,
      feature: 'sve',
      bits: `01100100 ${head} 00000 ${op} Zn:5 Zda:5`,
      syntax: `<Zda.${t}>, <Zn.${t}>, <Zm.${t}[${idx}]>`,
      desc: T(`浮点融合乘加：Zda ${negP ? '−' : '+'}= Zn × Zm 的一个元素（每 128 位段各取段内同一位置）`, `Floating-point fused multiply-add: Zda ${negP ? '−' : '+'}= Zn × one element of Zm (the same position in each 128-bit segment)`),
      exec: (c, f) => run(c, f, es),
    })
    if (es === 1)
      INSTRS.push({
        id: `sve-bf${m.slice(1)}-idx`,
        mnemonic: `bf${m.slice(1)}`,
        group: G,
        feature: 'sve-b16b16',
        bits: `01100100 ${head} 00001 ${op} Zn:5 Zda:5`,
        syntax: `<Zda.h>, <Zn.h>, <Zm.h[${idx}]>`,
        desc: T(`BFloat16 融合乘加：Zda ${negP ? '−' : '+'}= Zn × Zm 的一个元素（每 128 位段各取一个）`, `BFloat16 fused multiply-add: Zda ${negP ? '−' : '+'}= Zn × one element of Zm per 128-bit segment`),
        exec: (c, f) => run(c, f, 0),
      })
  }
  const runMul = (c: Cpu, f: Fields, fk: number) => {
    const ves = storage(fk)
    const M = zget(c, f.Zm!, ves)
    const k = idxOf(f, es)
    const A = zget(c, f.Zn!, ves)
    fpAll(c, f.Zd!, fk, A, A.map((_, i) => segElem(M, ves, i, k)), BIN[2]!.fn)
  }
  INSTRS.push({
    id: `sve-fmul-idx-${t}`,
    mnemonic: 'fmul',
    group: G,
    feature: 'sve',
    bits: `01100100 ${head} 001000 Zn:5 Zd:5`,
    syntax: `<Zd.${t}>, <Zn.${t}>, <Zm.${t}[${idx}]>`,
    desc: T('浮点乘：Zn × Zm 的一个元素（每 128 位段各取一个）', 'Floating-point multiply: Zn × one element of Zm per 128-bit segment'),
    exec: (c, f) => runMul(c, f, es),
  })
  if (es === 1)
    INSTRS.push({
      id: 'sve-bfmul-idx',
      mnemonic: 'bfmul',
      group: G,
      feature: 'sve-b16b16',
      bits: `01100100 ${head} 001010 Zn:5 Zd:5`,
      syntax: `<Zd.h>, <Zn.h>, <Zm.h[${idx}]>`,
      desc: T('BFloat16 乘：Zn × Zm 的一个元素（每 128 位段各取一个）', 'BFloat16 multiply: Zn × one element of Zm per 128-bit segment'),
      exec: (c, f) => runMul(c, f, 0),
    })
}

/* ------------------------------------------------------------------ complex */

/** FCMLA on element pairs (real, imaginary): Zda += one part of Zn × Zm rotated by rot × 90°. */
function fcmla(c: Cpu, f: Fields, es: number, rot: number, mPair: (p: number) => [bigint, bigint], pg: boolean[]): void {
  const t = FMT[es]!
  const env = c.fpEnv()
  const N = zget(c, f.Zn!, es)
  const D = zget(c, f.Zda!, es)
  const R = [...D]
  const neg = (x: bigint) => negOf(env, t, x)
  for (let p = 0; p < N.length / 2; p++) {
    const [mr, mi] = mPair(p)
    const nr = N[2 * p]!
    const ni = N[2 * p + 1]!
    let e1: bigint, e2: bigint, e3: bigint, e4: bigint
    if (rot === 0) [e1, e2, e3, e4] = [mr, nr, mi, nr]
    else if (rot === 1) [e1, e2, e3, e4] = [neg(mi), ni, mr, ni]
    else if (rot === 2) [e1, e2, e3, e4] = [neg(mr), nr, neg(mi), nr]
    else [e1, e2, e3, e4] = [mi, ni, neg(mr), ni]
    if (pg[2 * p]) R[2 * p] = sf.fpMulAdd(env, t, D[2 * p]!, e2, e1)
    if (pg[2 * p + 1]) R[2 * p + 1] = sf.fpMulAdd(env, t, D[2 * p + 1]!, e4, e3)
  }
  c.fpFlags(env)
  zset(c, f.Zda!, R, es)
}
const FCMLA_DESC = T('复数乘加：每对元素是（实部，虚部），把 Zn × Zm 旋转 #rot 度后的一部分加到 Zda；#0 和 #90 两条合起来是完整的复数乘加', 'Complex multiply-add: element pairs are (real, imaginary); adds one part of Zn × Zm rotated by #rot to Zda; #0 then #90 make a full complex multiply-add')
INSTRS.push(
  {
    id: 'sve-fcmla',
    mnemonic: 'fcmla',
    group: G,
    feature: 'sve',
    bits: '01100100 size:2 0 Zm:5 0 rot:2 Pg:3 Zn:5 Zda:5',
    syntax: '<Zda.size>, <Pg/m>, <Zn.size>, <Zm.size>, #<rot:rot>',
    valid: HSD,
    desc: FCMLA_DESC,
    exec(c, f) {
      const es = f.size!
      const M = zget(c, f.Zm!, es)
      fcmla(c, f, es, f.rot!, (p) => [M[2 * p]!, M[2 * p + 1]!], pget(c, f.Pg!, es))
    },
  },
  ...[
    [1, '101 i2:2 Zm:3', 'i2'],
    [2, '111 i1 Zm:4', 'i1'],
  ].map(
    ([es, head, idx]): InstrSpec => ({
      id: `sve-fcmla-idx-${'hsd'[(es as number) - 1]}`,
      mnemonic: 'fcmla',
      group: G,
      feature: 'sve',
      bits: `01100100 ${head} 0001 rot:2 Zn:5 Zda:5`,
      syntax: `<Zda.${'hsd'[(es as number) - 1]}>, <Zn.${'hsd'[(es as number) - 1]}>, <Zm.${'hsd'[(es as number) - 1]}[${idx}]>, #<rot:rot>`,
      desc: T(`${FCMLA_DESC.zh}；Zm 取每 128 位段里的第 i 对`, `${FCMLA_DESC.en}; Zm is pair i of each 128-bit segment`),
      exec(c, f) {
        const e = es as number
        const M = zget(c, f.Zm!, e)
        const k = e === 1 ? f.i2! : f.i1!
        const pairs = perSeg(e) / 2
        fcmla(c, f, e, f.rot!, (p) => {
          const base = (p - (p % pairs) + k) * 2
          return [M[base]!, M[base + 1]!]
        }, allTrue(c, e))
      },
    }),
  ),
  {
    id: 'sve-fcadd',
    mnemonic: 'fcadd',
    group: G,
    feature: 'sve',
    bits: '01100100 size:2 00000 rot 100 Pg:3 Zm:5 Zdn:5',
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>, #<crot:rot>',
    valid: HSD,
    desc: T('复数加：每对元素是（实部，虚部），Zdn 加上旋转 90 或 270 度的 Zm', 'Complex add: element pairs are (real, imaginary); Zdn plus Zm rotated by 90 or 270 degrees'),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      const A = zget(c, f.Zdn!, es)
      const B = zget(c, f.Zm!, es)
      fpPred(c, f, f.Zdn!, es, (e, i) => {
        const p = i & ~1
        // rot 90: (a.r − b.i, a.i + b.r); rot 270: (a.r + b.i, a.i − b.r)
        const b = i % 2 === 0 ? (f.rot ? B[p + 1]! : negOf(e, t, B[p + 1]!)) : f.rot ? negOf(e, t, B[p]!) : B[p]!
        return sf.fpAdd(e, t, A[i]!, b)
      })
    },
  },
)

/* ------------------------------------------------------------------ reductions */

/** The pairwise tree reduction of the vector padded to a power of two (Arm's Reduce). */
function reduceTree(vals: bigint[], op: (a: bigint, b: bigint) => bigint): bigint {
  if (vals.length === 1) return vals[0]!
  const half = vals.length / 2
  const lo = reduceTree(vals.slice(0, half), op)
  const hi = reduceTree(vals.slice(half), op)
  return op(lo, hi)
}
const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(n))
interface RedOp {
  m: string
  opc: number
  fn: F2
  identity: (e: Env, t: Fmt) => bigint
  desc: Text
}
const RED: RedOp[] = [
  { m: 'faddv', opc: 0, fn: BIN[0]!.fn, identity: () => 0n, desc: T('之和', 'sum') },
  { m: 'fmaxnmv', opc: 4, fn: BIN[4]!.fn, identity: (e, t) => sf.defaultNaN(t, e), desc: T('最大值（忽略 NaN）', 'maximum number (NaNs ignored)') },
  { m: 'fminnmv', opc: 5, fn: BIN[5]!.fn, identity: (e, t) => sf.defaultNaN(t, e), desc: T('最小值（忽略 NaN）', 'minimum number (NaNs ignored)') },
  { m: 'fmaxv', opc: 6, fn: BIN[6]!.fn, identity: (e, t) => (e.altfp ? sf.infOf(t, 1) : sf.infOf(t, 1)), desc: T('最大值', 'maximum') },
  { m: 'fminv', opc: 7, fn: BIN[7]!.fn, identity: (e, t) => sf.infOf(t, 0), desc: T('最小值', 'minimum') },
]
for (const op of RED) {
  const b3 = op.opc.toString(2).padStart(3, '0')
  INSTRS.push({
    id: `sve-${op.m}`,
    mnemonic: op.m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 000 ${b3} 001 Pg:3 Zn:5 Vd:5`,
    syntax: '<Vd.size>, <Pg>, <Zn.size>',
    valid: HSD,
    desc: T(`Zn 活跃元素的浮点${op.desc.zh}（两两成对的树形归约），放进标量 Vd`, `The floating-point ${op.desc.en} of the active elements of Zn (a pairwise tree), into scalar Vd`),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      const env = c.fpEnv()
      const pg = pget(c, f.Pg!, es)
      const A = zget(c, f.Zn!, es)
      const id = op.identity(env, t)
      const vals = Array.from({ length: pow2(A.length) }, (_, i) => (i < A.length && pg[i] ? A[i]! : id))
      const r = reduceTree(vals, (a, b) => op.fn(env, t, a, b))
      c.fpFlags(env)
      zset(c, f.Vd!, [r], es)
    },
  })
  // SVE2.1: the same per 128-bit lane across segments, into a Neon register.
  INSTRS.push({
    id: `sve-${op.m.slice(0, -1)}qv`,
    mnemonic: `${op.m.slice(0, -1)}qv`,
    group: 'sve2',
    feature: 'sve2p1',
    bits: `01100100 size:2 010 ${b3} 101 Pg:3 Zn:5 Rd:5`,
    syntax: '<Vd:size:1>, <Pg>, <Zn.size>',
    valid: HSD,
    desc: T(`每个 128 位段里同一位置的活跃元素求浮点${op.desc.zh}，结果是一个 128 位向量`, `The floating-point ${op.desc.en} of the active elements at each position across the 128-bit segments, as one 128-bit vector`),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      const env = c.fpEnv()
      const pg = pget(c, f.Pg!, es)
      const A = zget(c, f.Zn!, es)
      const per = perSeg(es)
      const segs = A.length / per
      const id = op.identity(env, t)
      const R = Array.from({ length: per }, (_, i) => {
        const vals = Array.from({ length: pow2(segs) }, (_, s) => (s < segs && pg[s * per + i] ? A[s * per + i]! : id))
        return reduceTree(vals, (a, b) => op.fn(env, t, a, b))
      })
      c.fpFlags(env)
      zset(c, f.Rd!, R, es)
    },
  })
}
INSTRS.push({
  id: 'sve-fadda',
  mnemonic: 'fadda',
  group: G,
  feature: 'sve',
  bits: '01100101 size:2 011000 001 Pg:3 Zm:5 Vdn:5',
  syntax: '<Vdn.size>, <Pg>, <Vdn.size>, <Zm.size>',
  valid: HSD,
  desc: T('按顺序累加：Vdn 依次加上 Zm 的每个活跃元素（严格从低到高，结果和逐个相加一样）', 'Ordered add: Vdn plus each active element of Zm, strictly from the lowest (as a scalar loop would)'),
  exec(c, f) {
    const es = f.size!
    const t = FMT[es]!
    const env = c.fpEnv()
    const pg = pget(c, f.Pg!, es)
    let acc = zget(c, f.Vdn!, es)[0]!
    zget(c, f.Zm!, es).forEach((b, i) => {
      if (pg[i]) acc = sf.fpAdd(env, t, acc, b)
    })
    c.fpFlags(env)
    zset(c, f.Vdn!, [acc], es)
  },
})

/* ------------------------------------------------------------------ compares */

const fcmp = (kind: 'eq' | 'ge' | 'gt', abs = false, not = false) => (e: Env, t: Fmt, a: bigint, b: bigint) => sf.fpCompareOp(e, t, abs ? sf.fpAbs(e, t, a) : a, abs ? sf.fpAbs(e, t, b) : b, kind) !== not
const unordered = (e: Env, t: Fmt, a: bigint, b: bigint) => sf.fpCompare(e, t, a, b, false) === 0b0011
function fpCompare(c: Cpu, f: Fields, es: number, B: (i: number) => bigint, test: (e: Env, t: Fmt, a: bigint, b: bigint) => boolean): void {
  const t = FMT[es]!
  const env = c.fpEnv()
  const pg = pget(c, f.Pg!, es)
  const A = zget(c, f.Zn!, es)
  pset(c, f.Pd!, pg.map((on, i) => on && test(env, t, A[i]!, B(i))), es)
  c.fpFlags(env)
}
const CMP_TEXT: Record<string, Text> = {
  fcmge: T('大于等于', 'greater than or equal to'),
  fcmgt: T('大于', 'greater than'),
  fcmeq: T('等于', 'equal to'),
  fcmne: T('不等于（NaN 算不等）', 'not equal to (a NaN counts as unequal)'),
  fcmuo: T('无序（有一个是 NaN）', 'unordered with (either is a NaN)'),
  facge: T('绝对值大于等于', 'in absolute value greater than or equal to'),
  facgt: T('绝对值大于', 'in absolute value greater than'),
  fcmlt: T('小于', 'less than'),
  fcmle: T('小于等于', 'less than or equal to'),
}
const cmpDesc = (m: string, what: Text) => T(`浮点比较：活跃元素是否${CMP_TEXT[m]!.zh}${what.zh}，结果放进谓词 Pd（不活跃的为假，不设置 NZCV）`, `Floating-point compare: whether active elements are ${CMP_TEXT[m]!.en} ${what.en}; the result goes to Pd (false where inactive; NZCV unchanged)`)
for (const [m, op, o2, o3, test] of [
  ['fcmge', 0, 0, 0, fcmp('ge')],
  ['fcmgt', 0, 0, 1, fcmp('gt')],
  ['fcmeq', 0, 1, 0, fcmp('eq')],
  ['fcmne', 0, 1, 1, fcmp('eq', false, true)],
  ['fcmuo', 1, 0, 0, unordered],
  ['facge', 1, 0, 1, fcmp('ge', true)],
  ['facgt', 1, 1, 1, fcmp('gt', true)],
] as const) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 0 Zm:5 ${op} 1 ${o2} Pg:3 Zn:5 ${o3} Pd:4`,
    syntax: '<Pd.size>, <Pg/z>, <Zn.size>, <Zm.size>',
    valid: HSD,
    desc: cmpDesc(m, T(' Zm 的对应元素', ' the matching element of Zm')),
    exec(c, f) {
      const B = zget(c, f.Zm!, f.size!)
      fpCompare(c, f, f.size!, (i) => B[i]!, test)
    },
  })
}
for (const [m, of] of [
  ['fcmle', 'fcmge'],
  ['fcmlt', 'fcmgt'],
  ['facle', 'facge'],
  ['faclt', 'facgt'],
] as const)
  ALIASES.push({ id: `sve-${m}-swap`, of: `sve-${of}`, mnemonic: m, syntax: '<Pd.size>, <Pg/z>, <Zm.size>, <Zn.size>', prefer: false })
for (const [m, eq, lt, ne, test] of [
  ['fcmge', 0, 0, 0, fcmp('ge')],
  ['fcmgt', 0, 0, 1, fcmp('gt')],
  ['fcmlt', 0, 1, 0, (e: Env, t: Fmt, a: bigint, b: bigint) => sf.fpCompareOp(e, t, b, a, 'gt')],
  ['fcmle', 0, 1, 1, (e: Env, t: Fmt, a: bigint, b: bigint) => sf.fpCompareOp(e, t, b, a, 'ge')],
  ['fcmeq', 1, 0, 0, fcmp('eq')],
  ['fcmne', 1, 1, 0, fcmp('eq', false, true)],
] as const) {
  INSTRS.push({
    id: `sve-${m}-zero`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 0100 ${eq} ${lt} 001 Pg:3 Zn:5 ${ne} Pd:4`,
    syntax: '<Pd.size>, <Pg/z>, <Zn.size>, #<fzero>',
    valid: HSD,
    desc: cmpDesc(m, T(' 0', ' zero')),
    exec: (c, f) => fpCompare(c, f, f.size!, () => 0n, test),
  })
}

/* ------------------------------------------------------------------ unary */

/** A predicated unary operation from elements of size `from` to elements of size `to`, in containers of the larger. */
function fpConvert(c: Cpu, f: Fields, from: number, to: number, fn: (e: Env, a: bigint) => bigint, signedResult = false): void {
  const es = Math.max(from, to)
  const A = zget(c, f.Zn!, es)
  const mask = (1n << BigInt(ESIZE[from]!)) - 1n
  fpPred(c, f, f.Zd!, es, (e, i) => {
    const r = fn(e, A[i]! & mask)
    return signedResult && to < es ? ux(sx(r, to), es) : r
  })
}
for (const [m, opc, rounding, exact] of [
  ['frintn', 0, sf.RN, false],
  ['frintp', 1, sf.RP, false],
  ['frintm', 2, sf.RM, false],
  ['frintz', 3, sf.RZ, false],
  ['frinta', 4, sf.RA, false],
  ['frintx', 6, null, true],
  ['frinti', 7, null, false],
] as const) {
  const how: Text = rounding === null ? (exact ? T('按 FPCR 的舍入方式，结果不精确时置 IXC', 'the FPCR rounding mode, raising IXC when inexact') : T('按 FPCR 的舍入方式', 'the FPCR rounding mode')) : [T('就近，平局取偶', 'to nearest, ties to even'), T('向 +∞', 'toward +∞'), T('向 −∞', 'toward −∞'), T('向 0', 'toward zero'), T('就近，平局远离 0', 'to nearest, ties away from zero')][rounding]!
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 000 ${opc.toString(2).padStart(3, '0')} 101 Pg:3 Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Pg/m>, <Zn.size>',
    valid: HSD,
    desc: T(`把活跃元素舍入成整数值（${how.zh}），仍是浮点数`, `Round the active elements to integral values (${how.en}), still floating point`),
    exec(c, f) {
      const es = f.size!
      fpConvert(c, f, es, es, (e, a) => sf.fpRoundInt(e, FMT[es]!, a, rounding ?? e.rmode, exact))
    },
  })
}
for (const [m, opc, desc, fn] of [
  ['frecpx', 0b1100, T('倒数的指数部分估算（用于缩放）', 'reciprocal exponent (for scaling)'), (e: Env, t: Fmt, a: bigint) => sf.fpRecpX(e, t, a)],
  ['fsqrt', 0b1101, T('平方根', 'square root'), (e: Env, t: Fmt, a: bigint) => sf.fpSqrt(e, t, a)],
] as const) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 00 ${opc.toString(2)} 101 Pg:3 Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Pg/m>, <Zn.size>',
    valid: HSD,
    desc: T(`活跃元素的${desc.zh}`, `The ${desc.en} of the active elements`),
    exec(c, f) {
      const es = f.size!
      fpConvert(c, f, es, es, (e, a) => fn(e, FMT[es]!, a))
    },
  })
}
for (const [m, op, desc, fn] of [
  ['frecpe', 0, T('倒数估算（约 8 位精度）', 'reciprocal estimate (about 8 bits)'), (e: Env, t: Fmt, a: bigint) => sf.fpRecipEstimate(e, t, a)],
  ['frsqrte', 1, T('平方根倒数估算（约 8 位精度）', 'reciprocal square root estimate (about 8 bits)'), (e: Env, t: Fmt, a: bigint) => sf.fpRSqrtEstimate(e, t, a)],
] as const) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `01100101 size:2 001 11 ${op} 001100 Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>',
    valid: HSD,
    desc: T(`每个元素的${desc.zh}`, `The ${desc.en} of each element`),
    exec(c, f) {
      const es = f.size!
      const env = c.fpEnv()
      zset(c, f.Zd!, zget(c, f.Zn!, es).map((a) => fn(env, FMT[es]!, a)), es)
      c.fpFlags(env)
    },
  })
}
INSTRS.push({
  id: 'sve-flogb',
  mnemonic: 'flogb',
  group: 'sve2',
  feature: 'sve2',
  bits: '01100101 00011 size:2 0 101 Pg:3 Zn:5 Zd:5',
  syntax: '<Zd.size>, <Pg/m>, <Zn.size>',
  valid: HSD,
  desc: T('活跃元素以 2 为底的对数的整数部分（有符号整数）；0 和 NaN 得最小整数，无穷得最大整数', 'The integer part of the base-2 logarithm of the active elements, as signed integers; zero and NaN give the most negative integer, infinity the largest'),
  exec(c, f) {
    const es = f.size!
    const t = FMT[es]!
    const bits = BigInt(ESIZE[es]!)
    fpConvert(c, f, es, es, (e, a) => {
      const v = sf.unpack(e, t, a)
      sf.denorms(e, t, v)
      if (v.t === sf.INF) return (1n << (bits - 1n)) - 1n
      if (v.t !== sf.NUM) {
        e.flags |= sf.IOC
        return 1n << (bits - 1n)
      }
      return ux(BigInt(sf.bitLength(v.m) - 1 + v.x), es)
    })
  },
})

/* ------------------------------------------------------------------ conversions */

const FCVT: [string, string, number, number][] = [
  ['10', '00', 2, 1],
  ['10', '01', 1, 2],
  ['11', '00', 3, 1],
  ['11', '01', 1, 3],
  ['11', '10', 3, 2],
  ['11', '11', 2, 3],
]
for (const [opc, opc2, from, to] of FCVT) {
  const [fl, tl] = ['hsd'[from - 1]!, 'hsd'[to - 1]!]
  INSTRS.push({
    id: `sve-fcvt-${tl}${fl}`,
    mnemonic: 'fcvt',
    group: G,
    feature: 'sve',
    bits: `01100101 ${opc} 0010 ${opc2} 101 Pg:3 Zn:5 Zd:5`,
    syntax: `<Zd.${tl}>, <Pg/m>, <Zn.${fl}>`,
    desc: T(`把活跃元素从${fmtName(from)}转换成${fmtName(to)}（元素按较宽的一方占位，较窄的值放在低位）`, `Convert the active elements from ${['', 'half', 'single', 'double'][from]} to ${['', 'half', 'single', 'double'][to]} precision (in containers of the wider size, the narrower value in the low bits)`),
    // SVE's conversions always use IEEE half precision: FPCR.AHP does not apply (FPConvertSVE).
    exec: (c, f) => fpConvert(c, f, from, to, (e, a) => sf.fpConvert(e.with(0, sf.AHP), FMT[from]!, FMT[to]!, a)),
  })
}
INSTRS.push(
  {
    id: 'sve-bfcvt',
    mnemonic: 'bfcvt',
    group: G,
    feature: 'bf16',
    bits: '01100101 10 0010 10 101 Pg:3 Zn:5 Zd:5',
    syntax: '<Zd.h>, <Pg/m>, <Zn.s>',
    desc: T('把活跃的单精度元素转换成 BFloat16，放在每个 32 位元素的低 16 位', 'Convert the active single-precision elements to BFloat16, in the low 16 bits of each 32-bit element'),
    exec: (c, f) => fpConvert(c, f, 2, 1, (e, a) => sf.fpConvertBF(e, a)),
  },
  {
    id: 'sve-fcvtx',
    mnemonic: 'fcvtx',
    group: 'sve2',
    feature: 'sve2',
    bits: '01100101 00 0010 10 101 Pg:3 Zn:5 Zd:5',
    syntax: '<Zd.s>, <Pg/m>, <Zn.d>',
    desc: T('把活跃的双精度元素转换成单精度，向奇数舍入（之后再转半精度不会两次舍入出错）', 'Convert the active double-precision elements to single, rounding to odd (so a later narrowing cannot double-round)'),
    exec: (c, f) => fpConvert(c, f, 3, 2, (e, a) => sf.fpConvert(e, sf.F64, sf.F32, a, sf.RO)),
  },
)
// FCVTZS/FCVTZU and SCVTF/UCVTF: [opc, opc2, float size, integer size].
const ICVT: [string, string, number, number][] = [
  ['01', '01', 1, 1],
  ['01', '10', 1, 2],
  ['01', '11', 1, 3],
  ['10', '10', 2, 2],
  ['11', '00', 3, 2],
  ['11', '10', 2, 3],
  ['11', '11', 3, 3],
]
const CVTF: [string, string, number, number][] = [
  ['01', '01', 1, 1],
  ['01', '10', 1, 2],
  ['01', '11', 1, 3],
  ['10', '10', 2, 2],
  ['11', '00', 3, 2],
  ['11', '10', 2, 3],
  ['11', '11', 3, 3],
]
for (const U of [0, 1]) {
  for (const [opc, opc2, fe, ie] of ICVT) {
    const m = U ? 'fcvtzu' : 'fcvtzs'
    const [fl, il] = ['hsd'[fe - 1]!, 'hsd'[ie - 1]!]
    INSTRS.push({
      id: `sve-${m}-${il}${fl}`,
      mnemonic: m,
      group: G,
      feature: 'sve',
      bits: `01100101 ${opc} 011 ${opc2} ${U} 101 Pg:3 Zn:5 Zd:5`,
      syntax: `<Zd.${il}>, <Pg/m>, <Zn.${fl}>`,
      desc: T(`把活跃的浮点元素向 0 舍入成${U ? '无' : '有'}符号整数（超出范围时饱和）`, `Convert the active floating-point elements to ${U ? 'unsigned' : 'signed'} integers, rounding toward zero (saturating)`),
      exec: (c, f) => fpConvert(c, f, fe, ie, (e, a) => sf.fpToFixed(e, FMT[fe]!, a, 0, U === 1, sf.RZ, ESIZE[ie]!), !U),
    })
  }
  for (const [opc, opc2, fe, ie] of CVTF) {
    const m = U ? 'ucvtf' : 'scvtf'
    const [fl, il] = ['hsd'[fe - 1]!, 'hsd'[ie - 1]!]
    INSTRS.push({
      id: `sve-${m}-${fl}${il}`,
      mnemonic: m,
      group: G,
      feature: 'sve',
      bits: `01100101 ${opc} 010 ${opc2} ${U} 101 Pg:3 Zn:5 Zd:5`,
      syntax: `<Zd.${fl}>, <Pg/m>, <Zn.${il}>`,
      desc: T(`把活跃的${U ? '无' : '有'}符号整数元素转换成浮点数`, `Convert the active ${U ? 'unsigned' : 'signed'} integer elements to floating point`),
      exec: (c, f) => fpConvert(c, f, ie, fe, (e, a) => sf.fixedToFp(e, FMT[fe]!, a, 0, U === 1, ESIZE[ie]!)),
    })
  }
}
// SVE2: narrowing into the odd elements, widening from them. [mnemonic, opc, opc2, from, to, BF16]
for (const [m, opc, opc2, from, to, feature] of [
  ['fcvtnt', '10', '00', 2, 1, 'sve2'],
  ['fcvtlt', '10', '01', 1, 2, 'sve2'],
  ['bfcvtnt', '10', '10', 2, 1, 'bf16'],
  ['fcvtnt', '11', '10', 3, 2, 'sve2'],
  ['fcvtlt', '11', '11', 2, 3, 'sve2'],
  ['fcvtxnt', '00', '10', 3, 2, 'sve2'],
] as const) {
  const [fl, tl] = ['hsd'[from - 1]!, 'hsd'[to - 1]!]
  const narrow = to < from
  const conv = (e: Env, a: bigint) => (m === 'bfcvtnt' ? sf.fpConvertBF(e, a) : sf.fpConvert(e.with(0, sf.AHP), FMT[from]!, FMT[to]!, a, m === 'fcvtxnt' ? sf.RO : e.rmode))
  INSTRS.push({
    id: `sve-${m}-${tl}${fl}`,
    mnemonic: m,
    group: 'sve2',
    feature,
    bits: `01100100 ${opc} 0010 ${opc2} 101 Pg:3 Zn:5 Zd:5`,
    syntax: `<Zd.${tl}>, <Pg/m>, <Zn.${fl}>`,
    desc: narrow
      ? T(`把活跃元素转换成${m === 'bfcvtnt' ? ' BFloat16' : fmtName(to)}${m === 'fcvtxnt' ? '（向奇数舍入）' : ''}，写进 Zd 的奇数号（高半）窄元素，偶数号不变`, `Convert the active elements to ${m === 'bfcvtnt' ? 'BFloat16' : ['', 'half', 'single'][to] + ' precision'}${m === 'fcvtxnt' ? ' (rounding to odd)' : ''} into the odd (top) narrow elements of Zd; the even ones stay`)
      : T(`把 Zn 奇数号（高半）的窄元素转换成${fmtName(to)}`, `Convert the odd (top) narrow elements of Zn to ${['', '', 'single', 'double'][to]} precision`),
    exec(c, f) {
      const pg = pget(c, f.Pg!, Math.max(from, to))
      const env = c.fpEnv()
      if (narrow) {
        const A = zget(c, f.Zn!, from)
        const D = zget(c, f.Zd!, to)
        A.forEach((a, i) => {
          if (pg[i]) D[2 * i + 1] = conv(env, a)
        })
        zset(c, f.Zd!, D, to)
      } else {
        const A = zget(c, f.Zn!, from)
        predicated(c, f.Zd!, to, pg, true, (i) => conv(env, A[2 * i + 1]!))
      }
      c.fpFlags(env)
    },
  })
}

/* ------------------------------------------------------------------ FMOV of immediates */

INSTRS.push(
  {
    id: 'sve-fdup',
    mnemonic: 'fmov',
    group: G,
    feature: 'sve',
    bits: '00100101 size:2 111 001 11 0 imm8:8 Zd:5',
    syntax: '<Zd.size>, #<fimm8>',
    valid: HSD,
    desc: T('把浮点立即数复制到 Zd 的每个元素（立即数是 ±(1 + n/16) × 2^e）', 'Copy a floating-point immediate to every element of Zd (the immediate is ±(1 + n/16) × 2^e)'),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      zset(c, f.Zd!, allTrue(c, es).map(() => fpImmBits(f.imm8!, t.e, t.f)), es)
    },
  },
  {
    id: 'sve-fcpy',
    mnemonic: 'fmov',
    group: G,
    feature: 'sve',
    bits: '00000101 size:2 01 Pg:4 110 imm8:8 Zd:5',
    syntax: '<Zd.size>, <Pg/m>, #<fimm8>',
    valid: HSD,
    desc: T('把浮点立即数复制到 Zd 的活跃元素，其余不变', 'Copy a floating-point immediate to the active elements of Zd; the others stay'),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      predicated(c, f.Zd!, es, pget(c, f.Pg!, es), true, () => fpImmBits(f.imm8!, t.e, t.f))
    },
  },
)
ALIASES.push(
  { id: 'sve-fdup-name', of: 'sve-fdup', mnemonic: 'fdup', syntax: '<Zd.size>, #<fimm8>', prefer: false },
  { id: 'sve-fcpy-name', of: 'sve-fcpy', mnemonic: 'fcpy', syntax: '<Zd.size>, <Pg/m>, #<fimm8>', prefer: false },
  { id: 'sve-fmov-zero', of: 'sve-dup-imm', mnemonic: 'fmov', syntax: '<Zd.size>, #<fzero>', fixed: { sh: 0, imm8: 0 }, prefer: false, desc: T('把 Zd 的每个元素设为 +0.0（就是 mov Zd, #0）', 'Set every element of Zd to +0.0 (the same as mov Zd, #0)') },
  { id: 'sve-fmov-zero-m', of: 'sve-cpy-imm', mnemonic: 'fmov', syntax: '<Zd.size>, <Pg/m>, #<fzero>', fixed: { M: 1, sh: 0, imm8: 0 }, prefer: false, desc: T('把 Zd 的活跃元素设为 +0.0（就是 mov Zd, Pg/m, #0）', 'Set the active elements of Zd to +0.0 (the same as mov Zd, Pg/m, #0)') },
)

/* ------------------------------------------------------------------ trigonometric and exponential helpers */

/**
 * FTMAD's coefficients (FPTrigMAddCoefficient): sine series at 0–7, cosine series at 8–15, per format.
 * Architectural constants, not a Taylor series: the higher terms are tuned.
 */
const FTMAD: Record<number, bigint[]> = {
  1: [0x3c00n, 0xb155n, 0x2030n, 0n, 0n, 0n, 0n, 0n, 0x3c00n, 0xb800n, 0x293an, 0n, 0n, 0n, 0n, 0n],
  2: [0x3f800000n, 0xbe2aaaabn, 0x3c088886n, 0xb95008b9n, 0x36369d6dn, 0n, 0n, 0n, 0x3f800000n, 0xbf000000n, 0x3d2aaaa6n, 0xbab60705n, 0x37cd37ccn, 0n, 0n, 0n],
  3: [
    0x3ff0000000000000n, 0xbfc5555555555543n, 0x3f8111111110f30cn, 0xbf2a01a019b92fc6n, 0x3ec71de351f3d22bn, 0xbe5ae5e2b60f7b91n, 0x3de5d8408868552fn, 0n,
    0x3ff0000000000000n, 0xbfe0000000000000n, 0x3fa5555555555536n, 0xbf56c16c16c13a0bn, 0x3efa01a019b1e8d8n, 0xbe927e4f7282f468n, 0x3e21ee96d2641b13n, 0xbda8f76380fbb401n,
  ],
}

/** ⌊x^(1/n)⌋ for big integers. */
function nthRoot(x: bigint, n: bigint): bigint {
  let r = 1n << BigInt(Math.ceil(x.toString(2).length / Number(n)) + 1)
  for (;;) {
    const next = ((n - 1n) * r + x / r ** (n - 1n)) / n
    if (next >= r) break
    r = next
  }
  while (r ** n > x) r--
  while ((r + 1n) ** n <= x) r++
  return r
}
/** FEXPA's table: the fraction bits of 2^(i/entries), rounded to nearest. */
function expaTable(entries: number, fbits: number): bigint[] {
  const P = fbits + 16
  return Array.from({ length: entries }, (_, i) => {
    const y = nthRoot(1n << BigInt(i + entries * P), BigInt(entries))
    return ((y + (1n << 15n)) >> 16n) - (1n << BigInt(fbits))
  })
}
let expa: Record<number, bigint[]> | null = null
function fexpa(es: number, op: bigint): bigint {
  expa ??= { 1: expaTable(32, 10), 2: expaTable(64, 23), 3: expaTable(64, 52) }
  if (es === 1) return (((op >> 5n) & 0x1fn) << 10n) | expa[1]![Number(op & 0x1fn)]!
  if (es === 2) return (((op >> 6n) & 0xffn) << 23n) | expa[2]![Number(op & 0x3fn)]!
  return (((op >> 6n) & 0x7ffn) << 52n) | expa[3]![Number(op & 0x3fn)]!
}

INSTRS.push(
  {
    id: 'sve-ftmad',
    mnemonic: 'ftmad',
    group: G,
    feature: 'sve',
    bits: '01100101 size:2 010 imm3:3 100000 Zm:5 Zdn:5',
    syntax: '<Zdn.size>, <Zdn.size>, <Zm.size>, #<u:imm3>',
    valid: HSD,
    desc: T('三角函数级数的一步：Zdn = 系数[imm（Zm 为负时 +8）] + Zdn × |Zm|，系数是正弦（0–7）和余弦（8–15）级数的固定常数', 'One step of a trigonometric series: Zdn = coefficient[imm (+8 when Zm is negative)] + Zdn × |Zm|, with fixed sine (0–7) and cosine (8–15) series coefficients'),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      const A = zget(c, f.Zdn!, es)
      const B = zget(c, f.Zm!, es)
      const sign = 1n << BigInt(t.n - 1)
      const env = c.fpEnv()
      zset(c, f.Zdn!, A.map((a, i) => {
        const b = B[i]!
        const coeff = FTMAD[es]![f.imm3! + (b & sign ? 8 : 0)]!
        return sf.fpMulAdd(env, t, coeff, a, sf.fpAbs(env, t, b))
      }), es)
      c.fpFlags(env)
    },
  },
  {
    id: 'sve-ftssel',
    mnemonic: 'ftssel',
    group: G,
    feature: 'sve',
    bits: '00000100 size:2 1 Zm:5 101100 Zn:5 Zd:5',
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    valid: HSD,
    desc: T('三角函数辅助：Zm 的第 0 位为 1 时取 1.0，否则取 Zn；Zm 的第 1 位为 1 时再取反', 'Trigonometric select: 1.0 when bit 0 of Zm is set, else Zn; negated when bit 1 of Zm is set'),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      const sign = 1n << BigInt(t.n - 1)
      const one = sf.fromNumber(t, 1)
      const env = c.fpEnv()
      const B = zget(c, f.Zm!, es)
      zset(c, f.Zd!, zget(c, f.Zn!, es).map((a, i) => (B[i]! & 1n ? one | (B[i]! & 2n ? sign : 0n) : B[i]! & 2n ? sf.fpNeg(env, t, a) : a)), es)
    },
  },
  {
    id: 'sve-fexpa',
    mnemonic: 'fexpa',
    group: G,
    feature: 'sve',
    bits: '00000100 size:2 1 00000 101110 Zn:5 Zd:5',
    syntax: '<Zd.size>, <Zn.size>',
    valid: HSD,
    desc: T('指数加速：用 Zn 的低位查 2^(i/64)（半精度 2^(i/32)）的小数部分，再拼上 Zn 里接着的指数位', 'Exponential accelerator: the low bits of Zn index the fraction of 2^(i/64) (2^(i/32) for half precision), joined with the exponent bits that follow them'),
    exec(c, f) {
      const es = f.size!
      zset(c, f.Zd!, zget(c, f.Zn!, es).map((a) => fexpa(es, a)), es)
    },
  },
)

/* ------------------------------------------------------------------ SVE2: pairwise */

for (const [m, opc, fn] of [
  ['faddp', 0, BIN[0]!.fn],
  ['fmaxnmp', 4, BIN[4]!.fn],
  ['fminnmp', 5, BIN[5]!.fn],
  ['fmaxp', 6, BIN[6]!.fn],
  ['fminp', 7, BIN[7]!.fn],
] as const) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: 'sve2',
    feature: 'sve2',
    bits: `01100100 size:2 010 ${opc.toString(2).padStart(3, '0')} 100 Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>',
    valid: HSD,
    desc: T(`相邻元素两两运算（${m.slice(1, -1)}）：偶数号结果来自 Zdn 的一对，奇数号来自 Zm 的一对`, `Pairwise ${m.slice(1, -1)} of adjacent elements: even results from pairs of Zdn, odd results from pairs of Zm`),
    exec(c, f) {
      const es = f.size!
      const t = FMT[es]!
      const A = zget(c, f.Zdn!, es)
      const B = zget(c, f.Zm!, es)
      fpPred(c, f, f.Zdn!, es, (e, i) => (i % 2 === 0 ? fn(e, t, A[i]!, A[i + 1]!) : fn(e, t, B[i - 1]!, B[i]!)))
    },
  })
}

/* ------------------------------------------------------------------ widening multiply-add, dot products */

function widening(c: Cpu, f: Fields, bf16: boolean, sub: boolean, T_: number, m: ((i: number) => bigint) | null): void {
  const env = c.fpEnv()
  const N = zget(c, f.Zn!, 1)
  const M = m ? null : zget(c, f.Zm!, 1)
  const D = zget(c, f.Zda!, 2)
  // BFMulAdd: with FPCR.AH it flushes denormals, rounds to nearest and raises no flags.
  const alt = bf16 && env.altfp ? env.with(sf.FIZ | sf.FZ, 3 << 22) : env
  const widen = (h: bigint) => (bf16 ? bf(h) : widenHalf(env, h))
  const R = D.map((d, i) => {
    let a = widen(N[2 * i + T_]!)
    if (sub) a = negOf(env, sf.F32, a)
    return sf.fpMulAdd(alt, sf.F32, d, a, widen(m ? m(i) : M![2 * i + T_]!), !(bf16 && env.altfp))
  })
  c.fpFlags(env)
  zset(c, f.Zda!, R, 2)
}
for (const o2 of [0, 1]) {
  for (const op of [0, 1]) {
    for (const T_ of [0, 1]) {
      const m = `${o2 ? 'bf' : 'f'}ml${op ? 's' : 'a'}l${T_ ? 't' : 'b'}`
      const feature = o2 ? (op ? 'sve2p1' : 'bf16') : 'sve2'
      const what = T(`${T_ ? '奇数号（高半）' : '偶数号（低半）'}${o2 ? ' BF16' : '半精度'}元素相乘${op ? '后从' : '后加到'} Zda 的单精度元素${op ? '减去' : ''}（融合）`, `Multiply the ${T_ ? 'odd (top)' : 'even (bottom)'} ${o2 ? 'BFloat16' : 'half-precision'} elements and ${op ? 'subtract from' : 'add to'} the single-precision elements of Zda (fused)`)
      INSTRS.push(
        {
          id: `sve-${m}`,
          mnemonic: m,
          group: 'sve2',
          feature,
          bits: `01100100 1 ${o2} 1 Zm:5 10 ${op} 0 0 ${T_} Zn:5 Zda:5`,
          syntax: '<Zda.s>, <Zn.h>, <Zm.h>',
          desc: what,
          exec: (c, f) => widening(c, f, o2 === 1, op === 1, T_, null),
        },
        {
          id: `sve-${m}-idx`,
          mnemonic: m,
          group: 'sve2',
          feature,
          bits: `01100100 1 ${o2} 1 i3h:2 Zm:3 01 ${op} 0 i3l ${T_} Zn:5 Zda:5`,
          syntax: '<Zda.s>, <Zn.h>, <Zm.h[i3h+i3l]>',
          desc: T(`${what.zh}；乘以 Zm 每个 128 位段里的一个元素`, `${what.en}; by one element of Zm per 128-bit segment`),
          exec(c, f) {
            const M = zget(c, f.Zm!, 1)
            const k = (f.i3h! << 1) | f.i3l!
            widening(c, f, o2 === 1, op === 1, T_, (i) => M[(i - (i % 4)) * 2 + k]!)
          },
        },
      )
    }
  }
}

/** The 2-way dot products: Zda.s += Zn.h[2i] × Zm.h[2i] + Zn.h[2i+1] × Zm.h[2i+1]. */
function dot2(c: Cpu, f: Fields, bf16: boolean, m: (i: number) => [bigint, bigint]): void {
  const N = zget(c, f.Zn!, 1)
  const D = zget(c, f.Zda!, 2)
  const env = c.fpEnv()
  zset(c, f.Zda!, D.map((d, i) => {
    const [m1, m2] = m(i)
    return bf16 ? bfDotAdd(d, N[2 * i]!, N[2 * i + 1]!, m1, m2, env.fpcr) : sf.fpAdd(env, sf.F32, d, sf.fpDot(env, sf.F16, N[2 * i]!, N[2 * i + 1]!, m1, m2))
  }), 2)
  if (!bf16) c.fpFlags(env)
}
for (const o2 of [0, 1]) {
  const m = o2 ? 'bfdot' : 'fdot'
  const what = o2
    ? T('BFloat16 点积：每两个 BF16 相乘求和，加到 Zda 的单精度元素（向奇数舍入，非规格化数当 0，不置标志）', 'BFloat16 dot product: pairs of BF16 multiplied and summed into a single-precision element of Zda (round to odd, denormals as zero, no flags)')
    : T('半精度点积：每两个半精度数相乘求和（舍入一次），再加到 Zda 的单精度元素', 'Half-precision dot product: pairs multiplied and summed (rounded once), then added to a single-precision element of Zda')
  INSTRS.push(
    {
      id: `sve-${m}`,
      mnemonic: m,
      group: 'sve2',
      feature: o2 ? 'bf16' : 'sve2p1',
      bits: `01100100 0 ${o2} 1 Zm:5 100000 Zn:5 Zda:5`,
      syntax: '<Zda.s>, <Zn.h>, <Zm.h>',
      desc: what,
      exec(c, f) {
        const M = zget(c, f.Zm!, 1)
        dot2(c, f, o2 === 1, (i) => [M[2 * i]!, M[2 * i + 1]!])
      },
    },
    {
      id: `sve-${m}-idx`,
      mnemonic: m,
      group: 'sve2',
      feature: o2 ? 'bf16' : 'sve2p1',
      bits: `01100100 0 ${o2} 1 i2:2 Zm:3 010000 Zn:5 Zda:5`,
      syntax: '<Zda.s>, <Zn.h>, <Zm.h[i2]>',
      desc: T(`${what.zh}；Zm 取每个 128 位段里的第 i 对`, `${what.en}; Zm is pair i of each 128-bit segment`),
      exec(c, f) {
        const M = zget(c, f.Zm!, 1)
        dot2(c, f, o2 === 1, (i) => {
          const base = (i - (i % 4)) * 2 + 2 * f.i2!
          return [M[base]!, M[base + 1]!]
        })
      },
    },
  )
}

/* ------------------------------------------------------------------ matrix multiply, clamp */

INSTRS.push(
  {
    id: 'sve-bfmmla',
    mnemonic: 'bfmmla',
    group: 'sve2',
    feature: 'bf16',
    bits: '01100100 011 Zm:5 111001 Zn:5 Zda:5',
    syntax: '<Zda.s>, <Zn.h>, <Zm.h>',
    desc: T('BFloat16 矩阵乘加：每个 128 位段里 Zda（2×2 单精度）+= Zn（2×4）× Zm（2×4）的转置', 'BFloat16 matrix multiply-accumulate in each 128-bit segment: Zda (2×2 single) += Zn (2×4) × the transpose of Zm (2×4)'),
    exec(c, f) {
      const N = zget(c, f.Zn!, 1)
      const M = zget(c, f.Zm!, 1)
      const fpcr = c.fpEnv().fpcr
      zset(c, f.Zda!, zget(c, f.Zda!, 2).map((d, k) => {
        const s = (k >> 2) * 8
        const i = (k >> 1) & 1
        const j = k & 1
        const a = (x: number) => N[s + 4 * i + x]!
        const b = (x: number) => M[s + 4 * j + x]!
        return bfDotAdd(bfDotAdd(d, a(0), a(1), b(0), b(1), fpcr), a(2), a(3), b(2), b(3), fpcr)
      }), 2)
    },
  },
  ...[2, 3].map(
    (es): InstrSpec => ({
      id: `sve-fmmla-${'sd'[es - 2]}`,
      mnemonic: 'fmmla',
      group: 'sve2',
      feature: es === 2 ? 'f32mm' : 'f64mm',
      bits: `01100100 1${es - 2} 1 Zm:5 111001 Zn:5 Zda:5`,
      syntax: `<Zda.${'sd'[es - 2]}>, <Zn.${'sd'[es - 2]}>, <Zm.${'sd'[es - 2]}>`,
      desc: T(`${fmtName(es)}矩阵乘加：每 4 个元素是一个 2×2 矩阵，Zda += Zn × Zm 的转置${es === 3 ? '（向量至少要 256 位）' : ''}`, `${es === 2 ? 'Single' : 'Double'}-precision matrix multiply-accumulate: each 4 elements are a 2×2 matrix; Zda += Zn × the transpose of Zm${es === 3 ? ' (needs a vector of at least 256 bits)' : ''}`),
      exec(c, f) {
        if (es === 3 && c.vl < 32) c.undefinedInstr(L('双精度 FMMLA 要求向量至少 256 位', 'Double-precision FMMLA needs a vector of at least 256 bits'))
        const t = FMT[es]!
        const env = c.fpEnv()
        const N = zget(c, f.Zn!, es)
        const M = zget(c, f.Zm!, es)
        zset(c, f.Zda!, zget(c, f.Zda!, es).map((d, k) => {
          const s = k & ~3
          const i = (k >> 1) & 1
          const j = k & 1
          let sum = d
          for (let x = 0; x < 2; x++) sum = sf.fpMulAdd(env, t, sum, N[s + 2 * i + x]!, M[s + 2 * j + x]!)
          return sum
        }), es)
        c.fpFlags(env)
      },
    }),
  ),
)
for (const [size, m, feature] of [
  [0, 'bfclamp', 'sve-b16b16'],
  [-1, 'fclamp', 'sve2p1'],
] as const) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: 'sve2',
    feature,
    bits: size === 0 ? '01100100 00 1 Zm:5 001001 Zn:5 Zd:5' : '01100100 size:2 1 Zm:5 001001 Zn:5 Zd:5',
    syntax: size === 0 ? '<Zd.h>, <Zn.h>, <Zm.h>' : '<Zd.size>, <Zn.size>, <Zm.size>',
    valid: size === 0 ? undefined : HSD,
    desc: T('把 Zd 的每个元素限制在 [Zn, Zm] 之间：minNum(maxNum(Zn, Zd), Zm)，NaN 输给数', 'Clamp each element of Zd to [Zn, Zm]: minNum(maxNum(Zn, Zd), Zm), where a quiet NaN loses to a number'),
    exec(c, f) {
      // BFCLAMP: halfword elements in BFloat16.
      const es = size === 0 ? 1 : f.size!
      const t = size === 0 ? FMT[0]! : FMT[es]!
      const env = c.fpEnv()
      const lo = zget(c, f.Zn!, es)
      const hi = zget(c, f.Zm!, es)
      zset(c, f.Zd!, zget(c, f.Zd!, es).map((d, i) => sf.fpMaxMinNum(env, t, sf.fpMaxMinNum(env, t, lo[i]!, d, true), hi[i]!, false)), es)
      c.fpFlags(env)
    },
  })
}
