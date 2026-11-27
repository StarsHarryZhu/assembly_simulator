/**
 * SVE2 and SVE2.1 integer instructions: predicated pairwise, halving, saturating and rounding-shift
 * arithmetic; the widening (bottom/top), wide and narrowing forms; multiply-add long, saturating doubling
 * and rounding forms, by vector and by indexed element; complex integer arithmetic (CADD, CMLA, CDOT,
 * SQRDCMLAH); dot products and matrix multiply (SDOT, USDOT, SMMLA…); bit permutation (BEXT, BDEP, BGRP);
 * carry-long add/subtract; shift-and-insert and shift-and-accumulate; HISTCNT, HISTSEG, MATCH; the SVE2
 * crypto forms (AES, SM4, RAX1); and SVE2.1's quadword reductions (ADDQV…), clamps and multi-vector
 * narrowing (SQCVTN, SQRSHRN…).
 */
import { T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import { mixColumns, rol, SBOXES, shiftRows, sm4Rounds } from './crypto'
import { highBit } from '../encoding/sve'
import { bin, sizes, tshAmount } from './sve-int'
import type { Cpu, Fields } from './types'
import { ESIZE, maskEs, polyMul, sat, shiftReg, shiftSve, sx, ux } from './vec'
import { pget, predicated, predTest, pset, zget, zset } from './zvec'
import * as sf from '../softfloat'

export const INSTRS: InstrSpec[] = []
export const ALIASES: AliasSpec[] = []
const G = 'sve2'
const LET = 'bhsdq'

/** An element as a signed or unsigned integer. */
const iv = (v: bigint, es: number, unsigned: boolean) => (unsigned ? v : sx(v, es))
const satv = (v: bigint, es: number, unsigned: boolean) => sat(v, es, unsigned)[0]
const ESN = (es: number) => BigInt(ESIZE[es]!)

/** Predicated Zdn = fn(Zdn[i], Zm[i]) (merging). */
function pred2(c: Cpu, f: Fields, es: number, fn: (a: bigint, b: bigint, i: number, A: bigint[], B: bigint[]) => bigint): void {
  const A = zget(c, f.Zdn!, es)
  const B = zget(c, f.Zm!, es)
  predicated(c, f.Zdn!, es, pget(c, f.Pg!, es), true, (i) => fn(A[i]!, B[i]!, i, A, B))
}

/* ------------------------------------------------------------------ predicated */

// SADALP, UADALP: pairs of narrow elements added to the wide accumulator.
for (const U of [0, 1]) {
  const m = U ? 'uadalp' : 'sadalp'
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2',
    bits: `01000100 size:2 00010 ${U} 101 Pg:3 Zn:5 Zda:5`,
    syntax: '<Zda.size>, <Pg/m>, <Zn.size-1>',
    valid: sizes('hsd'),
    desc: T(`Zn 相邻两个${U ? '无' : '有'}符号窄元素相加，加到 Zda 对应的宽元素（活跃的）`, `Add adjacent pairs of ${U ? 'unsigned' : 'signed'} narrow elements of Zn to the matching wide element of Zda (active ones)`),
    exec(c, f) {
      const es = f.size!
      const N = zget(c, f.Zn!, es - 1)
      const D = zget(c, f.Zda!, es)
      predicated(c, f.Zda!, es, pget(c, f.Pg!, es), true, (i) => ux(D[i]! + iv(N[2 * i]!, es - 1, !!U) + iv(N[2 * i + 1]!, es - 1, !!U), es))
    },
  })
}

// URECPE, URSQRTE (32-bit only), SQABS, SQNEG.
for (const [m, bits, desc, fn] of [
  ['urecpe', '0 00 0', T('无符号定点数的倒数估计值', 'unsigned reciprocal estimate (fixed point)'), (v: bigint) => (v >> 31n === 0n ? 0xffffffffn : BigInt(sf.recipEstimate(Number(v >> 23n), false) & 0x1ff) << 23n)],
  ['ursqrte', '0 00 1', T('无符号定点数的平方根倒数估计值', 'unsigned reciprocal square root estimate (fixed point)'), (v: bigint) => (v >> 30n === 0n ? 0xffffffffn : BigInt(sf.recipSqrtEstimate(Number(v >> 23n), false) & 0x1ff) << 23n)],
] as const)
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2',
    bits: `01000100 10 00 ${bits} 101 Pg:3 Zn:5 Zd:5`,
    syntax: '<Zd.s>, <Pg/m>, <Zn.s>',
    desc: T(`活跃元素的${desc.zh}`, `The ${desc.en} of the active elements`),
    exec(c, f) {
      const N = zget(c, f.Zn!, 2)
      predicated(c, f.Zd!, 2, pget(c, f.Pg!, 2), true, (i) => fn(N[i]!))
    },
  })
for (const [m, op] of [
  ['sqabs', 0],
  ['sqneg', 1],
] as const)
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2',
    bits: `01000100 size:2 00 1 00 ${op} 101 Pg:3 Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Pg/m>, <Zn.size>',
    desc: op ? T('活跃元素的饱和取负（最小值取负得最大值）', 'Saturating negate of the active elements (the minimum becomes the maximum)') : T('活跃元素的饱和绝对值（最小值的绝对值得最大值）', 'Saturating absolute value of the active elements (the minimum gives the maximum)'),
    exec(c, f) {
      const es = f.size!
      const N = zget(c, f.Zn!, es)
      predicated(c, f.Zd!, es, pget(c, f.Pg!, es), true, (i) => {
        const v = sx(N[i]!, es)
        return satv(op ? -v : v < 0n ? -v : v, es, false)
      })
    },
  })


// Shifts by vector: bits 19:16 = Q (saturate), N (reversed operands), R (round), U.
for (let q = 0; q < 2; q++)
  for (let n = 0; n < 2; n++)
    for (let r = 0; r < 2; r++)
      for (let u = 0; u < 2; u++) {
        if (!q && !r) continue
        const m = `${u ? 'u' : 's'}${q ? 'q' : ''}${r ? 'r' : ''}shl${n ? 'r' : ''}`
        INSTRS.push({
          id: `sve-${m}`,
          mnemonic: m,
          group: G,
          feature: 'sve2',
          bits: `01000100 size:2 00 ${q}${n}${r}${u} 100 Pg:3 Zm:5 Zdn:5`,
          syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>',
          desc: T(
            `${u ? '无' : '有'}符号${q ? '饱和' : ''}${r ? '舍入' : ''}移位：${n ? 'Zm 按 Zdn' : 'Zdn 按 Zm'} 的元素（最低字节，有符号）移位，正数左移、负数右移`,
            `${u ? 'Unsigned' : 'Signed'}${q ? ' saturating' : ''}${r ? ' rounding' : ''} shift: ${n ? 'Zm by Zdn' : 'Zdn by Zm'} (the low byte, signed): left when positive, right when negative`,
          ),
          exec: (c, f) => pred2(c, f, f.size!, (a, b) => (n ? shiftSve(b, a, f.size!, !!u, !!r, !!q) : shiftSve(a, b, f.size!, !!u, !!r, !!q))),
        })
      }

// Halving add/subtract: bits 18:16 = R, S, U with S/R meaning (sub, reversed) when R… see table.
for (const [m, b3, desc, fn] of [
  ['shadd', '000', T('有符号半加 (a + b) >> 1', 'signed halving add (a + b) >> 1'), (a: bigint, b: bigint) => (a + b) >> 1n],
  ['uhadd', '001', T('无符号半加', 'unsigned halving add'), (a: bigint, b: bigint) => (a + b) >> 1n],
  ['shsub', '010', T('有符号半减 (a − b) >> 1', 'signed halving subtract (a − b) >> 1'), (a: bigint, b: bigint) => (a - b) >> 1n],
  ['uhsub', '011', T('无符号半减', 'unsigned halving subtract'), (a: bigint, b: bigint) => (a - b) >> 1n],
  ['srhadd', '100', T('有符号舍入半加 (a + b + 1) >> 1', 'signed rounding halving add (a + b + 1) >> 1'), (a: bigint, b: bigint) => (a + b + 1n) >> 1n],
  ['urhadd', '101', T('无符号舍入半加', 'unsigned rounding halving add'), (a: bigint, b: bigint) => (a + b + 1n) >> 1n],
  ['shsubr', '110', T('反向有符号半减 (b − a) >> 1', 'reversed signed halving subtract (b − a) >> 1'), (a: bigint, b: bigint) => (b - a) >> 1n],
  ['uhsubr', '111', T('反向无符号半减', 'reversed unsigned halving subtract'), (a: bigint, b: bigint) => (b - a) >> 1n],
] as const) {
  const U = b3[2] === '1'
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2',
    bits: `01000100 size:2 010 ${b3} 100 Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>',
    desc: T(`活跃元素的${desc.zh}`, `The ${desc.en} of the active elements`),
    exec: (c, f) => pred2(c, f, f.size!, (a, b) => ux(fn(iv(a, f.size!, U), iv(b, f.size!, U)), f.size!)),
  })
}

// Pairwise: even results from Zdn's pairs, odd results from Zm's.
for (const [m, b3, desc, fn] of [
  ['addp', '001', T('加', 'add'), (a: bigint, b: bigint) => a + b],
  ['smaxp', '100', T('有符号最大值', 'signed maximum'), (a: bigint, b: bigint) => (a > b ? a : b)],
  ['umaxp', '101', T('无符号最大值', 'unsigned maximum'), (a: bigint, b: bigint) => (a > b ? a : b)],
  ['sminp', '110', T('有符号最小值', 'signed minimum'), (a: bigint, b: bigint) => (a < b ? a : b)],
  ['uminp', '111', T('无符号最小值', 'unsigned minimum'), (a: bigint, b: bigint) => (a < b ? a : b)],
] as const) {
  const U = b3[2] === '1'
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2',
    bits: `01000100 size:2 010 ${b3} 101 Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>',
    desc: T(`相邻元素两两${desc.zh}：偶数号结果来自 Zdn 的一对，奇数号来自 Zm 的一对`, `Pairwise ${desc.en} of adjacent elements: even results from pairs of Zdn, odd results from pairs of Zm`),
    exec(c, f) {
      const es = f.size!
      pred2(c, f, es, (_a, _b, i, A, B) => {
        const [x, y] = i % 2 === 0 ? [A[i]!, A[i + 1]!] : [B[i - 1]!, B[i]!]
        return ux(fn(iv(x, es, U), iv(y, es, U)), es)
      })
    },
  })
}

// Saturating add/subtract, predicated.
for (const [m, b3, desc, fn] of [
  ['sqadd', '000', T('有符号饱和加', 'signed saturating add'), (a: bigint, b: bigint, es: number) => satv(sx(a, es) + sx(b, es), es, false)],
  ['uqadd', '001', T('无符号饱和加', 'unsigned saturating add'), (a: bigint, b: bigint, es: number) => satv(a + b, es, true)],
  ['sqsub', '010', T('有符号饱和减', 'signed saturating subtract'), (a: bigint, b: bigint, es: number) => satv(sx(a, es) - sx(b, es), es, false)],
  ['uqsub', '011', T('无符号饱和减', 'unsigned saturating subtract'), (a: bigint, b: bigint, es: number) => satv(a - b, es, true)],
  ['suqadd', '100', T('有符号数加无符号数，按有符号饱和', 'signed plus unsigned, saturating as signed'), (a: bigint, b: bigint, es: number) => satv(sx(a, es) + b, es, false)],
  ['usqadd', '101', T('无符号数加有符号数，按无符号饱和', 'unsigned plus signed, saturating as unsigned'), (a: bigint, b: bigint, es: number) => satv(a + sx(b, es), es, true)],
  ['sqsubr', '110', T('反向有符号饱和减（Zm − Zdn）', 'reversed signed saturating subtract (Zm − Zdn)'), (a: bigint, b: bigint, es: number) => satv(sx(b, es) - sx(a, es), es, false)],
  ['uqsubr', '111', T('反向无符号饱和减', 'reversed unsigned saturating subtract'), (a: bigint, b: bigint, es: number) => satv(b - a, es, true)],
] as const)
  INSTRS.push({
    id: `sve-${m}-pred`,
    mnemonic: m,
    group: G,
    feature: 'sve2',
    bits: `01000100 size:2 011 ${b3} 100 Pg:3 Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Pg/m>, <Zdn.size>, <Zm.size>',
    desc: T(`活跃元素的${desc.zh}`, `The ${desc.en} of the active elements`),
    exec: (c, f) => pred2(c, f, f.size!, (a, b) => fn(a, b, f.size!)),
  })

/* ------------------------------------------------------------------ widening, wide and narrowing */

/** The narrow elements of n at positions 2i + T, for every wide element i. */
const half = (c: Cpu, n: number, es: number, T_: number) => zget(c, n, es - 1).filter((_, k) => k % 2 === T_)
const BT = (T_: number) => (T_ ? T('奇数号（高半）', 'odd (top)') : T('偶数号（低半）', 'even (bottom)'))

/** A wide result from the bottom or top narrow elements of Zn and Zm. */
function long(m: string, bits: string, feature: string, desc: (T_: number) => Text, fn: (a: bigint, b: bigint, es: number, d: bigint) => bigint, opts: { acc?: boolean; tn?: number; tm?: number; valid?: string } = {}): void {
  for (const T_ of [0, 1]) {
    const name = opts.tn === undefined ? `${m}${T_ ? 't' : 'b'}` : m
    if (opts.tn !== undefined && T_) continue
    INSTRS.push({
      id: `sve-${name}`,
      mnemonic: name,
      group: G,
      feature,
      bits: bits.replace('T', String(T_)),
      syntax: opts.acc ? '<Zda.size>, <Zn.size-1>, <Zm.size-1>' : '<Zd.size>, <Zn.size-1>, <Zm.size-1>',
      valid: sizes(opts.valid ?? 'hsd'),
      desc: desc(T_),
      exec(c, f) {
        const es = f.size!
        const A = half(c, f.Zn!, es, opts.tn ?? T_)
        const B = half(c, f.Zm!, es, opts.tm ?? T_)
        const d = opts.acc ? f.Zda! : f.Zd!
        const D = opts.acc ? zget(c, d, es) : null
        zset(c, d, A.map((a, i) => ux(fn(a, B[i]!, es, D ? D[i]! : 0n), es)), es)
      },
    })
  }
}
const n1 = (v: bigint, es: number, U: boolean) => iv(v, es - 1, U)
for (const [op, mo, zh, en] of [
  [0, 'add', '相加', 'Add'],
  [1, 'sub', '相减', 'Subtract'],
  [3, 'abd', '差的绝对值', 'Absolute difference of'],
] as const)
  for (const U of [false, true]) {
    long(
      `${U ? 'u' : 's'}${mo}l`,
      `01000101 size:2 0 Zm:5 00 ${bin(op, 2)} ${U ? 1 : 0} T Zn:5 Zd:5`,
      'sve2',
      (T_) => T(`Zn、Zm 的${BT(T_).zh}${U ? '无' : '有'}符号元素${zh}，结果加宽`, `${en} the ${BT(T_).en} ${U ? 'unsigned' : 'signed'} elements of Zn and Zm, widened`),
      (a, b, es) => {
        const x = n1(a, es, U)
        const y = n1(b, es, U)
        return op === 0 ? x + y : op === 1 ? x - y : x > y ? x - y : y - x
      },
    )
  }
// Wide: Zd = Zn (wide) ± Zm's bottom or top narrow elements.
for (const [S, U] of [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
] as const)
  for (const T_ of [0, 1]) {
    const m = `${U ? 'u' : 's'}${S ? 'sub' : 'add'}w${T_ ? 't' : 'b'}`
    INSTRS.push({
      id: `sve-${m}`,
      mnemonic: m,
      group: G,
      feature: 'sve2',
      bits: `01000101 size:2 0 Zm:5 010 ${S}${U}${T_} Zn:5 Zd:5`,
      syntax: '<Zd.size>, <Zn.size>, <Zm.size-1>',
      valid: sizes('hsd'),
      desc: T(`宽元素 Zn ${S ? '减去' : '加上'} Zm 的${BT(T_).zh}${U ? '无' : '有'}符号窄元素`, `Wide elements of Zn ${S ? 'minus' : 'plus'} the ${BT(T_).en} ${U ? 'unsigned' : 'signed'} narrow elements of Zm`),
      exec(c, f) {
        const es = f.size!
        const B = half(c, f.Zm!, es, T_)
        zset(c, f.Zd!, zget(c, f.Zn!, es).map((a, i) => ux(S ? a - n1(B[i]!, es, !!U) : a + n1(B[i]!, es, !!U), es)), es)
      },
    })
  }
// Multiply long: sqdmull, pmull, smull, umull.
long('sqdmull', '01000101 size:2 0 Zm:5 011 0 0 T Zn:5 Zd:5', 'sve2', (T_) => T(`Zn、Zm 的${BT(T_).zh}有符号元素相乘再乘 2，饱和成宽元素`, `Multiply the ${BT(T_).en} signed elements of Zn and Zm, doubled and saturated to wide elements`), (a, b, es) => satv(2n * n1(a, es, false) * n1(b, es, false), es, false))
long('smull', '01000101 size:2 0 Zm:5 011 1 0 T Zn:5 Zd:5', 'sve2', (T_) => T(`Zn、Zm 的${BT(T_).zh}有符号元素相乘，结果加宽`, `Multiply the ${BT(T_).en} signed elements of Zn and Zm, widened`), (a, b, es) => n1(a, es, false) * n1(b, es, false))
long('umull', '01000101 size:2 0 Zm:5 011 1 1 T Zn:5 Zd:5', 'sve2', (T_) => T(`Zn、Zm 的${BT(T_).zh}无符号元素相乘，结果加宽`, `Multiply the ${BT(T_).en} unsigned elements of Zn and Zm, widened`), (a, b) => a * b)
long('pmull', '01000101 size:2 0 Zm:5 011 0 1 T Zn:5 Zd:5', 'sve2', (T_) => T(`Zn、Zm 的${BT(T_).zh}元素做多项式（无进位）乘法，结果加宽`, `Polynomial (carry-less) multiply of the ${BT(T_).en} elements of Zn and Zm, widened`), (a, b, es) => polyMul(a, b, ESIZE[es - 1]!), { valid: 'hd' })
for (const T_ of [0, 1])
  INSTRS.push({
    id: `sve-pmull${T_ ? 't' : 'b'}-q`,
    mnemonic: `pmull${T_ ? 't' : 'b'}`,
    group: G,
    feature: 'sve2-aes',
    bits: `01000101 00 0 Zm:5 011 0 1 ${T_} Zn:5 Zd:5`,
    syntax: '<Zd.q>, <Zn.d>, <Zm.d>',
    desc: T(`Zn、Zm 的${BT(T_).zh} 64 位元素做多项式乘法，得到 128 位结果`, `Polynomial multiply of the ${BT(T_).en} 64-bit elements of Zn and Zm into 128-bit results`),
    exec(c, f) {
      const A = half(c, f.Zn!, 4, T_)
      const B = half(c, f.Zm!, 4, T_)
      zset(c, f.Zd!, A.map((a, i) => polyMul(a, B[i]!, 64)), 4)
    },
  })
// Mixed bottom/top.
for (const [m, b, tn, tm, sub] of [
  ['saddlbt', '0', 0, 1, false],
  ['ssublbt', '10', 0, 1, true],
  ['ssubltb', '11', 1, 0, true],
] as const)
  long(m, `01000101 size:2 0 Zm:5 1000 ${b.length === 1 ? '0' + b : b} Zn:5 Zd:5`, 'sve2', () => T(`Zn 的${BT(tn).zh}有符号元素${sub ? '减去' : '加上'} Zm 的${BT(tm).zh}有符号元素，结果加宽`, `The ${BT(tn).en} signed elements of Zn ${sub ? 'minus' : 'plus'} the ${BT(tm).en} signed elements of Zm, widened`), (a, bb, es) => (sub ? n1(a, es, false) - n1(bb, es, false) : n1(a, es, false) + n1(bb, es, false)), { tn, tm })
// Absolute difference and accumulate long.
for (const U of [false, true])
  long(
    `${U ? 'u' : 's'}abal`,
    `01000101 size:2 0 Zm:5 1100 ${U ? 1 : 0} T Zn:5 Zda:5`,
    'sve2',
    (T_) => T(`Zn、Zm 的${BT(T_).zh}${U ? '无' : '有'}符号元素之差的绝对值，加到 Zda 的宽元素`, `Add the absolute difference of the ${BT(T_).en} ${U ? 'unsigned' : 'signed'} elements of Zn and Zm to the wide elements of Zda`),
    (a, b, es, d) => {
      const x = n1(a, es, U)
      const y = n1(b, es, U)
      return d + (x > y ? x - y : y - x)
    },
    { acc: true },
  )
// Multiply-add long.
for (const [S, U] of [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
] as const)
  long(
    `${U ? 'u' : 's'}ml${S ? 's' : 'a'}l`,
    `01000100 size:2 0 Zm:5 010 ${S}${U}T Zn:5 Zda:5`,
    'sve2',
    (T_) => T(`Zn、Zm 的${BT(T_).zh}${U ? '无' : '有'}符号元素相乘，${S ? '从 Zda 的宽元素减去' : '加到 Zda 的宽元素'}`, `Multiply the ${BT(T_).en} ${U ? 'unsigned' : 'signed'} elements of Zn and Zm and ${S ? 'subtract from' : 'add to'} the wide elements of Zda`),
    (a, b, es, d) => (S ? d - n1(a, es, !!U) * n1(b, es, !!U) : d + n1(a, es, !!U) * n1(b, es, !!U)),
    { acc: true },
  )
/** SQDMLAL: acc ± sat(2ab), saturated again. */
const sqdml = (S: boolean) => (a: bigint, b: bigint, es: number, d: bigint) => {
  const p = satv(2n * n1(a, es, false) * n1(b, es, false), es, false)
  return satv(S ? sx(d, es) - sx(p, es) : sx(d, es) + sx(p, es), es, false)
}
for (const S of [false, true]) {
  long(`sqdml${S ? 's' : 'a'}l`, `01000100 size:2 0 Zm:5 0110 ${S ? 1 : 0} T Zn:5 Zda:5`, 'sve2', (T_) => T(`Zn、Zm 的${BT(T_).zh}有符号元素相乘再乘 2（饱和），${S ? '从 Zda 减去' : '加到 Zda'}（再饱和）`, `Multiply the ${BT(T_).en} signed elements of Zn and Zm, doubled and saturated, and ${S ? 'subtract from' : 'add to'} Zda (saturating)`), sqdml(S), { acc: true })
  long(`sqdml${S ? 's' : 'a'}lbt`, `01000100 size:2 0 Zm:5 00001 ${S ? 1 : 0} Zn:5 Zda:5`, 'sve2', () => T(`Zn 的偶数号与 Zm 的奇数号有符号元素相乘再乘 2（饱和），${S ? '从 Zda 减去' : '加到 Zda'}（再饱和）`, `Multiply the even signed elements of Zn by the odd ones of Zm, doubled and saturated, and ${S ? 'subtract from' : 'add to'} Zda (saturating)`), sqdml(S), { acc: true, tn: 0, tm: 1 })
}

/* ------------------------------------------------------------------ narrowing */

/** Bottom forms write the even narrow elements and zero the odd ones; top forms write the odd ones and keep the even. */
function narrow(c: Cpu, d: number, es: number, vals: bigint[], top: number): void {
  const D = zget(c, d, es - 1)
  zset(c, d, D.map((old, k) => (k % 2 === top ? ux(vals[k >> 1]!, es - 1) : top ? old : 0n)), es - 1)
}
const tsz3 = (f: Fields) => (f.tszh! << 2) | f.tszl!
/** A narrow element size of a byte, halfword or word fits tszh:tszl (3 bits); a larger one leaves tsz zero, which `valid` rejects. */
const narrowFits = (f: Fields) => {
  if ((f._es ?? 0) > 2) f.tszh = f.tszl = 0
}
const NB = (T_: number) => (T_ ? T('奇数号窄元素（偶数号不变）', 'odd narrow elements (the even ones are kept)') : T('偶数号窄元素（奇数号清零）', 'even narrow elements (the odd ones become zero)'))

for (const S of [0, 1])
  for (const R of [0, 1])
    for (const T_ of [0, 1]) {
      const m = `${R ? 'r' : ''}${S ? 'sub' : 'add'}hn${T_ ? 't' : 'b'}`
      INSTRS.push({
        id: `sve-${m}`,
        mnemonic: m,
        group: G,
        feature: 'sve2',
        bits: `01000101 size:2 1 Zm:5 011 ${S}${R}${T_} Zn:5 Zd:5`,
        syntax: '<Zd.size-1>, <Zn.size>, <Zm.size>',
        valid: sizes('hsd'),
        desc: T(`Zn ${S ? '减' : '加'} Zm${R ? '（舍入）' : ''}，取高半写入 Zd 的${NB(T_).zh}`, `Zn ${S ? 'minus' : 'plus'} Zm${R ? ', rounded' : ''}; the high halves go to the ${NB(T_).en} of Zd`),
        exec(c, f) {
          const es = f.size!
          const h = ESN(es) / 2n
          const B = zget(c, f.Zm!, es)
          const round = R ? 1n << (h - 1n) : 0n
          narrow(c, f.Zd!, es, zget(c, f.Zn!, es).map((a, i) => ((S ? a - B[i]! : a + B[i]!) + round) >> h), T_)
        },
      })
    }

// Shift right narrow: bits 13:12 pick saturation, bit 11 rounding, bit 10 top.
for (const [op, kind, inU, out] of [
  [0, 'sqshrun', false, 'u'],
  [1, 'shrn', false, ''],
  [2, 'sqshrn', false, 's'],
  [3, 'uqshrn', true, 'u'],
] as const)
  for (const R of [0, 1])
    for (const T_ of [0, 1]) {
      const m = (R ? kind.replace('shr', 'rshr') : kind) + (T_ ? 't' : 'b')
      const how = out === 'u' ? T('饱和成无符号数', 'saturated to unsigned') : out === 's' ? T('饱和成有符号数', 'saturated to signed') : T('截断', 'truncated')
      INSTRS.push({
        id: `sve-${m}`,
        mnemonic: m,
        group: G,
        feature: 'sve2',
        bits: `01000101 0 tszh:1 1 tszl:2 imm3:3 00 ${bin(op, 2)} ${R} ${T_} Zn:5 Zd:5`,
        syntax: '<Zd.tsz>, <Zn.tsz+1>, #<tsr>',
        valid: (f) => tsz3(f) !== 0,
        encode: narrowFits,
        desc: T(`Zn 的${inU ? '无' : '有'}符号宽元素${R ? '舍入' : ''}右移，${how.zh}，写入 Zd 的${NB(T_).zh}`, `Shift the ${inU ? 'unsigned' : 'signed'} wide elements of Zn right${R ? ' with rounding' : ''}, ${how.en}, into the ${NB(T_).en} of Zd`),
        exec(c, f) {
          const { es, sh } = tshAmount(f, true, tsz3(f))
          const s = BigInt(sh)
          const round = R ? 1n << (s - 1n) : 0n
          const vals = zget(c, f.Zn!, es + 1).map((a) => {
            const v = (iv(a, es + 1, inU) + round) >> s
            return out ? satv(v, es, out === 'u') : v
          })
          narrow(c, f.Zd!, es + 1, vals, T_)
        },
      })
    }

// Saturating extract narrow.
for (const [opc, m0, inU, outU] of [
  [0, 'sqxtn', false, false],
  [1, 'uqxtn', true, true],
  [2, 'sqxtun', false, true],
] as const)
  for (const T_ of [0, 1]) {
    const m = m0 + (T_ ? 't' : 'b')
    INSTRS.push({
      id: `sve-${m}`,
      mnemonic: m,
      group: G,
      feature: 'sve2',
      bits: `01000101 0 tszh:1 1 tszl:2 000 010 ${bin(opc, 2)} ${T_} Zn:5 Zd:5`,
      syntax: '<Zd.tsz>, <Zn.tsz+1>',
      valid: (f) => [1, 2, 4].includes(tsz3(f)),
      encode(f) {
        const t = (f._es ?? 0) > 2 ? 0 : 1 << f._es!
        f.tszh = t >> 2
        f.tszl = t & 3
      },
      desc: T(`Zn 的${inU ? '无' : '有'}符号宽元素饱和成${outU ? '无' : '有'}符号窄元素，写入 Zd 的${NB(T_).zh}`, `Saturate the ${inU ? 'unsigned' : 'signed'} wide elements of Zn to ${outU ? 'unsigned' : 'signed'} narrow ones, into the ${NB(T_).en} of Zd`),
      exec(c, f) {
        const es = highBit(tsz3(f))
        narrow(c, f.Zd!, es + 1, zget(c, f.Zn!, es + 1).map((a) => satv(iv(a, es + 1, inU), es, outU)), T_)
      },
    })
  }

// Shift left long.
for (const U of [0, 1])
  for (const T_ of [0, 1]) {
    const m = `${U ? 'u' : 's'}shll${T_ ? 't' : 'b'}`
    INSTRS.push({
      id: `sve-${m}`,
      mnemonic: m,
      group: G,
      feature: 'sve2',
      bits: `01000101 0 tszh:1 0 tszl:2 imm3:3 1010 ${U} ${T_} Zn:5 Zd:5`,
      syntax: '<Zd.tsz+1>, <Zn.tsz>, #<tsl>',
      valid: (f) => tsz3(f) !== 0,
      encode: narrowFits,
      desc: T(`Zn 的${BT(T_).zh}${U ? '无' : '有'}符号窄元素加宽后左移`, `Widen the ${BT(T_).en} ${U ? 'unsigned' : 'signed'} narrow elements of Zn and shift them left`),
      exec(c, f) {
        const { es, sh } = tshAmount(f, false, tsz3(f))
        zset(c, f.Zd!, half(c, f.Zn!, es + 1, T_).map((a) => ux(iv(a, es, !!U) << BigInt(sh), es + 1)), es + 1)
      },
    })
  }

/* ------------------------------------------------------------------ shift and accumulate, shift and insert, XAR */

const tsz4 = (f: Fields) => (f.tszh! << 2) | f.tszl!
for (const R of [0, 1])
  for (const U of [0, 1]) {
    const m = `${U ? 'u' : 's'}${R ? 'r' : ''}sra`
    INSTRS.push({
      id: `sve-${m}`,
      mnemonic: m,
      group: G,
      feature: 'sve2',
      bits: `01000101 tszh:2 0 tszl:2 imm3:3 1110 ${R} ${U} Zn:5 Zda:5`,
      syntax: '<Zda.tsz>, <Zn.tsz>, #<tsr>',
      valid: (f) => tsz4(f) !== 0,
      desc: T(`Zn 的${U ? '无' : '有'}符号元素${R ? '舍入' : ''}右移，加到 Zda`, `Shift the ${U ? 'unsigned' : 'signed'} elements of Zn right${R ? ' with rounding' : ''} and add to Zda`),
      exec(c, f) {
        const { es, sh } = tshAmount(f, true, tsz4(f))
        const s = BigInt(sh)
        const round = R ? 1n << (s - 1n) : 0n
        const N = zget(c, f.Zn!, es)
        zset(c, f.Zda!, zget(c, f.Zda!, es).map((d, i) => ux(d + ((iv(N[i]!, es, !!U) + round) >> s), es)), es)
      },
    })
  }
for (const L_ of [0, 1])
  INSTRS.push({
    id: `sve-${L_ ? 'sli' : 'sri'}`,
    mnemonic: L_ ? 'sli' : 'sri',
    group: G,
    feature: 'sve2',
    bits: `01000101 tszh:2 0 tszl:2 imm3:3 11110 ${L_} Zn:5 Zd:5`,
    syntax: `<Zd.tsz>, <Zn.tsz>, #<${L_ ? 'tsl' : 'tsr'}>`,
    valid: (f) => tsz4(f) !== 0,
    desc: L_ ? T('Zn 的元素左移后插入 Zd：Zd 低端移空的位保持不变', 'Shift the elements of Zn left and insert them into Zd: the low bits shifted out of the way keep Zd’s value') : T('Zn 的元素右移后插入 Zd：Zd 高端移空的位保持不变', 'Shift the elements of Zn right and insert them into Zd: the high bits shifted out of the way keep Zd’s value'),
    exec(c, f) {
      const { es, sh } = tshAmount(f, !L_, tsz4(f))
      const s = BigInt(sh)
      const full = maskEs(es)
      const mask = L_ ? (full << s) & full : full >> s
      const N = zget(c, f.Zn!, es)
      zset(c, f.Zd!, zget(c, f.Zd!, es).map((d, i) => (d & ~mask & full) | ((L_ ? N[i]! << s : N[i]! >> s) & mask)), es)
    },
  })
INSTRS.push({
  id: 'sve-xar',
  mnemonic: 'xar',
  group: G,
  feature: 'sve2',
  bits: '00000100 tszh:2 1 tszl:2 imm3:3 001101 Zm:5 Zdn:5',
  syntax: '<Zdn.tsz>, <Zdn.tsz>, <Zm.tsz>, #<tsr>',
  valid: (f) => tsz4(f) !== 0,
  desc: T('Zdn 与 Zm 按位异或，再循环右移', 'Exclusive OR of Zdn and Zm, then rotate right'),
  exec(c, f) {
    const { es, sh } = tshAmount(f, true, tsz4(f))
    const s = BigInt(sh)
    const full = maskEs(es)
    const M = zget(c, f.Zm!, es)
    zset(c, f.Zdn!, zget(c, f.Zdn!, es).map((a, i) => {
      const x = a ^ M[i]!
      return ((x >> s) | (x << (ESN(es) - s))) & full
    }), es)
  },
})

/* ------------------------------------------------------------------ multiplies: saturating doubling, by vector */

const perSeg = (es: number) => 128 / ESIZE[es]!
/** For element i, element `idx` of the same 128-bit segment of M. */
const segElem = (M: bigint[], es: number, i: number, idx: number) => M[i - (i % perSeg(es)) + idx]!
/** SQRDMLAH / SQRDMLSH: (acc << esize) ± 2ab, rounded, high half, saturated. */
const rdmlah = (d: bigint, a: bigint, b: bigint, es: number, sub: boolean) => {
  const E = ESN(es)
  const p = 2n * sx(a, es) * sx(b, es)
  return satv(((sx(d, es) << E) + (sub ? -p : p) + (1n << (E - 1n))) >> E, es, false)
}
const dmulh = (a: bigint, b: bigint, es: number, round: boolean) => {
  const E = ESN(es)
  return satv((2n * sx(a, es) * sx(b, es) + (round ? 1n << (E - 1n) : 0n)) >> E, es, false)
}

for (const R of [0, 1])
  INSTRS.push({
    id: `sve-sq${R ? 'r' : ''}dmulh`,
    mnemonic: `sq${R ? 'r' : ''}dmulh`,
    group: G,
    feature: 'sve2',
    bits: `00000100 size:2 1 Zm:5 01110 ${R} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc: T(`有符号相乘再乘 2${R ? '，舍入' : ''}，取高半（饱和）`, `Signed multiply, doubled${R ? ', rounded' : ''}, high half (saturating)`),
    exec(c, f) {
      const es = f.size!
      const B = zget(c, f.Zm!, es)
      zset(c, f.Zd!, zget(c, f.Zn!, es).map((a, i) => dmulh(a, B[i]!, es, !!R)), es)
    },
  })
for (const S of [0, 1])
  INSTRS.push({
    id: `sve-sqrdml${S ? 's' : 'a'}h`,
    mnemonic: `sqrdml${S ? 's' : 'a'}h`,
    group: G,
    feature: 'sve2',
    bits: `01000100 size:2 0 Zm:5 01110 ${S} Zn:5 Zda:5`,
    syntax: '<Zda.size>, <Zn.size>, <Zm.size>',
    desc: T(`Zn × Zm 乘 2 后${S ? '从 Zda 减去' : '加到 Zda'}（Zda 先左移一个元素宽），舍入取高半（饱和）`, `${S ? 'Subtract' : 'Add'} 2 × Zn × Zm ${S ? 'from' : 'to'} Zda (Zda taken as the high half), rounded, high half (saturating)`),
    exec(c, f) {
      const es = f.size!
      const A = zget(c, f.Zn!, es)
      const B = zget(c, f.Zm!, es)
      zset(c, f.Zda!, zget(c, f.Zda!, es).map((d, i) => rdmlah(d, A[i]!, B[i]!, es, !!S)), es)
    },
  })

/* ------------------------------------------------------------------ complex integer arithmetic */

/** The products rotation `rot` (0, 90, 180, 270) adds to the real and imaginary parts, as in FCMLA. */
function cmlaTerms(rot: number, nr: bigint, ni: bigint, mr: bigint, mi: bigint): [bigint, bigint] {
  if (rot === 0) return [nr * mr, nr * mi]
  if (rot === 1) return [-(ni * mi), ni * mr]
  if (rot === 2) return [-(nr * mr), -(nr * mi)]
  return [ni * mi, -(ni * mr)]
}
function cmla(c: Cpu, f: Fields, es: number, mPair: (p: number) => [bigint, bigint], rdm: boolean): void {
  const N = zget(c, f.Zn!, es).map((v) => sx(v, es))
  const D = zget(c, f.Zda!, es)
  const E = ESN(es)
  const R = D.slice()
  for (let p = 0; p < N.length / 2; p++) {
    const [mr, mi] = mPair(p)
    const t = cmlaTerms(f.rot!, N[2 * p]!, N[2 * p + 1]!, sx(mr, es), sx(mi, es))
    for (const k of [0, 1]) {
      const d = sx(D[2 * p + k]!, es)
      R[2 * p + k] = rdm ? satv(((d << E) + 2n * t[k]! + (1n << (E - 1n))) >> E, es, false) : ux(d + t[k]!, es)
    }
  }
  zset(c, f.Zda!, R, es)
}
const CMLA_DESC = (rdm: boolean) =>
  rdm
    ? T('饱和舍入复数乘加取高半：每对元素是（实部，虚部），Zn × Zm 旋转 #rot 度后的一部分乘 2 加到 Zda，取高半', 'Saturating rounding complex multiply-add, high half: element pairs are (real, imaginary); twice one part of Zn × Zm rotated by #rot is added to Zda, keeping the high half')
    : T('复数整数乘加：每对元素是（实部，虚部），把 Zn × Zm 旋转 #rot 度后的一部分加到 Zda', 'Complex integer multiply-add: element pairs are (real, imaginary); adds one part of Zn × Zm rotated by #rot to Zda')
for (const rdm of [0, 1]) {
  const m = rdm ? 'sqrdcmlah' : 'cmla'
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2',
    bits: `01000100 size:2 0 Zm:5 001${rdm} rot:2 Zn:5 Zda:5`,
    syntax: '<Zda.size>, <Zn.size>, <Zm.size>, #<rot:rot>',
    desc: CMLA_DESC(!!rdm),
    exec(c, f) {
      const M = zget(c, f.Zm!, f.size!)
      cmla(c, f, f.size!, (p) => [M[2 * p]!, M[2 * p + 1]!], !!rdm)
    },
  })
  for (const [es, head, idx] of [
    [1, '10 1 i2:2 Zm:3', 'i2'],
    [2, '11 1 i1 Zm:4', 'i1'],
  ] as const)
    INSTRS.push({
      id: `sve-${m}-idx-${LET[es]}`,
      mnemonic: m,
      group: G,
      feature: 'sve2',
      bits: `01000100 ${head} 011${rdm} rot:2 Zn:5 Zda:5`,
      syntax: `<Zda.${LET[es]}>, <Zn.${LET[es]}>, <Zm.${LET[es]}[${idx}]>, #<rot:rot>`,
      desc: T(`${CMLA_DESC(!!rdm).zh}；Zm 取每 128 位段里的第 i 对`, `${CMLA_DESC(!!rdm).en}; Zm is pair i of each 128-bit segment`),
      exec(c, f) {
        const M = zget(c, f.Zm!, es)
        const k = es === 1 ? f.i2! : f.i1!
        const pairs = perSeg(es) / 2
        cmla(c, f, es, (p) => {
          const base = (p - (p % pairs) + k) * 2
          return [M[base]!, M[base + 1]!]
        }, !!rdm)
      },
    })
}

/** CDOT: each wide element accumulates two complex products of narrow (real, imaginary) pairs. */
function cdot(c: Cpu, f: Fields, es: number, quad: (e: number) => bigint[]): void {
  const ne = es - 2
  const N = zget(c, f.Zn!, ne).map((v) => sx(v, ne))
  const rot = f.rot!
  const [sa, sb, sub] = rot === 0 ? [0, 1, true] : rot === 1 ? [1, 0, false] : rot === 2 ? [0, 1, false] : [1, 0, true]
  zset(c, f.Zda!, zget(c, f.Zda!, es).map((d, e) => {
    const M = quad(e).map((v) => sx(v, ne))
    let r = sx(d, es)
    for (let i = 0; i < 2; i++) {
      r += N[4 * e + 2 * i]! * M[2 * i + sa]!
      const p = N[4 * e + 2 * i + 1]! * M[2 * i + sb]!
      r = sub ? r - p : r + p
    }
    return ux(r, es)
  }), es)
}
const CDOT_DESC = T('复数整数点积：Zn、Zm 每 4 个窄元素是两个复数（实部，虚部），两对复数积旋转 #rot 度后的一部分加到 Zda 的宽元素', 'Complex integer dot product: every 4 narrow elements of Zn and Zm are two complex numbers (real, imaginary); one part of the two products, rotated by #rot, is added to the wide element of Zda')
INSTRS.push({
  id: 'sve-cdot',
  mnemonic: 'cdot',
  group: G,
  feature: 'sve2',
  bits: '01000100 size:2 0 Zm:5 0001 rot:2 Zn:5 Zda:5',
  syntax: '<Zda.size>, <Zn.size-2>, <Zm.size-2>, #<rot:rot>',
  valid: sizes('sd'),
  desc: CDOT_DESC,
  exec(c, f) {
    const M = zget(c, f.Zm!, f.size! - 2)
    cdot(c, f, f.size!, (e) => M.slice(4 * e, 4 * e + 4))
  },
})
for (const [es, head, idx] of [
  [2, '10 1 i2:2 Zm:3', 'i2'],
  [3, '11 1 i1 Zm:4', 'i1'],
] as const)
  INSTRS.push({
    id: `sve-cdot-idx-${LET[es]}`,
    mnemonic: 'cdot',
    group: G,
    feature: 'sve2',
    bits: `01000100 ${head} 0100 rot:2 Zn:5 Zda:5`,
    syntax: `<Zda.${LET[es]}>, <Zn.${LET[es - 2]}>, <Zm.${LET[es - 2]}[${idx}]>, #<rot:rot>`,
    desc: T(`${CDOT_DESC.zh}；Zm 取每 128 位段里的第 i 组`, `${CDOT_DESC.en}; Zm is group i of each 128-bit segment`),
    exec(c, f) {
      const M = zget(c, f.Zm!, es - 2)
      const k = es === 2 ? f.i2! : f.i1!
      cdot(c, f, es, (e) => {
        const g = e - (e % perSeg(es)) + k
        return M.slice(4 * g, 4 * g + 4)
      })
    },
  })

// CADD, SQCADD: Zdn plus Zm rotated by 90 or 270 degrees.
for (const op of [0, 1])
  INSTRS.push({
    id: `sve-${op ? 'sqcadd' : 'cadd'}`,
    mnemonic: op ? 'sqcadd' : 'cadd',
    group: G,
    feature: 'sve2',
    bits: `01000101 size:2 00000 ${op} 11011 rot Zm:5 Zdn:5`,
    syntax: '<Zdn.size>, <Zdn.size>, <Zm.size>, #<crot:rot>',
    desc: T(`复数整数${op ? '饱和' : ''}加：每对元素是（实部，虚部），Zdn 加上旋转 90 或 270 度的 Zm`, `Complex integer${op ? ' saturating' : ''} add: element pairs are (real, imaginary); Zdn plus Zm rotated by 90 or 270 degrees`),
    exec(c, f) {
      const es = f.size!
      const A = zget(c, f.Zdn!, es).map((v) => sx(v, es))
      const B = zget(c, f.Zm!, es).map((v) => sx(v, es))
      const out = (v: bigint) => (op ? satv(v, es, false) : ux(v, es))
      const R = A.map((a, i) => {
        const p = i - (i % 2)
        const [br, bi] = [B[p]!, B[p + 1]!]
        // 90°: (r − mi, i + mr); 270°: (r + mi, i − mr).
        if (i % 2 === 0) return out(f.rot ? a + bi : a - bi)
        return out(f.rot ? a - br : a + br)
      })
      zset(c, f.Zdn!, R, es)
    },
  })

/* ------------------------------------------------------------------ dot products and matrix multiply */

/** Zda[e] += the sum of k products of narrow elements; with `idx`, Zm's group is the idx-th of each 128-bit segment. */
function dot(c: Cpu, f: Fields, es: number, k: number, nU: boolean, mU: boolean, idx?: number): void {
  const ne = es - (k === 4 ? 2 : 1)
  const N = zget(c, f.Zn!, ne)
  const M = zget(c, f.Zm!, ne)
  const per = perSeg(es)
  zset(c, f.Zda!, zget(c, f.Zda!, es).map((d, e) => {
    const g = idx === undefined ? e : e - (e % per) + idx
    let r = d
    for (let j = 0; j < k; j++) r += iv(N[k * e + j]!, ne, nU) * iv(M[k * g + j]!, ne, mU)
    return ux(r, es)
  }), es)
}
const DOT_DESC = (k: number, nU: boolean, mU: boolean) =>
  T(`点积：Zn${nU === mU ? '、Zm' : ''} 的${nU ? '无' : '有'}符号${nU === mU ? '' : `、Zm 的${mU ? '无' : '有'}符号`}窄元素每 ${k} 个一组对应相乘，和加到 Zda 的宽元素`, `Dot product: each group of ${k} ${nU ? 'unsigned' : 'signed'} narrow elements of Zn times ${nU === mU ? 'those' : `the ${mU ? 'unsigned' : 'signed'} ones`} of Zm, summed into the wide element of Zda`)
for (const U of [0, 1]) {
  const m = U ? 'udot' : 'sdot'
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: 'sve',
    feature: 'sve',
    bits: `01000100 size:2 0 Zm:5 00000 ${U} Zn:5 Zda:5`,
    syntax: '<Zda.size>, <Zn.size-2>, <Zm.size-2>',
    valid: sizes('sd'),
    desc: DOT_DESC(4, !!U, !!U),
    exec: (c, f) => dot(c, f, f.size!, 4, !!U, !!U),
  })
  for (const [es, head, idx] of [
    [2, '10 1 i2:2 Zm:3', 'i2'],
    [3, '11 1 i1 Zm:4', 'i1'],
  ] as const)
    INSTRS.push({
      id: `sve-${m}-idx-${LET[es]}`,
      mnemonic: m,
      group: 'sve',
      feature: 'sve',
      bits: `01000100 ${head} 00000 ${U} Zn:5 Zda:5`,
      syntax: `<Zda.${LET[es]}>, <Zn.${LET[es - 2]}>, <Zm.${LET[es - 2]}[${idx}]>`,
      desc: T(`${DOT_DESC(4, !!U, !!U).zh}；Zm 取每 128 位段里的第 i 组`, `${DOT_DESC(4, !!U, !!U).en}; Zm is group i of each 128-bit segment`),
      exec: (c, f) => dot(c, f, es, 4, !!U, !!U, es === 2 ? f.i2! : f.i1!),
    })
  // SVE2.1: two-way, 32-bit sums of 16-bit products.
  INSTRS.push(
    {
      id: `sve-${m}-2way`,
      mnemonic: m,
      group: G,
      feature: 'sve2p1',
      bits: `01000100 00 0 Zm:5 11001 ${U} Zn:5 Zda:5`,
      syntax: '<Zda.s>, <Zn.h>, <Zm.h>',
      desc: DOT_DESC(2, !!U, !!U),
      exec: (c, f) => dot(c, f, 2, 2, !!U, !!U),
    },
    {
      id: `sve-${m}-2way-idx`,
      mnemonic: m,
      group: G,
      feature: 'sve2p1',
      bits: `01000100 10 0 i2:2 Zm:3 11001 ${U} Zn:5 Zda:5`,
      syntax: '<Zda.s>, <Zn.h>, <Zm.h[i2]>',
      desc: T(`${DOT_DESC(2, !!U, !!U).zh}；Zm 取每 128 位段里的第 i 组`, `${DOT_DESC(2, !!U, !!U).en}; Zm is group i of each 128-bit segment`),
      exec: (c, f) => dot(c, f, 2, 2, !!U, !!U, f.i2!),
    },
  )
}
INSTRS.push({
  id: 'sve-usdot',
  mnemonic: 'usdot',
  group: G,
  feature: 'i8mm',
  bits: '01000100 10 0 Zm:5 011110 Zn:5 Zda:5',
  syntax: '<Zda.s>, <Zn.b>, <Zm.b>',
  desc: DOT_DESC(4, true, false),
  exec: (c, f) => dot(c, f, 2, 4, true, false),
})
for (const U of [0, 1]) {
  const m = U ? 'sudot' : 'usdot'
  INSTRS.push({
    id: `sve-${m}-idx`,
    mnemonic: m,
    group: G,
    feature: 'i8mm',
    bits: `01000100 10 1 i2:2 Zm:3 00011 ${U} Zn:5 Zda:5`,
    syntax: '<Zda.s>, <Zn.b>, <Zm.b[i2]>',
    desc: T(`${DOT_DESC(4, !U, !!U).zh}；Zm 取每 128 位段里的第 i 组`, `${DOT_DESC(4, !U, !!U).en}; Zm is group i of each 128-bit segment`),
    exec: (c, f) => dot(c, f, 2, 4, !U, !!U, f.i2!),
  })
}
// Matrix multiply-accumulate: per 128-bit segment, a 2×8 by 8×2 byte product into a 2×2 word matrix.
for (const [uns, m, nU, mU] of [
  [0, 'smmla', false, false],
  [2, 'usmmla', true, false],
  [3, 'ummla', true, true],
] as const)
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'i8mm',
    bits: `01000101 ${bin(uns, 2)} 0 Zm:5 100110 Zn:5 Zda:5`,
    syntax: '<Zda.s>, <Zn.b>, <Zm.b>',
    desc: T(`矩阵乘加：每个 128 位段里，Zn 是 2×8 的${nU ? '无' : '有'}符号字节矩阵，Zm 是 2×8 的${mU ? '无' : '有'}符号字节矩阵（按行存放，转置后相乘），乘积 2×2 加到 Zda 的 4 个字`, `Matrix multiply-accumulate: in each 128-bit segment, Zn is a 2×8 matrix of ${nU ? 'unsigned' : 'signed'} bytes and Zm a 2×8 matrix of ${mU ? 'unsigned' : 'signed'} bytes (rows, multiplied transposed); the 2×2 product is added to the 4 words of Zda`),
    exec(c, f) {
      const N = zget(c, f.Zn!, 0)
      const M = zget(c, f.Zm!, 0)
      zset(c, f.Zda!, zget(c, f.Zda!, 2).map((d, e) => {
        const s = e >> 2
        const [i, j] = [(e >> 1) & 1, e & 1]
        let r = d
        for (let k = 0; k < 8; k++) r += iv(N[16 * s + 8 * i + k]!, 0, nU) * iv(M[16 * s + 8 * j + k]!, 0, mU)
        return ux(r, 2)
      }), 2)
    },
  })

/* ------------------------------------------------------------------ multiplies by indexed element */

const IDX: [number, string, string][] = [
  [1, '0 i3h 1 i3l:2 Zm:3', 'i3h+i3l'],
  [2, '10 1 i2:2 Zm:3', 'i2'],
  [3, '11 1 i1 Zm:4', 'i1'],
]
const idxOf = (f: Fields, es: number) => (es === 1 ? (f.i3h! << 2) | f.i3l! : es === 2 ? f.i2! : f.i1!)
const SEG_I = T('；Zm 取每 128 位段里的第 i 个元素', '; Zm is element i of each 128-bit segment')
for (const [es, head, idx] of IDX) {
  const t = LET[es]!
  const ops: [string, string, Text, boolean, (d: bigint, a: bigint, b: bigint) => bigint][] = [
    ['mla', '000010', T('相乘后加到 Zda', 'Multiply and add to Zda'), true, (d, a, b) => ux(d + a * b, es)],
    ['mls', '000011', T('相乘后从 Zda 减去', 'Multiply and subtract from Zda'), true, (d, a, b) => ux(d - a * b, es)],
    ['sqrdmlah', '000100', T('有符号相乘乘 2 加到 Zda（Zda 当作高半），舍入取高半（饱和）', 'Signed multiply, doubled, added to Zda (as the high half), rounded, high half (saturating)'), true, (d, a, b) => rdmlah(d, a, b, es, false)],
    ['sqrdmlsh', '000101', T('有符号相乘乘 2 从 Zda 减去（Zda 当作高半），舍入取高半（饱和）', 'Signed multiply, doubled, subtracted from Zda (as the high half), rounded, high half (saturating)'), true, (d, a, b) => rdmlah(d, a, b, es, true)],
    ['mul', '111110', T('相乘', 'Multiply'), false, (_d, a, b) => ux(a * b, es)],
    ['sqdmulh', '111100', T('有符号相乘乘 2，取高半（饱和）', 'Signed multiply, doubled, high half (saturating)'), false, (_d, a, b) => dmulh(a, b, es, false)],
    ['sqrdmulh', '111101', T('有符号相乘乘 2，舍入取高半（饱和）', 'Signed multiply, doubled, rounded, high half (saturating)'), false, (_d, a, b) => dmulh(a, b, es, true)],
  ]
  for (const [m, op, desc, acc, fn] of ops) {
    const d = acc ? 'Zda' : 'Zd'
    INSTRS.push({
      id: `sve-${m}-idx-${t}`,
      mnemonic: m,
      group: G,
      feature: 'sve2',
      bits: `01000100 ${head} ${op} Zn:5 ${d}:5`,
      syntax: `<${d}.${t}>, <Zn.${t}>, <Zm.${t}[${idx}]>`,
      desc: T(desc.zh + SEG_I.zh, desc.en + SEG_I.en),
      exec(c, f) {
        const k = idxOf(f, es)
        const A = zget(c, f.Zn!, es)
        const M = zget(c, f.Zm!, es)
        const D = zget(c, f[d]!, es)
        zset(c, f[d]!, A.map((a, i) => fn(D[i]!, a, segElem(M, es, i, k))), es)
      },
    })
  }
}

// Long forms by indexed element: the index is the high field and bit 11.
for (const [es, head, hi] of [
  [2, '10 1 i3h:2 Zm:3', 'i3h'],
  [3, '11 1 i2h Zm:4', 'i2h'],
] as const) {
  const [w, n] = [LET[es]!, LET[es - 1]!]
  const longIdx = (m: string, ops: string, acc: boolean, desc: (T_: number) => Text, fn: (d: bigint, a: bigint, b: bigint) => bigint) => {
    for (const T_ of [0, 1]) {
      const name = `${m}${T_ ? 't' : 'b'}`
      const d = acc ? 'Zda' : 'Zd'
      INSTRS.push({
        id: `sve-${name}-idx-${w}`,
        mnemonic: name,
        group: G,
        feature: 'sve2',
        bits: `01000100 ${head} ${ops} il ${T_} Zn:5 ${d}:5`,
        syntax: `<${d}.${w}>, <Zn.${n}>, <Zm.${n}[${hi}+il]>`,
        desc: T(desc(T_).zh + SEG_I.zh, desc(T_).en + SEG_I.en),
        exec(c, f) {
          const k = (f[hi]! << 1) | f.il!
          const A = half(c, f.Zn!, es, T_)
          const M = zget(c, f.Zm!, es - 1)
          const per = perSeg(es)
          const D = zget(c, f[d]!, es)
          zset(c, f[d]!, A.map((a, e) => ux(fn(D[e]!, a, M[2 * (e - (e % per)) + k]!), es)), es)
        },
      })
    }
  }
  for (const [S, U] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const)
    longIdx(`${U ? 'u' : 's'}ml${S ? 's' : 'a'}l`, `10 ${S} ${U}`, true, (T_) => T(`Zn 的${BT(T_).zh}${U ? '无' : '有'}符号元素乘 Zm 的元素，${S ? '从 Zda 的宽元素减去' : '加到 Zda 的宽元素'}`, `Multiply the ${BT(T_).en} ${U ? 'unsigned' : 'signed'} elements of Zn by an element of Zm and ${S ? 'subtract from' : 'add to'} the wide elements of Zda`), (d, a, b) => (S ? d - n1(a, es, !!U) * n1(b, es, !!U) : d + n1(a, es, !!U) * n1(b, es, !!U)))
  for (const U of [0, 1]) longIdx(`${U ? 'u' : 's'}mull`, `110 ${U}`, false, (T_) => T(`Zn 的${BT(T_).zh}${U ? '无' : '有'}符号元素乘 Zm 的元素，结果加宽`, `Multiply the ${BT(T_).en} ${U ? 'unsigned' : 'signed'} elements of Zn by an element of Zm, widened`), (_d, a, b) => n1(a, es, !!U) * n1(b, es, !!U))
  longIdx('sqdmull', '1110', false, (T_) => T(`Zn 的${BT(T_).zh}有符号元素乘 Zm 的元素再乘 2，饱和成宽元素`, `Multiply the ${BT(T_).en} signed elements of Zn by an element of Zm, doubled and saturated to wide elements`), (_d, a, b) => satv(2n * n1(a, es, false) * n1(b, es, false), es, false))
  for (const S of [false, true]) longIdx(`sqdml${S ? 's' : 'a'}l`, `001 ${S ? 1 : 0}`, true, (T_) => T(`Zn 的${BT(T_).zh}有符号元素乘 Zm 的元素再乘 2（饱和），${S ? '从 Zda 减去' : '加到 Zda'}（再饱和）`, `Multiply the ${BT(T_).en} signed elements of Zn by an element of Zm, doubled and saturated, and ${S ? 'subtract from' : 'add to'} Zda (saturating)`), (d, a, b) => sqdml(S)(a, b, es, d))
}

/* ------------------------------------------------------------------ bit permutation, carries, absolute difference, clamps */

/** The bits of a where mask is set, packed toward bit 0 (BEXT). */
function bext(a: bigint, mask: bigint, bits: number): bigint {
  let r = 0n
  let k = 0n
  for (let i = 0n; i < BigInt(bits); i++)
    if ((mask >> i) & 1n) {
      r |= ((a >> i) & 1n) << k
      k++
    }
  return r
}
/** The low bits of a spread to the positions where mask is set (BDEP). */
function bdep(a: bigint, mask: bigint, bits: number): bigint {
  let r = 0n
  let k = 0n
  for (let i = 0n; i < BigInt(bits); i++)
    if ((mask >> i) & 1n) {
      r |= ((a >> k) & 1n) << i
      k++
    }
  return r
}
for (const [op, m, desc, fn] of [
  [0, 'bext', T('按 Zm 的掩码取出 Zn 的位，紧凑排到低位', 'Gather the bits of Zn selected by the mask in Zm, packed into the low bits'), (a: bigint, mask: bigint, bits: number) => bext(a, mask, bits)],
  [1, 'bdep', T('把 Zn 的低位依次放到 Zm 掩码为 1 的位置', 'Scatter the low bits of Zn to the positions where the mask in Zm is set'), (a: bigint, mask: bigint, bits: number) => bdep(a, mask, bits)],
  [2, 'bgrp', T('按 Zm 的掩码把 Zn 的位分两组：掩码为 1 的放低位，掩码为 0 的接在上面', 'Group the bits of Zn by the mask in Zm: the bits under a 1 go low, those under a 0 above them'), (a: bigint, mask: bigint, bits: number) => {
    const ones = bext(a, mask, bits)
    let n = 0n
    for (let i = 0n; i < BigInt(bits); i++) n += (mask >> i) & 1n
    return ones | (bext(a, ~mask & ((1n << BigInt(bits)) - 1n), bits) << n)
  }],
] as const)
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2-bitperm',
    bits: `01000101 size:2 0 Zm:5 1011 ${bin(op, 2)} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc,
    exec(c, f) {
      const es = f.size!
      const M = zget(c, f.Zm!, es)
      zset(c, f.Zd!, zget(c, f.Zn!, es).map((a, i) => fn(a, M[i]!, ESIZE[es]!)), es)
    },
  })

for (const sub of [0, 1])
  for (const T_ of [0, 1]) {
    const m = `${sub ? 'sbcl' : 'adcl'}${T_ ? 't' : 'b'}`
    INSTRS.push({
      id: `sve-${m}`,
      mnemonic: m,
      group: G,
      feature: 'sve2',
      bits: `01000101 ${sub} sz 0 Zm:5 11010 ${T_} Zn:5 Zda:5`,
      syntax: '<Zda.sz+2>, <Zn.sz+2>, <Zm.sz+2>',
      desc: T(
        `长${sub ? '减（带借位）' : '加（带进位）'}：Zda 的偶数号元素 ${sub ? '加上 Zn 的取反' : '加上 Zn'}的${BT(T_).zh}元素和 Zm 奇数号元素的最低位，进位写进 Zda 的奇数号元素`,
        `Long ${sub ? 'subtract with borrow' : 'add with carry'}: the even elements of Zda plus ${sub ? 'the inverted' : 'the'} ${BT(T_).en} elements of Zn and the low bit of the odd elements of Zm; the carry goes to the odd elements of Zda`,
      ),
      exec(c, f) {
        const es = f.sz! + 2
        const full = maskEs(es)
        const N = zget(c, f.Zn!, es)
        const M = zget(c, f.Zm!, es)
        const R = zget(c, f.Zda!, es)
        for (let p = 0; p < R.length / 2; p++) {
          const n = N[2 * p + T_]!
          const sum = R[2 * p]! + (sub ? ~n & full : n) + (M[2 * p + 1]! & 1n)
          R[2 * p] = sum & full
          R[2 * p + 1] = sum >> ESN(es)
        }
        zset(c, f.Zda!, R, es)
      },
    })
  }

for (const U of [0, 1])
  INSTRS.push({
    id: `sve-${U ? 'u' : 's'}aba`,
    mnemonic: `${U ? 'u' : 's'}aba`,
    group: G,
    feature: 'sve2',
    bits: `01000101 size:2 0 Zm:5 11111 ${U} Zn:5 Zda:5`,
    syntax: '<Zda.size>, <Zn.size>, <Zm.size>',
    desc: T(`Zn、Zm 的${U ? '无' : '有'}符号元素之差的绝对值，加到 Zda`, `Add the absolute difference of the ${U ? 'unsigned' : 'signed'} elements of Zn and Zm to Zda`),
    exec(c, f) {
      const es = f.size!
      const A = zget(c, f.Zn!, es)
      const B = zget(c, f.Zm!, es)
      zset(c, f.Zda!, zget(c, f.Zda!, es).map((d, i) => {
        const [x, y] = [iv(A[i]!, es, !!U), iv(B[i]!, es, !!U)]
        return ux(d + (x > y ? x - y : y - x), es)
      }), es)
    },
  })

for (const U of [0, 1])
  INSTRS.push({
    id: `sve-${U ? 'u' : 's'}clamp`,
    mnemonic: `${U ? 'u' : 's'}clamp`,
    group: G,
    feature: 'sve2p1',
    bits: `01000100 size:2 0 Zm:5 11000 ${U} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc: T(`把 Zd 的${U ? '无' : '有'}符号元素限制在 [Zn, Zm] 之间`, `Clamp the ${U ? 'unsigned' : 'signed'} elements of Zd to [Zn, Zm]`),
    exec(c, f) {
      const es = f.size!
      const lo = zget(c, f.Zn!, es)
      const hi = zget(c, f.Zm!, es)
      zset(c, f.Zd!, zget(c, f.Zd!, es).map((d, i) => {
        let v = iv(d, es, !!U)
        const [a, b] = [iv(lo[i]!, es, !!U), iv(hi[i]!, es, !!U)]
        if (v < a) v = a
        if (v > b) v = b
        return ux(v, es)
      }), es)
    },
  })

/* ------------------------------------------------------------------ histograms and matches */

INSTRS.push(
  {
    id: 'sve-histcnt',
    mnemonic: 'histcnt',
    group: G,
    feature: 'sve2',
    bits: '01000101 size:2 1 Zm:5 110 Pg:3 Zn:5 Zd:5',
    syntax: '<Zd.size>, <Pg/z>, <Zn.size>, <Zm.size>',
    valid: sizes('sd'),
    desc: T('对每个活跃元素 i，数 Zm 的第 0 到 i 个活跃元素里有几个等于 Zn[i]（不活跃的结果为 0）', 'For each active element i, count the active elements 0 to i of Zm equal to Zn[i] (inactive results are zero)'),
    exec(c, f) {
      const es = f.size!
      const pg = pget(c, f.Pg!, es)
      const N = zget(c, f.Zn!, es)
      const M = zget(c, f.Zm!, es)
      predicated(c, f.Zd!, es, pg, false, (i) => {
        let n = 0n
        for (let j = 0; j <= i; j++) if (pg[j] && M[j] === N[i]) n++
        return n
      })
    },
  },
  {
    id: 'sve-histseg',
    mnemonic: 'histseg',
    group: G,
    feature: 'sve2',
    bits: '01000101 00 1 Zm:5 101000 Zn:5 Zd:5',
    syntax: '<Zd.b>, <Zn.b>, <Zm.b>',
    desc: T('对 Zn 的每个字节，数 Zm 同一个 128 位段里有几个字节和它相等', 'For each byte of Zn, count the bytes equal to it in the same 128-bit segment of Zm'),
    exec(c, f) {
      const N = zget(c, f.Zn!, 0)
      const M = zget(c, f.Zm!, 0)
      zset(c, f.Zd!, N.map((v, i) => {
        const base = i - (i % 16)
        let n = 0n
        for (let j = base; j < base + 16; j++) if (M[j] === v) n++
        return n
      }), 0)
    },
  },
)
for (const op of [0, 1])
  INSTRS.push({
    id: `sve-${op ? 'nmatch' : 'match'}`,
    mnemonic: op ? 'nmatch' : 'match',
    group: G,
    feature: 'sve2',
    bits: `01000101 size:2 1 Zm:5 100 Pg:3 Zn:5 ${op} Pd:4`,
    syntax: '<Pd.size>, <Pg/z>, <Zn.size>, <Zm.size>',
    valid: sizes('bh'),
    desc: op ? T('Zn 的活跃元素在 Zm 同一个 128 位段里找不到相等的元素时置位；设置标志', 'Set where an active element of Zn equals no element of the same 128-bit segment of Zm; sets the flags') : T('Zn 的活跃元素在 Zm 同一个 128 位段里有相等的元素时置位；设置标志', 'Set where an active element of Zn equals some element of the same 128-bit segment of Zm; sets the flags'),
    exec(c, f) {
      const es = f.size!
      const pg = pget(c, f.Pg!, es)
      const N = zget(c, f.Zn!, es)
      const M = zget(c, f.Zm!, es)
      const per = perSeg(es)
      const res = pg.map((on, i) => {
        if (!on) return false
        const base = i - (i % per)
        return M.slice(base, base + per).includes(N[i]!) !== !!op
      })
      pset(c, f.Pd!, res, es)
      c.setFlags(predTest(pg, res))
    },
  })

/* ------------------------------------------------------------------ crypto */

/** Apply fn to each 128-bit segment's bytes. */
function perSegment(c: Cpu, d: number, fn: (seg: Uint8Array, s: number) => Uint8Array): void {
  const bytes = c.vread(d, c.vl)
  const out = new Uint8Array(c.vl)
  for (let s = 0; s < c.vl / 16; s++) out.set(fn(bytes.subarray(16 * s, 16 * s + 16), s), 16 * s)
  c.vwrite(d, out)
}
const words4 = (b: Uint8Array) => Array.from({ length: 4 }, (_, i) => (b[4 * i]! | (b[4 * i + 1]! << 8) | (b[4 * i + 2]! << 16) | (b[4 * i + 3]! << 24)) >>> 0)
const bytes4 = (w: number[]) => Uint8Array.from({ length: 16 }, (_, i) => (w[i >> 2]! >>> (8 * (i & 3))) & 0xff)
const segOf = (c: Cpu, n: number, s: number) => c.vread(n, c.vl).subarray(16 * s, 16 * s + 16)
const SM4E_L = (x: number) => (x ^ rol(x, 2) ^ rol(x, 10) ^ rol(x, 18) ^ rol(x, 24)) >>> 0
const SM4K_L = (x: number) => (x ^ rol(x, 13) ^ rol(x, 23)) >>> 0
for (const inv of [0, 1])
  INSTRS.push(
    {
      id: `sve-${inv ? 'aesd' : 'aese'}`,
      mnemonic: inv ? 'aesd' : 'aese',
      group: G,
      feature: 'sve2-aes',
      bits: `01000101 00 1 00010 11100 ${inv} Zm:5 Zdn:5`,
      syntax: '<Zdn.b>, <Zdn.b>, <Zm.b>',
      desc: inv ? T('每个 128 位段做 AES 解密一轮的前半：与 Zm 异或、InvShiftRows、InvSubBytes', 'AES decrypt round, first half, in each 128-bit segment: XOR with Zm, InvShiftRows, InvSubBytes') : T('每个 128 位段做 AES 加密一轮的前半：与 Zm 异或、ShiftRows、SubBytes', 'AES encrypt round, first half, in each 128-bit segment: XOR with Zm, ShiftRows, SubBytes'),
      exec(c, f) {
        const box = inv ? SBOXES.aesInv : SBOXES.aes
        perSegment(c, f.Zdn!, (d, s) => {
          const k = segOf(c, f.Zm!, s)
          return shiftRows(Uint8Array.from(d, (v, i) => box[v ^ k[i]!]!), !!inv)
        })
      },
    },
    {
      id: `sve-${inv ? 'aesimc' : 'aesmc'}`,
      mnemonic: inv ? 'aesimc' : 'aesmc',
      group: G,
      feature: 'sve2-aes',
      bits: `01000101 00 1 00000 11100 ${inv} 00000 Zdn:5`,
      syntax: '<Zdn.b>, <Zdn.b>',
      desc: inv ? T('每个 128 位段做 AES InvMixColumns', 'AES InvMixColumns in each 128-bit segment') : T('每个 128 位段做 AES MixColumns', 'AES MixColumns in each 128-bit segment'),
      exec: (c, f) => perSegment(c, f.Zdn!, (d) => mixColumns(d, !!inv)),
    },
  )
INSTRS.push(
  {
    id: 'sve-sm4e',
    mnemonic: 'sm4e',
    group: G,
    feature: 'sve2-sm4',
    bits: '01000101 00 1 00011 111000 Zm:5 Zdn:5',
    syntax: '<Zdn.s>, <Zdn.s>, <Zm.s>',
    desc: T('每个 128 位段做 SM4 加密 4 轮：Zdn 是状态，Zm 是 4 个轮密钥', 'SM4 encrypt 4 rounds in each 128-bit segment: Zdn is the state, Zm holds 4 round keys'),
    exec: (c, f) => perSegment(c, f.Zdn!, (d, s) => bytes4(sm4Rounds(words4(d), words4(segOf(c, f.Zm!, s)), SM4E_L))),
  },
  {
    id: 'sve-sm4ekey',
    mnemonic: 'sm4ekey',
    group: G,
    feature: 'sve2-sm4',
    bits: '01000101 00 1 Zm:5 111100 Zn:5 Zd:5',
    syntax: '<Zd.s>, <Zn.s>, <Zm.s>',
    desc: T('每个 128 位段做 SM4 密钥扩展：由 Zn 的 4 个字和 Zm 的 4 个常数算出 4 个轮密钥', 'SM4 key expansion in each 128-bit segment: 4 round keys from the words of Zn and the constants in Zm'),
    exec(c, f) {
      const N = c.vread(f.Zn!, c.vl)
      perSegment(c, f.Zd!, (_d, s) => bytes4(sm4Rounds(words4(N.subarray(16 * s, 16 * s + 16)), words4(segOf(c, f.Zm!, s)), SM4K_L)))
    },
  },
  {
    id: 'sve-rax1',
    mnemonic: 'rax1',
    group: G,
    feature: 'sve2-sha3',
    bits: '01000101 00 1 Zm:5 111101 Zn:5 Zd:5',
    syntax: '<Zd.d>, <Zn.d>, <Zm.d>',
    desc: T('Zn 异或（Zm 循环左移 1 位）', 'Zn XOR (Zm rotated left by 1)'),
    exec(c, f) {
      const M = zget(c, f.Zm!, 3)
      zset(c, f.Zd!, zget(c, f.Zn!, 3).map((a, i) => a ^ (((M[i]! << 1n) | (M[i]! >> 63n)) & maskEs(3))), 3)
    },
  },
)

/* ------------------------------------------------------------------ SVE2.1: quadword reductions, multi-vector narrowing */

for (const [opc, m, desc, U, id, fn] of [
  [0b00101, 'addqv', T('和', 'sum'), true, () => 0n, (a: bigint, b: bigint) => a + b],
  [0b11110, 'andqv', T('按位与', 'bitwise AND'), true, (es: number) => maskEs(es), (a: bigint, b: bigint) => a & b],
  [0b11101, 'eorqv', T('按位异或', 'bitwise exclusive OR'), true, () => 0n, (a: bigint, b: bigint) => a ^ b],
  [0b11100, 'orqv', T('按位或', 'bitwise OR'), true, () => 0n, (a: bigint, b: bigint) => a | b],
  [0b01100, 'smaxqv', T('有符号最大值', 'signed maximum'), false, (es: number) => -(1n << (ESN(es) - 1n)), (a: bigint, b: bigint) => (a > b ? a : b)],
  [0b01101, 'umaxqv', T('无符号最大值', 'unsigned maximum'), true, () => 0n, (a: bigint, b: bigint) => (a > b ? a : b)],
  [0b01110, 'sminqv', T('有符号最小值', 'signed minimum'), false, (es: number) => (1n << (ESN(es) - 1n)) - 1n, (a: bigint, b: bigint) => (a < b ? a : b)],
  [0b01111, 'uminqv', T('无符号最小值', 'unsigned minimum'), true, (es: number) => maskEs(es), (a: bigint, b: bigint) => (a < b ? a : b)],
] as const)
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2p1',
    bits: `00000100 size:2 0 ${bin(opc, 5)} 001 Pg:3 Zn:5 Rd:5`,
    syntax: '<Vd:size:1>, <Pg>, <Zn.size>',
    desc: T(`每个 128 位段里同一位置的活跃元素求${desc.zh}，结果是一个 128 位向量`, `The ${desc.en} of the active elements at each position across the 128-bit segments, as one 128-bit vector`),
    exec(c, f) {
      const es = f.size!
      const pg = pget(c, f.Pg!, es)
      const A = zget(c, f.Zn!, es)
      const per = perSeg(es)
      const R = Array.from({ length: per }, (_, i) => {
        let r = id(es)
        for (let s = i; s < A.length; s += per) if (pg[s]) r = fn(r, iv(A[s]!, es, U))
        return ux(r, es)
      })
      zset(c, f.Rd!, R, es)
    },
  })

// SQCVTN, UQCVTN, SQCVTUN: two vectors of words saturated to halfwords, interleaved.
for (const [opc, m, inU, outU] of [
  [0b000, 'sqcvtn', false, false],
  [0b010, 'uqcvtn', true, true],
  [0b100, 'sqcvtun', false, true],
] as const)
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve2p1',
    bits: `01000101 00 1 10001 010 ${bin(opc, 3)} Zn:4 0 Zd:5`,
    syntax: '<Zd.h>, <LM:Zn:2:s>',
    desc: T(`两个向量的${inU ? '无' : '有'}符号字饱和成${outU ? '无' : '有'}符号半字，交错放进 Zd（第一个向量在偶数号位置）`, `Saturate the ${inU ? 'unsigned' : 'signed'} words of two vectors to ${outU ? 'unsigned' : 'signed'} halfwords, interleaved into Zd (the first vector in the even positions)`),
    exec(c, f) {
      const [A, B] = [zget(c, 2 * f.Zn!, 2), zget(c, 2 * f.Zn! + 1, 2)]
      zset(c, f.Zd!, A.flatMap((a, i) => [a, B[i]!].map((v) => satv(iv(v, 2, inU), 1, outU))), 1)
    },
  })
// SQRSHRN, UQRSHRN, SQRSHRUN (two vectors): rounding shift right by 1–16, saturated, interleaved.
for (const [opc, m, inU, outU] of [
  [0b001010, 'sqrshrn', false, false],
  [0b001110, 'uqrshrn', true, true],
  [0b000010, 'sqrshrun', false, true],
] as const)
  INSTRS.push({
    id: `sve-${m}-x2`,
    mnemonic: m,
    group: G,
    feature: 'sve2p1',
    bits: `01000101 10 1 tszh tszl imm3:3 ${bin(opc, 6)} Zn:4 0 Zd:5`,
    syntax: '<Zd.tsz>, <LM:Zn:2:tsz+1>, #<tsr>',
    valid: (f) => f.tszh === 1,
    desc: T(`两个向量的${inU ? '无' : '有'}符号字舍入右移，饱和成${outU ? '无' : '有'}符号半字，交错放进 Zd（第一个向量在偶数号位置）`, `Shift the ${inU ? 'unsigned' : 'signed'} words of two vectors right with rounding, saturated to ${outU ? 'unsigned' : 'signed'} halfwords, interleaved into Zd (the first vector in the even positions)`),
    exec(c, f) {
      const sh = BigInt(32 - (((f.tszh! << 1) | f.tszl!) << 3 | f.imm3!))
      const [A, B] = [zget(c, 2 * f.Zn!, 2), zget(c, 2 * f.Zn! + 1, 2)]
      zset(c, f.Zd!, A.flatMap((a, i) => [a, B[i]!].map((v) => satv((iv(v, 2, inU) + (1n << (sh - 1n))) >> sh, 1, outU))), 1)
    },
  })

// EORBT, EORTB: interleaving exclusive OR.
for (const T_ of [0, 1])
  INSTRS.push({
    id: `sve-${T_ ? 'eortb' : 'eorbt'}`,
    mnemonic: T_ ? 'eortb' : 'eorbt',
    group: G,
    feature: 'sve2',
    bits: `01000101 size:2 0 Zm:5 10010 ${T_} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc: T_ ? T('Zn 的奇数号元素异或 Zm 的偶数号元素，写入 Zd 的奇数号元素（偶数号不变）', 'The odd elements of Zn XOR the even elements of Zm, into the odd elements of Zd (the even ones are kept)') : T('Zn 的偶数号元素异或 Zm 的奇数号元素，写入 Zd 的偶数号元素（奇数号不变）', 'The even elements of Zn XOR the odd elements of Zm, into the even elements of Zd (the odd ones are kept)'),
    exec(c, f) {
      const es = f.size!
      const N = zget(c, f.Zn!, es)
      const M = zget(c, f.Zm!, es)
      zset(c, f.Zd!, zget(c, f.Zd!, es).map((d, i) => (i % 2 === T_ ? N[i]! ^ M[i + (T_ ? -1 : 1)]! : d)), es)
    },
  })
