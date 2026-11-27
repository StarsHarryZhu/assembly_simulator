/**
 * SME and the SME2 / SME2.1 instructions that work on whole tiles: Streaming SVE mode and ZA control
 * (SMSTART, SMSTOP, RDSVL, ADDSVL, ADDSPL), outer products into tiles (FMOPA, BFMOPA, BMOPA, SMOPA and their
 * mixed-sign and subtracting forms), ADDHA and ADDVA, moves between tiles, ZA array vectors and Z registers
 * (MOVA, MOVAZ), tile slice loads and stores (LD1B–LD1Q, ST1B–ST1Q), LDR and STR of ZA vectors and ZT0,
 * ZERO, MOVT, and the ZT0 table lookups LUTI2 and LUTI4.
 */
import { T, type Text } from '../../../core/i18n'
import { NEED, type AliasSpec, type InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { ESIZE, lo32, sx, ux } from './vec'
import { pget, zget, zset } from './zvec'
import { sliceAt, sliceGet, sliceSet, tileDim, tileOff, tileRows, zaEnv, zaGet, zaSet, zaVectors } from './zavec'
import { bfDotAdd } from './simd-fp'
import * as sf from '../softfloat'

export const INSTRS: InstrSpec[] = []
export const ALIASES: AliasSpec[] = []
const G = 'sme'
const LET = 'bhsdq'
const M64 = (1n << 64n) - 1n
const SZA = NEED.streaming | NEED.za

/* ------------------------------------------------------------------ mode control */

INSTRS.push(
  {
    id: 'msr-svcr',
    mnemonic: 'msr',
    group: G,
    feature: 'sme',
    bits: '1101010100000 011 0100 0 fld:2 v 011 11111',
    syntax: '<word:fld:|svcrsm|svcrza|svcrsmza>, #<u:v>',
    valid: (f) => f.fld !== 0,
    desc: T('设置 SVCR 的 SM 和/或 ZA 位（smstart / smstop 的本名）', 'Set SVCR.SM and/or SVCR.ZA (what smstart / smstop are)'),
    exec: (c, f) => c.pstate(3, 3, (f.fld! << 1) | f.v!),
  },
  {
    id: 'rdsvl',
    mnemonic: 'rdsvl',
    group: G,
    feature: 'sme',
    bits: '00000100 1 0 1 11111 01011 imm6:6 Rd:5',
    syntax: '<Xd>, #<s:imm6>',
    desc: T('Xd = imm × 流式向量的字节数（SVL / 8），在哪种模式下都一样', 'Xd = imm × the streaming vector length in bytes (SVL / 8), in either mode'),
    exec: (c, f) => c.setX(f.Rd!, BigInt.asUintN(64, BigInt(simm6(f) * c.svl))),
  },
  {
    id: 'addsvl',
    mnemonic: 'addsvl',
    group: G,
    feature: 'sme',
    bits: '00000100 0 0 1 Rn:5 01011 imm6:6 Rd:5',
    syntax: '<Xd|SP>, <Xn|SP>, #<s:imm6>',
    desc: T('Xd = Xn + imm × 流式向量的字节数，常用来在栈上留出放一个流式向量的位置', 'Xd = Xn + imm × the streaming vector length in bytes, e.g. to make room on the stack for a streaming vector'),
    exec: (c, f) => c.setXsp(f.Rd!, (c.xsp(f.Rn!) + BigInt(simm6(f) * c.svl)) & M64),
  },
  {
    id: 'addspl',
    mnemonic: 'addspl',
    group: G,
    feature: 'sme',
    bits: '00000100 0 1 1 Rn:5 01011 imm6:6 Rd:5',
    syntax: '<Xd|SP>, <Xn|SP>, #<s:imm6>',
    desc: T('Xd = Xn + imm × 流式谓词的字节数（SVL / 64）', 'Xd = Xn + imm × the streaming predicate length in bytes (SVL / 64)'),
    exec: (c, f) => c.setXsp(f.Rd!, (c.xsp(f.Rn!) + BigInt((simm6(f) * c.svl) / 8)) & M64),
  },
)
function simm6(f: Fields): number {
  return f.imm6! >= 32 ? f.imm6! - 64 : f.imm6!
}
for (const [m, v, what] of [
  ['smstart', 1, T('进入', 'Enter')],
  ['smstop', 0, T('退出', 'Leave')],
] as const)
  ALIASES.push({
    id: m,
    of: 'msr-svcr',
    mnemonic: m,
    syntax: '{<word:fld:|sm|za|=3>}',
    fixed: { v },
    desc: T(
      `${what.zh}流式 SVE 模式（sm）和/或打开${v ? '' : '后关闭'} ZA（za），不写就是两个都${v ? '开' : '关'}；模式变化时 z、p、FFR 清零，FPSR 变成 0x0800009f，ZA 开关时 ZA 和 ZT0 清零`,
      `${what.en} Streaming SVE mode (sm) and/or ${v ? 'enable' : 'disable'} ZA (za), both when left out; a change of mode zeroes z, p and FFR and sets FPSR to 0x0800009f, a change of ZA zeroes ZA and ZT0`,
    ),
  })

/* ------------------------------------------------------------------ outer products */

type Env = sf.FpEnv

/** The `on` flags of a single active product. */
const ONE = [true]

/**
 * Tile += (or −=) the outer product of Zn and Zm, `k` elements of Zn and Zm per tile element (k > 1: a sum
 * of k products). `pair(acc, rowEls, colEls, on)` combines the k pairs, `on[p]` telling which are active.
 */
function outer(c: Cpu, f: Fields, tes: number, ses: number, t: number, op: (acc: bigint, a: bigint[], b: bigint[], on: boolean[], pa: boolean[], pb: boolean[]) => bigint): void {
  const k = 1 << (tes - ses)
  const pn = pget(c, f.Pn!, ses)
  const pm = pget(c, f.Pm!, ses)
  const N = zget(c, f.Zn!, ses)
  const M = zget(c, f.Zm!, ses)
  const d = tileDim(c, tes)
  // Each row's and each column's k source elements and predicate bits, cut once.
  const chunks = <T,>(xs: T[]) => Array.from({ length: d }, (_, i) => xs.slice(i * k, i * k + k))
  const [PA, PB, NA, MB] = [chunks(pn), chunks(pm), chunks(N), chunks(M)]
  const rows = PA.map((pa) => pa.some(Boolean))
  tileRows(c, tes, t, rows, (i, row) => {
    const pa = PA[i]!
    for (let j = 0; j < d; j++) {
      const pb = PB[j]!
      // One product per element (k = 1): active when both bits are, and no flags to build.
      if (k === 1) {
        if (pa[0] && pb[0]) row[j] = op(row[j]!, NA[i]!, MB[j]!, ONE, pa, pb)
        continue
      }
      const on = pa.map((x, p) => x && pb[p]!)
      if (on.some(Boolean)) row[j] = op(row[j]!, NA[i]!, MB[j]!, on, pa, pb)
    }
    return row
  })
}

interface Mop {
  id: string
  m: string
  feature: string
  /** Bits before Zm (11), then after Zn: S and the rest. */
  hi: string
  lo: string
  tes: number
  ses: number
  tile: string
  desc: Text
  run: (c: Cpu, f: Fields, sub: boolean) => void
}

const fmtOf = (es: number) => (es === 1 ? sf.F16 : es === 2 ? sf.F32 : sf.F64)

function fmop(es: number, sub: boolean): (c: Cpu, f: Fields) => void {
  return (c, f) => {
    const env = zaEnv(c)
    const t = fmtOf(es)
    if (es === 2 && sf.nativeOk(env)) return fmop32(c, f, env, sub)
    outer(c, f, es, es, f.ZAda!, (acc, a, b) => sf.fpMulAdd(env, t, acc, sub ? sf.fpNeg(env, t, a[0]!) : a[0]!, b[0]!))
  }
}

/**
 * Single-precision FMOPA and FMOPS on the native path: each source element is converted once, and each tile
 * element takes one multiply-add on numbers. An element whose operands are not all normal or zero, or
 * whose result the native path cannot round, goes to fpMulAdd, so every result is the one it gives.
 */
function fmop32(c: Cpu, f: Fields, env: Env, sub: boolean): void {
  const pn = pget(c, f.Pn!, 2)
  const pm = pget(c, f.Pm!, 2)
  const N = zget(c, f.Zn!, 2).map((x) => (sub ? sf.fpNeg(env, sf.F32, x) : x))
  const M = zget(c, f.Zm!, 2)
  const NV = N.map((x) => sf.value32(x))
  const MV = M.map((x) => sf.value32(x))
  tileRows(c, 2, f.ZAda!, pn, (i, row) => {
    const a = NV[i]!
    for (let j = 0; j < row.length; j++) {
      if (!pm[j]) continue
      const acc = row[j]!
      const b = MV[j]!
      const cv = a === null || b === null ? null : sf.value32(acc)
      row[j] = (cv === null ? null : sf.fma32Values(env, cv, a!, b!)) ?? sf.fpMulAdd(env, sf.F32, acc, N[i]!, M[j]!)
    }
    return row
  })
}

/**
 * Widening 2-way FP16 or BF16 to FP32: the pair's products summed with the tile element. Each source element
 * whose own predicate bit is off counts as +0, even when its partner in the product is active (so an active
 * NaN or infinity times an inactive element still gives NaN, as on the M5); the subtracting forms negate the
 * active row elements only.
 */
function fmopWide(bf16: boolean, sub: boolean): (c: Cpu, f: Fields) => void {
  return (c, f) => {
    const env = zaEnv(c)
    outer(c, f, 2, 1, f.ZAda!, (acc, a, b, _on, pa, pb) => {
      const x = a.map((v, p) => (pa[p] ? (sub ? v ^ 0x8000n : v) : 0n))
      const y = b.map((v, p) => (pb[p] ? v : 0n))
      if (bf16) return bfDotAdd(acc, x[0]!, x[1]!, y[0]!, y[1]!, env.fpcr)
      return sf.fpAdd(env, sf.F32, acc, sf.fpDot(env, sf.F16, x[0]!, x[1]!, y[0]!, y[1]!))
    })
  }
}

/** Non-widening BF16 (B16B16): fused multiply-add in BFloat16. */
function bfmopH(sub: boolean): (c: Cpu, f: Fields) => void {
  return (c, f) => {
    const env = zaEnv(c)
    outer(c, f, 1, 1, f.ZAda!, (acc, a, b) => {
      const x = sub ? sf.fpNeg(env, sf.BF16, a[0]!) : a[0]!
      return sf.fpMulAdd(env, sf.BF16, acc, x, b[0]!)
    })
  }
}

/**
 * Integer sums of k products (signedness per operand), added or subtracted. The sources have 8- or 16-bit
 * elements, so each sum of products is exact as a number (below 2^35); only the tile element is a bigint.
 * A tile element changes when at least one of its k products is active, and takes only the active ones.
 */
function imop(tes: number, ses: number, uN: boolean, uM: boolean, sub: boolean): (c: Cpu, f: Fields) => void {
  const shift = 32 - ESIZE[ses]!
  const num = (x: bigint, unsigned: boolean) => (unsigned ? lo32(x) : (lo32(x) << shift) >> shift)
  return (c, f) => {
    const k = 1 << (tes - ses)
    const pn = pget(c, f.Pn!, ses)
    const pm = pget(c, f.Pm!, ses)
    // Inactive elements as 0, so their products add nothing; each row's and column's k predicate bits.
    const NV = zget(c, f.Zn!, ses).map((x, i) => (pn[i] ? num(x, uN) : 0))
    const MV = zget(c, f.Zm!, ses).map((x, i) => (pm[i] ? num(x, uM) : 0))
    const d = tileDim(c, tes)
    const bits = (p: boolean[], i: number) => {
      let m = 0
      for (let q = 0; q < k; q++) if (p[i * k + q]) m |= 1 << q
      return m
    }
    const RB = Array.from({ length: d }, (_, i) => bits(pn, i))
    const CB = Array.from({ length: d }, (_, j) => bits(pm, j))
    tileRows(c, tes, f.ZAda!, RB.map((m) => m !== 0), (i, row) => {
      const rb = RB[i]!
      for (let j = 0; j < d; j++) {
        if (!(rb & CB[j]!)) continue
        let s = 0
        for (let p = 0, a = i * k, b = j * k; p < k; p++) s += NV[a + p]! * MV[b + p]!
        if (sub) s = -s
        // A 32-bit element adds as a number (exact below 2^53); a 64-bit one as a bigint.
        row[j] = tes === 2 ? BigInt((lo32(row[j]!) + s) >>> 0) : ux(row[j]! + BigInt(s), tes)
      }
      return row
    })
  }
}

const popcount = (v: bigint) => {
  let n = 0
  for (; v; v &= v - 1n) n++
  return n
}

const MOPS: Mop[] = []
const subTxt = (sub: boolean) => (sub ? T('减去', 'subtracted from') : T('加到', 'added to'))
for (const sub of [false, true]) {
  const S = sub ? 1 : 0
  const a = sub ? 's' : 'a'
  const how = subTxt(sub)
  MOPS.push(
    { id: `fmop${a}-s`, m: `fmop${a}`, feature: 'sme', hi: '10000000 100', lo: `${S} 00 ZAda:2`, tes: 2, ses: 2, tile: 's', desc: T(`单精度外积：Zn 的每个元素乘 Zm 的每个元素（融合乘加），${how.zh} tile 对应位置`, `Single-precision outer product: each element of Zn times each element of Zm (fused), ${how.en} the tile`), run: (c, f) => fmop(2, sub)(c, f) },
    { id: `fmop${a}-d`, m: `fmop${a}`, feature: 'sme-f64f64', hi: '10000000 110', lo: `${S} 0 ZAda:3`, tes: 3, ses: 3, tile: 'd', desc: T(`双精度外积，${how.zh} tile`, `Double-precision outer product, ${how.en} the tile`), run: (c, f) => fmop(3, sub)(c, f) },
    { id: `fmop${a}-h`, m: `fmop${a}`, feature: 'sme-f16f16', hi: '10000001 100', lo: `${S} 100 ZAda`, tes: 1, ses: 1, tile: 'h', desc: T(`半精度外积，${how.zh}半精度 tile`, `Half-precision outer product, ${how.en} a half-precision tile`), run: (c, f) => fmop(1, sub)(c, f) },
    { id: `fmop${a}-hs`, m: `fmop${a}`, feature: 'sme', hi: '10000001 101', lo: `${S} 00 ZAda:2`, tes: 2, ses: 1, tile: 's', desc: T(`半精度到单精度的加宽外积：每两个半精度相乘求和，${how.zh}单精度 tile`, `Widening half to single precision outer product: pairs of products summed, ${how.en} a single-precision tile`), run: (c, f) => fmopWide(false, sub)(c, f) },
    { id: `bfmop${a}-hs`, m: `bfmop${a}`, feature: 'sme', hi: '10000001 100', lo: `${S} 00 ZAda:2`, tes: 2, ses: 1, tile: 's', desc: T(`BF16 到单精度的加宽外积：每两个 BF16 相乘求和，${how.zh}单精度 tile`, `Widening BFloat16 to single precision outer product: pairs of products summed, ${how.en} a single-precision tile`), run: (c, f) => fmopWide(true, sub)(c, f) },
    { id: `bfmop${a}-h`, m: `bfmop${a}`, feature: 'sme-b16b16', hi: '10000001 101', lo: `${S} 100 ZAda`, tes: 1, ses: 1, tile: 'h', desc: T(`BF16 外积（融合乘加），${how.zh} BF16 tile`, `BFloat16 outer product (fused), ${how.en} a BFloat16 tile`), run: (c, f) => bfmopH(sub)(c, f) },
    {
      id: `bmop${a}`,
      m: `bmop${a}`,
      feature: 'sme2',
      hi: '10000000 100',
      lo: `${S} 10 ZAda:2`,
      tes: 2,
      ses: 2,
      tile: 's',
      desc: T(`按位外积：每对 32 位元素同或（XNOR）后数 1 的个数，${how.zh} tile`, `Bitwise outer product: the number of ones in each pair XNORed, ${how.en} the tile`),
      run: (c, f) => outer(c, f, 2, 2, f.ZAda!, (acc, x, y) => ux(acc + (sub ? -1n : 1n) * BigInt(popcount(~(x[0]! ^ y[0]!) & 0xffffffffn)), 2)),
    },
  )
  for (const [u0, u1, name] of [
    [0, 0, 'smop'],
    [0, 1, 'sumop'],
    [1, 0, 'usmop'],
    [1, 1, 'umop'],
  ] as const) {
    const sign = (u: number) => (u ? T('无符号', 'unsigned') : T('有符号', 'signed'))
    MOPS.push(
      {
        id: `${name}${a}-bs`,
        m: `${name}${a}`,
        feature: 'sme',
        hi: `1010000${u0} 10${u1}`,
        lo: `${S} 00 ZAda:2`,
        tes: 2,
        ses: 0,
        tile: 's',
        desc: T(`8 位整数外积（Zn ${sign(u0).zh}、Zm ${sign(u1).zh}）：每四对相乘求和，${how.zh} 32 位 tile`, `8-bit integer outer product (Zn ${sign(u0).en}, Zm ${sign(u1).en}): sums of four products, ${how.en} a 32-bit tile`),
        run: (c, f) => imop(2, 0, !!u0, !!u1, sub)(c, f),
      },
      {
        id: `${name}${a}-hd`,
        m: `${name}${a}`,
        feature: 'sme-i16i64',
        hi: `1010000${u0} 11${u1}`,
        lo: `${S} 0 ZAda:3`,
        tes: 3,
        ses: 1,
        tile: 'd',
        desc: T(`16 位整数外积（Zn ${sign(u0).zh}、Zm ${sign(u1).zh}）：每四对相乘求和，${how.zh} 64 位 tile`, `16-bit integer outer product (Zn ${sign(u0).en}, Zm ${sign(u1).en}): sums of four products, ${how.en} a 64-bit tile`),
        run: (c, f) => imop(3, 1, !!u0, !!u1, sub)(c, f),
      },
    )
    if (u0 === u1)
      MOPS.push({
        id: `${name}${a}-hs`,
        m: `${name}${a}`,
        feature: 'sme2',
        hi: `1010000${u0} 100`,
        lo: `${S} 10 ZAda:2`,
        tes: 2,
        ses: 1,
        tile: 's',
        desc: T(`16 位${sign(u0).zh}整数外积：每两对相乘求和，${how.zh} 32 位 tile`, `16-bit ${sign(u0).en} integer outer product: sums of two products, ${how.en} a 32-bit tile`),
        run: (c, f) => imop(2, 1, !!u0, !!u0, sub)(c, f),
      })
  }
}
for (const o of MOPS)
  INSTRS.push({
    id: o.id,
    mnemonic: o.m,
    group: G,
    feature: o.feature,
    bits: `${o.hi} Zm:5 Pm:3 Pn:3 Zn:5 ${o.lo}`,
    syntax: `<tile:ZAda:${o.tile}>, <Pn/m>, <Pm/m>, <Zn.${LET[o.ses]}>, <Zm.${LET[o.ses]}>`,
    desc: o.desc,
    exec: (c, f) => o.run(c, f, false),
  })

/* ------------------------------------------------------------------ ADDHA, ADDVA */

for (const [es, sz, za] of [
  [2, '10', 'ZAda:2'],
  [3, '11', 'ZAda:3'],
] as const)
  for (const v of [0, 1]) {
    const m = v ? 'addva' : 'addha'
    INSTRS.push({
      id: `${m}-${LET[es]}`,
      mnemonic: m,
      group: G,
      feature: es === 3 ? 'sme-i16i64' : 'sme',
      bits: `11000000 ${sz} 01000 ${v} Pm:3 Pn:3 Zn:5 ${es === 2 ? '000' : '00'} ${za}`,
      syntax: `<tile:ZAda:${LET[es]}>, <Pn/m>, <Pm/m>, <Zn.${LET[es]}>`,
      desc: v
        ? T('把 Zn 加到 tile 的每一列：活跃的行 i、列 j 加上 Zn[i]', 'Add Zn to every column of the tile: active row i, column j gets Zn[i] added')
        : T('把 Zn 加到 tile 的每一行：活跃的行 i、列 j 加上 Zn[j]', 'Add Zn to every row of the tile: active row i, column j gets Zn[j] added'),
      exec(c, f) {
        const pn = pget(c, f.Pn!, es)
        const pm = pget(c, f.Pm!, es)
        const N = zget(c, f.Zn!, es)
        tileRows(c, es, f.ZAda!, pn, (i, row) => row.map((x, j) => (pm[j] ? ux(x + N[v ? i : j]!, es) : x)))
      },
    })
  }

/* ------------------------------------------------------------------ MOVA, MOVAZ (single vector) */

/** size and Q bits, and the width of the tile:offset field, per element size. */
const SIZEQ = ['00 00001 0', '01 00001 0', '10 00001 0', '11 00001 0', '11 00001 1']
const SIZEQ_W = ['00 00000 0', '01 00000 0', '10 00000 0', '11 00000 0', '11 00000 1']

function slicePos(c: Cpu, f: Fields, es: number, width: number, n = 1): { t: number; i: number; v: boolean } {
  const { t, off } = tileOff(f, 'ZAo', width, es)
  return { t, i: sliceAt(c, f, es, off * n), v: f.V === 1 }
}

for (let es = 0; es <= 4; es++) {
  const L = LET[es]!
  INSTRS.push(
    {
      id: `mova-zt-${L}`,
      mnemonic: 'mova',
      group: G,
      feature: 'sme',
      bits: `11000000 ${SIZEQ[es]} V Rv:2 Pg:3 0 ZAo:4 Zd:5`,
      syntax: `<Zd.${L}>, <Pg/m>, <slice:ZAo:${L}>`,
      desc: T('把 tile 的一行（h）或一列（v）复制到 Zd，只改活跃元素', 'Copy a row (h) or column (v) of a tile to Zd, active elements only'),
      exec(c, f) {
        const { t, i, v } = slicePos(c, f, es, 4)
        const pg = pget(c, f.Pg!, es)
        const s = sliceGet(c, es, t, v, i)
        const d = zget(c, f.Zd!, es)
        zset(c, f.Zd!, d.map((x, j) => (pg[j] ? s[j]! : x)), es)
      },
    },
    {
      id: `mova-tz-${L}`,
      mnemonic: 'mova',
      group: G,
      feature: 'sme',
      bits: `11000000 ${SIZEQ_W[es]} V Rv:2 Pg:3 Zn:5 0 ZAo:4`,
      syntax: `<slice:ZAo:${L}>, <Pg/m>, <Zn.${L}>`,
      desc: T('把 Zn 的活跃元素写进 tile 的一行（h）或一列（v）', 'Write the active elements of Zn into a row (h) or column (v) of a tile'),
      exec(c, f) {
        const { t, i, v } = slicePos(c, f, es, 4)
        const pg = pget(c, f.Pg!, es)
        sliceSet(c, es, t, v, i, zget(c, f.Zn!, es), pg.map((on) => !on))
      },
    },
    {
      id: `movaz-${L}`,
      mnemonic: 'movaz',
      group: G,
      feature: 'sme2p1',
      bits: `11000000 ${SIZEQ[es]} V Rv:2 000 1 ZAo:4 Zd:5`,
      syntax: `<Zd.${L}>, <slice:ZAo:${L}>`,
      desc: T('把 tile 的一行（h）或一列（v）移到 Zd，再把那一行或列清零', 'Move a row (h) or column (v) of a tile to Zd, then zero it'),
      exec(c, f) {
        const { t, i, v } = slicePos(c, f, es, 4)
        const s = sliceGet(c, es, t, v, i)
        zset(c, f.Zd!, s, es)
        sliceSet(c, es, t, v, i, s.map(() => 0n))
      },
    },
  )
  ALIASES.push(
    { id: `mov-zt-${L}`, of: `mova-zt-${L}`, mnemonic: 'mov', syntax: `<Zd.${L}>, <Pg/m>, <slice:ZAo:${L}>` },
    { id: `mov-tz-${L}`, of: `mova-tz-${L}`, mnemonic: 'mov', syntax: `<slice:ZAo:${L}>, <Pg/m>, <Zn.${L}>` },
  )
}

/* ------------------------------------------------------------------ MOVA, MOVAZ (two and four vectors) */

for (let es = 0; es <= 3; es++) {
  const L = LET[es]!
  const size = es.toString(2).padStart(2, '0')
  for (const n of [2, 4]) {
    const zd = n === 2 ? 'Zd:4 0' : 'Zd:3 00'
    // Four .d slices need the 3-bit tile number; the other x4 forms leave the field's top bit 0.
    const zw = n === 2 || es === 3 ? 3 : 2
    const za = `ZAo:${zw}`
    const sel = n === 2 ? '000' : '001'
    const list = `<LM:Zd:${n}:${L}>`
    // A tile can have fewer slices than registers (four .d slices at SVL 128): the slices then wrap round
    // the tile like the first one, instead of running past it.
    const tileToVec = (zero: boolean) => (c: Cpu, f: Fields) => {
      const { t, i, v } = slicePos(c, f, es, zw, n)
      const dim = tileDim(c, es)
      const base = i - (i % n)
      for (let k = 0; k < n; k++) {
        const s = sliceGet(c, es, t, v, (base + k) % dim)
        zset(c, f.Zd! * n + k, s, es)
        if (zero) sliceSet(c, es, t, v, (base + k) % dim, s.map(() => 0n))
      }
    }
    for (const zero of [false, true])
      INSTRS.push({
        id: `mova${zero ? 'z' : ''}-zt${n}-${L}`,
        mnemonic: zero ? 'movaz' : 'mova',
        group: G,
        feature: zero ? 'sme2p1' : 'sme2',
        bits: `11000000 ${size} 00011 0 V Rv:2 ${sel} ${zero ? 1 : 0} 0 ${zw === 2 ? '0' : ''} ${za} ${zd}`,
        syntax: `${list}, <slice:ZAo:${L}:${n}>`,
        desc: zero
          ? T(`把 tile 的 ${n} 行（h）或 ${n} 列（v）移到 ${n} 个 z 寄存器，再把它们清零`, `Move ${n} rows (h) or columns (v) of a tile to ${n} z registers, then zero them`)
          : T(`把 tile 的 ${n} 行（h）或 ${n} 列（v）复制到 ${n} 个 z 寄存器`, `Copy ${n} rows (h) or columns (v) of a tile to ${n} z registers`),
        exec: tileToVec(zero),
      })
    INSTRS.push({
      id: `mova-tz${n}-${L}`,
      mnemonic: 'mova',
      group: G,
      feature: 'sme2',
      bits: `11000000 ${size} 00010 0 V Rv:2 ${sel} ${n === 2 ? 'Zn:4 0 00' : `Zn:3 0000 ${zw === 2 ? '0' : ''}`} ${za}`,
      syntax: `<slice:ZAo:${L}:${n}>, <LM:Zn:${n}:${L}>`,
      desc: T(`把 ${n} 个 z 寄存器写进 tile 的 ${n} 行（h）或 ${n} 列（v）`, `Write ${n} z registers into ${n} rows (h) or columns (v) of a tile`),
      exec(c, f) {
        const { t, i, v } = slicePos(c, f, es, zw, n)
        const dim = tileDim(c, es)
        const base = i - (i % n)
        for (let k = 0; k < n; k++) sliceSet(c, es, t, v, (base + k) % dim, zget(c, f.Zn! * n + k, es))
      },
    })
    ALIASES.push(
      { id: `mov-zt${n}-${L}`, of: `mova-zt${n}-${L}`, mnemonic: 'mov', syntax: `${list}, <slice:ZAo:${L}:${n}>` },
      { id: `mov-tz${n}-${L}`, of: `mova-tz${n}-${L}`, mnemonic: 'mov', syntax: `<slice:ZAo:${L}:${n}>, <LM:Zn:${n}:${L}>` },
    )
  }
}

for (const n of [2, 4]) {
  const sel = n === 2 ? '010' : '011'
  for (const zero of [false, true])
    INSTRS.push({
      id: `mova${zero ? 'z' : ''}-za${n}`,
      mnemonic: zero ? 'movaz' : 'mova',
      group: G,
      feature: zero ? 'sme2p1' : 'sme2',
      bits: `11000000 00 00011 0 0 Rv:2 ${sel} ${zero ? 1 : 0} 0 off3:3 ${n === 2 ? 'Zd:4 0' : 'Zd:3 00'}`,
      syntax: `<LM:Zd:${n}:d>, <za:*:1:${n}:off3>`,
      desc: zero
        ? T(`把 ZA 的 ${n} 个向量（一组）移到 ${n} 个 z 寄存器，再把它们清零`, `Move ${n} ZA vectors (one group) to ${n} z registers, then zero them`)
        : T(`把 ZA 的 ${n} 个向量（每组一个）复制到 ${n} 个 z 寄存器`, `Copy ${n} ZA vectors (one from each group) to ${n} z registers`),
      exec(c, f) {
        zaVectors(c, f, f.off3!, 1, n).forEach(([r], k) => {
          const row = zaGet(c, r!, 3)
          zset(c, f.Zd! * n + k, row, 3)
          if (zero) zaSet(c, r!, row.map(() => 0n), 3)
        })
      },
    })
  INSTRS.push({
    id: `mova-az${n}`,
    mnemonic: 'mova',
    group: G,
    feature: 'sme2',
    bits: `11000000 00 00010 0 0 Rv:2 ${sel} ${n === 2 ? 'Zn:4 000' : 'Zn:3 0000'} off3:3`,
    syntax: `<za:*:1:${n}:off3>, <LM:Zn:${n}:d>`,
    desc: T(`把 ${n} 个 z 寄存器写进 ZA 的 ${n} 个向量（每组一个）`, `Write ${n} z registers into ${n} ZA vectors (one in each group)`),
    exec(c, f) {
      zaVectors(c, f, f.off3!, 1, n).forEach(([r], k) => zaSet(c, r!, zget(c, f.Zn! * n + k, 3), 3))
    },
  })
  ALIASES.push(
    { id: `mov-za${n}`, of: `mova-za${n}`, mnemonic: 'mov', syntax: `<LM:Zd:${n}:d>, <za:*:1:${n}:off3>` },
    { id: `mov-az${n}`, of: `mova-az${n}`, mnemonic: 'mov', syntax: `<za:*:1:${n}:off3>, <LM:Zn:${n}:d>` },
  )
}

/* ------------------------------------------------------------------ tile slice loads and stores */

for (let es = 0; es <= 4; es++) {
  const L = LET[es]!
  const bytes = ESIZE[es]! / 8
  const msz = es === 4 ? '1 11' : `0 ${es.toString(2).padStart(2, '0')}`
  const lsl = es ? `, lsl #${es}` : ''
  const name = ['b', 'h', 'w', 'd', 'q'][es]!
  const addrOf = (c: Cpu, f: Fields, e: number) => (c.xsp(f.Rn!) + ((f.Rm === 31 ? 0n : c.x(f.Rm!)) << BigInt(es)) + BigInt(e * bytes)) & M64
  INSTRS.push(
    {
      id: `ld1${name}-za`,
      mnemonic: `ld1${name}`,
      group: G,
      feature: 'sme',
      bits: `1110000 ${msz} 0 Rm:5 V Rv:2 Pg:3 Rn:5 0 ZAo:4`,
      syntax: `<slice1:ZAo:${L}>, <Pg/z>, [<Xn|SP>{, <Xm=31>${lsl}}]`,
      desc: T(`从内存读一行${['字节', '半字', '字', '双字', '四字'][es]}到 tile 的一行（h）或一列（v）；不活跃的元素清零`, `Load ${['bytes', 'halfwords', 'words', 'doublewords', 'quadwords'][es]} from memory into a row (h) or column (v) of a tile; inactive elements become zero`),
      exec(c, f) {
        const { t, i, v } = slicePos(c, f, es, 4)
        const pg = pget(c, f.Pg!, es)
        const vals = pg.map((on, e) => (on ? c.load(addrOf(c, f, e), bytes) : 0n))
        sliceSet(c, es, t, v, i, vals)
      },
    },
    {
      id: `st1${name}-za`,
      mnemonic: `st1${name}`,
      group: G,
      feature: 'sme',
      bits: `1110000 ${msz} 1 Rm:5 V Rv:2 Pg:3 Rn:5 0 ZAo:4`,
      syntax: `<slice1:ZAo:${L}>, <Pg>, [<Xn|SP>{, <Xm=31>${lsl}}]`,
      desc: T('把 tile 的一行（h）或一列（v）的活跃元素存进内存', 'Store the active elements of a row (h) or column (v) of a tile to memory'),
      exec(c, f) {
        const { t, i, v } = slicePos(c, f, es, 4)
        const pg = pget(c, f.Pg!, es)
        const vals = sliceGet(c, es, t, v, i)
        pg.forEach((on, e) => {
          if (on) c.store(addrOf(c, f, e), bytes, vals[e]!)
        })
      },
    },
  )
}

/* ------------------------------------------------------------------ LDR, STR, ZERO */

for (const s of [0, 1]) {
  const m = s ? 'str' : 'ldr'
  INSTRS.push(
    {
      id: `${m}-za`,
      mnemonic: m,
      group: G,
      feature: 'sme',
      bits: `1110000100 ${s} 00000 0 Rv:2 000 Rn:5 0 off4:4`,
      syntax: `za[<Wv>, <u:off4>], [<Xn|SP>{, #<u:off4>, mul vl}]`,
      desc: s
        ? T('把 ZA 的一个向量（第 (Wv + off) mod 行数 行）存到 Xn + off × SVL/8，不分谓词', 'Store one ZA vector (row (Wv + off) mod the number of rows) to Xn + off × SVL/8, unpredicated')
        : T('从 Xn + off × SVL/8 读一个向量到 ZA 的第 (Wv + off) mod 行数 行，不分谓词；也能在非流式模式下用', 'Load one vector from Xn + off × SVL/8 into ZA row (Wv + off) mod the number of rows, unpredicated; also allowed outside Streaming SVE mode'),
      exec(c, f) {
        const n = c.svl
        const r = Number((c.r(0, 12 + f.Rv!) + BigInt(f.off4!)) % BigInt(n))
        const base = (c.xsp(f.Rn!) + BigInt(f.off4! * n)) & M64
        if (s) {
          const row = c.zaRead(r)
          for (let i = 0; i < n; i += 8) c.store((base + BigInt(i)) & M64, Math.min(8, n - i), bytesValue(row, i, Math.min(8, n - i)))
        } else {
          const row = new Uint8Array(n)
          for (let i = 0; i < n; i += 8) storeValue(row, i, Math.min(8, n - i), c.load((base + BigInt(i)) & M64, Math.min(8, n - i)))
          c.zaWrite(r, row)
        }
      },
      needs: NEED.za,
    },
    {
      id: `${m}-zt0`,
      mnemonic: m,
      group: G,
      feature: 'sme2',
      bits: `1110000100 ${s} 11111 100000 Rn:5 00000`,
      syntax: 'zt0, [<Xn|SP>]',
      desc: s ? T('把 ZT0 的 64 字节存到内存', "Store ZT0's 64 bytes to memory") : T('从内存读 64 字节到 ZT0', 'Load 64 bytes from memory into ZT0'),
      exec(c, f) {
        const base = c.xsp(f.Rn!)
        if (s) {
          const zt = c.zt0Read()
          for (let i = 0; i < 64; i += 8) c.store((base + BigInt(i)) & M64, 8, bytesValue(zt, i, 8))
        } else {
          const zt = new Uint8Array(64)
          for (let i = 0; i < 64; i += 8) storeValue(zt, i, 8, c.load((base + BigInt(i)) & M64, 8))
          c.zt0Write(zt)
        }
      },
      needs: NEED.zt0,
    },
  )
}
function bytesValue(b: Uint8Array, at: number, n: number): bigint {
  let v = 0n
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]!)
  return v
}
function storeValue(b: Uint8Array, at: number, n: number, v: bigint): void {
  for (let i = 0; i < n; i++) {
    b[at + i] = Number(v & 0xffn)
    v >>= 8n
  }
}

INSTRS.push(
  {
    id: 'zero-za',
    mnemonic: 'zero',
    group: G,
    feature: 'sme',
    bits: '1100000000001000 00000000 imm8:8',
    syntax: '<zamask>',
    desc: T('把列出的 tile 清零（{za} 是整个 ZA）；在非流式模式下也能用', 'Zero the listed tiles ({za} is all of ZA); also allowed outside Streaming SVE mode'),
    exec(c, f) {
      for (let r = 0; r < c.svl; r++) if (f.imm8! & (1 << r % 8)) c.zaWrite(r, new Uint8Array(c.svl))
    },
    needs: NEED.za,
  },
  {
    id: 'zero-zt0',
    mnemonic: 'zero',
    group: G,
    feature: 'sme2',
    bits: '11000000 01001000 00000000 00000001',
    syntax: '<zt0list>',
    desc: T('把 ZT0 清零', 'Zero ZT0'),
    exec: (c) => c.zt0Write(new Uint8Array(64)),
    needs: NEED.zt0,
  },
)
for (const [opc, n, vg, offw] of [
  ['000', 1, 2, 3],
  ['001', 2, 1, 3],
  ['010', 2, 2, 2],
  ['011', 2, 4, 2],
  ['100', 1, 4, 3],
  ['101', 4, 1, 2],
  ['110', 4, 2, 1],
  ['111', 4, 4, 1],
] as const)
  INSTRS.push({
    id: `zero-zav-${n}x${vg}`,
    mnemonic: 'zero',
    group: G,
    feature: 'sme2p1',
    bits: `1100000000001 1 ${opc} Rv:2 0000000000 ${'0'.repeat(3 - offw)} off:${offw}`,
    syntax: `<za:d:${n}:${vg}:off>`,
    desc: T(`把 ZA 的 ${vg > 1 ? `${vg} 组、每组 ` : ''}${n} 个向量清零`, `Zero ${vg > 1 ? `${vg} groups of ` : ''}${n} ZA vector${n > 1 || vg > 1 ? 's' : ''}`),
    exec(c, f) {
      for (const g of zaVectors(c, f, f.off! * n, n, vg)) for (const r of g) c.zaWrite(r, new Uint8Array(c.svl))
    },
  })

/* ------------------------------------------------------------------ MOVT, LUTI2, LUTI4 */

INSTRS.push(
  {
    id: 'movt-x',
    mnemonic: 'movt',
    group: G,
    feature: 'sme2',
    bits: '11000000010011 0 0 0 off3:3 0011111 Rt:5',
    syntax: '<Xt>, zt0[<u:off3*8>]',
    desc: T('把 ZT0 从第 off 个字节起的 64 位读到 Xt（off 是 8 的倍数）', 'Read the 64 bits of ZT0 at byte off into Xt (off a multiple of 8)'),
    exec(c, f) {
      c.setX(f.Rt!, bytesValue(c.zt0Read(), f.off3! * 8, 8))
    },
    needs: NEED.zt0,
  },
  {
    id: 'movt-zt0',
    mnemonic: 'movt',
    group: G,
    feature: 'sme2',
    bits: '11000000010011 1 0 0 off3:3 0011111 Rt:5',
    syntax: 'zt0[<u:off3*8>], <Xt>',
    desc: T('把 Xt 写进 ZT0 从第 off 个字节起的 64 位', 'Write Xt into the 64 bits of ZT0 at byte off'),
    exec(c, f) {
      const zt = c.zt0Read()
      storeValue(zt, f.off3! * 8, 8, c.x(f.Rt!))
      c.zt0Write(zt)
    },
    needs: NEED.zt0,
  },
)

/**
 * LUTI2 / LUTI4: each destination element is the low bits of 32-bit entry `idx` of ZT0 (whatever the element
 * size), idx being the next 2- or 4-bit field of Zn's chosen segment. `regs` destination registers share one
 * run of indexes.
 */
function luti(c: Cpu, f: Fields, bits: number, es: number, part: number, dest: number[]): void {
  const table = c.zt0Read()
  const N = zget(c, f.Zn!, 0)
  const per = (c.vl * 8) / ESIZE[es]!
  const total = per * dest.length
  const mask = (1n << BigInt(ESIZE[es]!)) - 1n
  const T_ = zget0(table, 2).map((v) => v & mask)
  const idx = (k: number) => {
    const bit = (part * total + k) * bits
    const byte = N[Math.floor(bit / 8) % N.length]!
    return Number((byte >> BigInt(bit % 8)) & ((1n << BigInt(bits)) - 1n))
  }
  dest.forEach((d, r) => zset(c, d, Array.from({ length: per }, (_, e) => T_[idx(r * per + e)]!), es))
}
const zget0 = (bytes: Uint8Array, es: number) => {
  const out: bigint[] = []
  const n = ESIZE[es]! / 8
  for (let i = 0; i < bytes.length; i += n) out.push(bytesValue(bytes, i, n))
  return out
}

for (const [b, m, op] of [
  [2, 'luti2', '11'],
  [4, 'luti4', '101'],
] as const) {
  const iw = b === 2 ? 4 : 3
  INSTRS.push({
    id: `${m}-1`,
    mnemonic: m,
    group: G,
    feature: 'sme2',
    bits: `11000000 1 1 00 ${op} i:${iw} size:2 00 Zn:5 Zd:5`,
    syntax: `<Zd.size>, zt0, <Zn>[<u:i>]`,
    valid: (f) => f.size !== 3,
    desc: T(`查表：Zd 的每个元素取 ZT0 里第 idx 个元素，idx 是 Zn 第 i 段里的下一个 ${b} 位数`, `Table lookup: each element of Zd is element idx of ZT0, idx being the next ${b}-bit field in segment i of Zn`),
    exec: (c, f) => luti(c, f, b, f.size!, f.i!, [f.Zd!]),
    needs: NEED.streaming | NEED.zt0,
  })
  for (const n of [2, 4]) {
    if (b === 4 && n === 4) {
      // LUTI4 into four registers exists for 16- and 32-bit elements only (bytes need SME_LUTv2).
    }
    const w = iw - (n === 2 ? 1 : 2)
    const sel = n === 2 ? '1' : '10'
    INSTRS.push({
      id: `${m}-${n}`,
      mnemonic: m,
      group: G,
      feature: 'sme2',
      bits: `11000000 1 0 00 ${op} i:${w} ${sel} size:2 00 Zn:5 ${n === 2 ? 'Zd:4 0' : 'Zd:3 00'}`,
      syntax: `<LM:Zd:${n}:size>, zt0, <Zn>[<u:i>]`,
      valid: (f) => f.size !== 3 && !(b === 4 && n === 4 && f.size === 0),
      desc: T(`查表到 ${n} 个连续的 z 寄存器（${b} 位索引）`, `Table lookup into ${n} consecutive z registers (${b}-bit indexes)`),
      exec: (c, f) => luti(c, f, b, f.size!, f.i!, Array.from({ length: n }, (_, k) => f.Zd! * n + k)),
      needs: NEED.streaming | NEED.zt0,
    })
    for (const [sz, L] of [
      [0, 'b'],
      [1, 'h'],
    ] as const) {
      if (b === 4 && n === 4 && sz === 0) continue
      INSTRS.push({
        id: `${m}-${n}s-${L}`,
        mnemonic: m,
        group: G,
        feature: 'sme2p1',
        bits: `11000000 1 0 01 ${op} i:${w} ${sel} 0 ${sz} 00 Zn:5 T ${n === 2 ? '0 Zt:3' : '00 Zt:2'}`,
        syntax: `<LS:T:Zt:${n}:${L}>, zt0, <Zn>[<u:i>]`,
        desc: T(`查表到 ${n} 个间隔 ${16 / n} 的 z 寄存器（${b} 位索引）`, `Table lookup into ${n} z registers ${16 / n} apart (${b}-bit indexes)`),
        exec: (c, f) => luti(c, f, b, sz, f.i!, Array.from({ length: n }, (_, k) => f.T! * 16 + f.Zt! + (k * 16) / n)),
        needs: NEED.streaming | NEED.zt0,
      })
    }
  }
}

// Every other instruction here needs Streaming SVE mode and ZA, except mode control and the vector-length reads.
for (const i of INSTRS) if (i.needs === undefined && !['msr-svcr', 'rdsvl', 'addsvl', 'addspl'].includes(i.id)) i.needs = SZA
