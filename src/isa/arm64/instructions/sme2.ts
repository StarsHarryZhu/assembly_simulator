/**
 * SME2 and SME2.1 arithmetic with ZA array vectors as accumulators or results: ADD, SUB and their
 * floating-point forms, FMLA/FMLS and BFMLA/BFMLS, the widening FMLAL/BFMLAL/SMLAL/UMLAL families (two ZA
 * vectors per group), the 4-way SMLALL/UMLALL/USMLALL/SUMLALL families (four per group), the dot products
 * (FDOT, BFDOT, SDOT, UDOT, USDOT, SUDOT) and the vertical dot products (FVDOT, BFVDOT, SVDOT, UVDOT, SUVDOT,
 * USVDOT); each with one, two or four source vectors, and the second source single, multiple or indexed.
 *
 * Operations that accumulate into ZA in floating point use default NaNs and raise no exception flags.
 */
import { T, type Text } from '../../../core/i18n'
import { NEED, type AliasSpec, type InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { ESIZE, sx, ux } from './vec'
import { zget } from './zvec'
import { zaEnv, zaGet, zaSet, zaVectors } from './zavec'
import { bf, bfDotAdd, widenHalf } from './simd-fp'
import * as sf from '../softfloat'

export const INSTRS: InstrSpec[] = []
const G = 'sme2'
const LET = 'bhsdq'


/* ------------------------------------------------------------------ how one ZA element is computed */

/**
 * One operation: `za` and `src` element sizes, `n` ZA vectors per group (2 and 4 for the widening forms,
 * which spread consecutive source elements over the group's vectors), `k` source elements per product
 * (2 and 4 for dot products). `calc` gets the old ZA element, k elements of each source and the environment.
 */
interface Op {
  m: string
  feature: string
  za: number
  src: number
  n: number
  k: number
  desc: Text
  /** The result does not depend on the old ZA value (ADD and SUB with array results). */
  overwrite?: boolean
  calc: (acc: bigint, a: bigint[], b: bigint[], env: sf.FpEnv) => bigint
}

const fmtOf = (es: number) => [sf.BF16, sf.F16, sf.F32, sf.F64][es]!

/** Sum of products of integers, signed or unsigned per operand, added to or subtracted from acc. */
const intDot = (za: number, src: number, uA: boolean, uB: boolean, sub: boolean) => (acc: bigint, a: bigint[], b: bigint[]) => {
  let s = acc
  a.forEach((x, j) => {
    const p = (uA ? x : sx(x, src)) * (uB ? b[j]! : sx(b[j]!, src))
    s = sub ? s - p : s + p
  })
  return ux(s, za)
}

/**
 * BFMulAdd into single precision for ZA: fused, in FPCR's rounding mode even with FPCR.AH set (unlike the
 * Neon and SVE BFMLALB, where AH forces round to nearest; the M5 agrees).
 */
function bfMulAddH(env: sf.FpEnv, acc: bigint, a: bigint, b: bigint): bigint {
  return sf.fpMulAdd(env, sf.F32, acc, bf(a), bf(b), false)
}

/* ------------------------------------------------------------------ the engine */

/** Where the second source comes from for group r. */
type Second = { kind: 'none' | 'single' | 'multi' } | { kind: 'index' | 'vertical'; idx: string[]; w: number[] }

/** A vector of Zm with the k-element chunk `i` of each 128-bit segment repeated across the segment. */
function broadcast(M: bigint[], src: number, k: number, i: number): bigint[] {
  const seg = 128 / ESIZE[src]!
  return M.map((_, x) => M[x - (x % seg) + i * k + (x % k)]!)
}

/** An index made of fields, the first the most significant. */
const idxOf = (f: Fields, names: string[], w: number[]) => names.reduce((v, name, j) => (v << w[j]!) | f[name]!, 0)

function run(c: Cpu, f: Fields, o: Op, vg: number, nregs: number, first: number, multiFirst: boolean, second: Second): void {
  const rows = zaVectors(c, f, (f.off ?? 0) * o.n, o.n, vg)
  const env = zaEnv(c)
  const zn = (r: number) => (multiFirst ? first * nregs + r : (first + r) % 32)
  const Ns = Array.from({ length: nregs }, (_, r) => zget(c, zn(r), o.src))
  const R = o.n * o.k
  if (second.kind === 'vertical') {
    const M = zget(c, f.Zm!, o.src)
    const i = idxOf(f, second.idx, second.w)
    const ways = nregs
    rows.forEach(([row], r) => {
      const seg = 128 / ESIZE[o.za]!
      zaSet(c, row!, zaGet(c, row!, o.za).map((acc, e) => {
        const s = e - (e % seg) + i
        const a = Ns.map((N) => N[ways * e + r]!)
        const b = Ns.map((_, j) => M[ways * s + j]!)
        return o.calc(acc, a, b, env)
      }), o.za)
    })
    return
  }
  let Ms: bigint[][] = []
  if (second.kind === 'single') Ms = Array(vg).fill(zget(c, f.Zm!, o.src))
  else if (second.kind === 'multi') Ms = Array.from({ length: vg }, (_, r) => zget(c, f.Zm! * vg + r, o.src))
  else if (second.kind === 'index') Ms = Array(vg).fill(broadcast(zget(c, f.Zm!, o.src), o.src, o.k, idxOf(f, second.idx, second.w)))
  rows.forEach((group, r) => {
    const N = Ns[r]!
    const M = Ms[r]
    group.forEach((row, i) => {
      const old = o.overwrite ? null : zaGet(c, row, o.za)
      const count = (c.svl * 8) / ESIZE[o.za]!
      const out = Array.from({ length: count }, (_, e) => {
        const at = R * e + i * o.k
        return o.calc(old ? old[e]! : 0n, N.slice(at, at + o.k), M ? M.slice(at, at + o.k) : [], env)
      })
      zaSet(c, row, out, o.za)
    })
  })
}

/* ------------------------------------------------------------------ encodings */

interface Enc {
  /** Multiple and single vector: bit 22, bits 12–10, bits 4–0 before the offset (vgx2 and vgx4). */
  S?: [number, string, string]
  /** Multiple vectors: bit 22, bits 12–10, bits 4–0 before the offset. */
  M?: [number, string, string]
  /** Multiple and indexed: bits 23–20, bits 12–10, bit 5, bits 4–0; index fields high first. */
  I?: [string, string, string, string, string[], number[]]
  /** Vertical dot product (indexed), with its single vector-group count. */
  V?: [string, string, string, string, string[], number[], number]
  /** One vector and single (no vgx): bit 22, bits 12–10, bits 4–0 before the offset. */
  O?: [number, string, string]
  /** One vector and indexed: bits 23–20, bit 15, bits 12–10, bits 4–0; index fields high first. */
  OI?: [string, string, string, string, string[]]
  /** ZA accumulator only: bits 22 and 18, bits 4–3. */
  A?: [number, number, string]
}

/** The ZA offset field width for n vectors per group: what bits 4–0 leave over. */
const offW = (low: string) => 5 - low.replace(/\s/g, '').length

function add(o: Op, e: Enc): void {
  const zl = LET[o.za]!
  const sl = LET[o.src]!
  const za = (vg: number, w: number) => `<za:${zl}:${o.n}:${vg}:${w ? 'off' : '-'}>`
  const off = (w: number) => (w ? `off:${w}` : '')
  const base = { mnemonic: o.m, group: G, feature: o.feature, needs: NEED.streaming | NEED.za }
  const what = (s: Text) => T(`${o.desc.zh}；${s.zh}`, `${o.desc.en}; ${s.en}`)
  for (const vg of [2, 4]) {
    const v4 = vg === 4 ? 1 : 0
    if (e.S) {
      const [X, P, low] = e.S
      const w = offW(low)
      INSTRS.push({
        ...base,
        id: `${o.m}-${zl}${sl}-s${vg}`,
        bits: `11000001 0 ${X} 1 ${v4} Zm:4 0 Rv:2 ${P} Zn:5 ${low} ${off(w)}`,
        syntax: `${za(vg, w)}, <L:Zn:${vg}:${sl}>, <Zm.${sl}>`,
        desc: what(T(`${vg} 组，第二个源是同一个 z 寄存器`, `${vg} groups, the same second source for each`)),
        exec: (c, f) => run(c, f, o, vg, vg, f.Zn!, false, { kind: 'single' }),
      })
    }
    if (e.M) {
      const [X, P, low] = e.M
      const w = offW(low)
      INSTRS.push({
        ...base,
        id: `${o.m}-${zl}${sl}-m${vg}`,
        bits: vg === 2 ? `11000001 1 ${X} 1 Zm:4 0 0 Rv:2 ${P} Zn:4 0 ${low} ${off(w)}` : `11000001 1 ${X} 1 Zm:3 0 1 0 Rv:2 ${P} Zn:3 00 ${low} ${off(w)}`,
        syntax: `${za(vg, w)}, <LM:Zn:${vg}:${sl}>, <LM:Zm:${vg}:${sl}>`,
        desc: what(T(`${vg} 组，每组用各自的第二个源`, `${vg} groups, each with its own second source`)),
        exec: (c, f) => run(c, f, o, vg, vg, f.Zn!, true, { kind: 'multi' }),
      })
    }
    if (e.I) {
      const [hi4, mid3, b5, low, idx, iw] = e.I
      const w = offW(low.replace(/i[hl]?(:\d)?/g, (m) => '0'.repeat(Number(m.split(':')[1] ?? 1))))
      INSTRS.push({
        ...base,
        id: `${o.m}-${zl}${sl}-i${vg}`,
        bits: `11000001 ${hi4} Zm:4 ${v4} Rv:2 ${mid3} ${vg === 2 ? 'Zn:4' : 'Zn:3 0'} ${b5} ${low} ${off(w)}`,
        syntax: `${za(vg, w)}, <LM:Zn:${vg}:${sl}>, <Zm.${sl}[${idx.join('+')}]>`,
        desc: what(T(`${vg} 组，第二个源取 Zm 每个 128 位段里的第 i ${o.k > 1 ? '组' : '个'}元素`, `${vg} groups, the second source being ${o.k > 1 ? 'group' : 'element'} i of each 128-bit segment of Zm`)),
        exec: (c, f) => run(c, f, o, vg, vg, f.Zn!, true, { kind: 'index', idx, w: iw }),
      })
    }
    if (e.V && e.V[6] === vg) {
      const [hi4, mid3, b5, low, idx, iw] = e.V
      INSTRS.push({
        ...base,
        id: `${o.m}-${zl}${sl}-v${vg}`,
        bits: `11000001 ${hi4} Zm:4 ${v4} Rv:2 ${mid3} ${vg === 2 ? 'Zn:4' : 'Zn:3 0'} ${b5} ${low} off:3`,
        syntax: `${za(vg, 3)}, <LM:Zn:${vg}:${sl}>, <Zm.${sl}[${idx.join('+')}]>`,
        desc: o.desc,
        exec: (c, f) => run(c, f, o, vg, vg, f.Zn!, true, { kind: 'vertical', idx, w: iw }),
      })
    }
    if (e.A) {
      const [X, H, q] = e.A
      INSTRS.push({
        ...base,
        id: `${o.m}-${zl}-a${vg}`,
        bits: `11000001 1 ${X} 10 0 ${H} 0 ${v4} 0 Rv:2 111 ${vg === 2 ? 'Zn:4 0' : 'Zn:3 00'} ${q} off:3`,
        syntax: `${za(vg, 3)}, <LM:Zn:${vg}:${sl}>`,
        desc: what(T(`${vg} 组`, `${vg} groups`)),
        exec: (c, f) => run(c, f, o, vg, vg, f.Zn!, true, { kind: 'none' }),
      })
    }
  }
  if (e.O) {
    const [X, P, low] = e.O
    const w = offW(low)
    INSTRS.push({
      ...base,
      id: `${o.m}-${zl}${sl}-1`,
      bits: `11000001 0 ${X} 10 Zm:4 0 Rv:2 ${P} Zn:5 ${low} ${off(w)}`,
      syntax: `${za(1, w)}, <Zn.${sl}>, <Zm.${sl}>`,
      desc: o.desc,
      exec: (c, f) => run(c, f, o, 1, 1, f.Zn!, false, { kind: 'single' }),
    })
  }
  if (e.OI) {
    const [hi4, b15, mid3, low, idx] = e.OI
    const w = offW(low)
    const iw = idx.map((name) => {
      const m = new RegExp(`${name}(?::(\\d))?\\b`).exec(`${b15} ${mid3}`)
      return Number(m?.[1] ?? 1)
    })
    INSTRS.push({
      ...base,
      id: `${o.m}-${zl}${sl}-1i`,
      bits: `11000001 ${hi4} Zm:4 ${b15} Rv:2 ${mid3} Zn:5 ${low} ${off(w)}`,
      syntax: `${za(1, w)}, <Zn.${sl}>, <Zm.${sl}[${idx.join('+')}]>`,
      desc: what(T('第二个源取 Zm 每个 128 位段里的第 i 个元素', 'the second source being element i of each 128-bit segment of Zm')),
      exec: (c, f) => run(c, f, o, 1, 1, f.Zn!, false, { kind: 'index', idx, w: iw }),
    })
  }
}

/* ------------------------------------------------------------------ ADD, SUB, FADD, FSUB, BFADD, BFSUB */

const sizeName = (es: number) => T(['8 位', '16 位', '32 位', '64 位'][es]!, ['8-bit', '16-bit', '32-bit', '64-bit'][es]!)
const fpName = (es: number, bf16 = false) => (bf16 ? T('BF16', 'BFloat16') : T(['', '半精度', '单精度', '双精度'][es]!, ['', 'half-precision', 'single-precision', 'double-precision'][es]!))

for (const [za, X, feat] of [
  [2, 0, 'sme2'],
  [3, 1, 'sme-i16i64'],
] as const) {
  for (const [sub, q] of [
    [false, '10'],
    [true, '11'],
  ] as const) {
    const m = sub ? 'sub' : 'add'
    add(
      { m, feature: feat, za, src: za, n: 1, k: 1, desc: T(`ZA 向量${sub ? '减去' : '加上'} z 寄存器（${sizeName(za).zh}整数）`, `${sub ? 'Subtract' : 'Add'} z registers ${sub ? 'from' : 'to'} ZA vectors (${sizeName(za).en} integers)`), calc: (acc, a) => ux(sub ? acc - a[0]! : acc + a[0]!, za) },
      { A: [X, 0, q] },
    )
    add(
      { m, feature: feat, za, src: za, n: 1, k: 1, overwrite: true, desc: T(`Zn ${sub ? '减' : '加'} Zm 的结果写进 ZA 向量（${sizeName(za).zh}整数）`, `Zn ${sub ? 'minus' : 'plus'} Zm written to ZA vectors (${sizeName(za).en} integers)`), calc: (_acc, a, b) => ux(sub ? a[0]! - b[0]! : a[0]! + b[0]!, za) },
      { S: [X, '110', `${q}`], M: [X, '110', `${q}`] },
    )
  }
}
for (const [za, X, H, bf16, feat] of [
  [2, 0, 0, false, 'sme2'],
  [3, 1, 0, false, 'sme-f64f64'],
  [1, 0, 1, false, 'sme-f16f16'],
  [1, 1, 1, true, 'sme-b16b16'],
] as const) {
  for (const sub of [false, true]) {
    const fmt = bf16 ? sf.BF16 : fmtOf(za)
    add(
      {
        m: `${bf16 ? 'bf' : 'f'}${sub ? 'sub' : 'add'}`,
        feature: feat,
        za,
        src: za,
        n: 1,
        k: 1,
        desc: T(`ZA 向量${sub ? '减去' : '加上'} z 寄存器（${fpName(za, bf16).zh}浮点）`, `${sub ? 'Subtract' : 'Add'} z registers ${sub ? 'from' : 'to'} ZA vectors (${fpName(za, bf16).en} floating point)`),
        calc: (acc, a, _b, env) => sf.fpAdd(env, fmt, acc, a[0]!, sub, false),
      },
      { A: [X, H, sub ? '01' : '00'] },
    )
  }
}

/* ------------------------------------------------------------------ FMLA, FMLS, BFMLA, BFMLS */

for (const [za, X, feat, bf16, S, M, I] of [
  [2, 0, 'sme2', false, '110', ['110', ''], ['0101', '0 i:2', '0', ['i'], [2]]],
  [3, 1, 'sme-f64f64', false, '110', ['110', ''], ['1101', '00 i', '0', ['i'], [1]]],
  [1, 0, 'sme-f16f16', false, '111', ['100', '1'], ['0001', '1 ih:2', '0', ['ih', 'il'], [2, 1]]],
  [1, 1, 'sme-b16b16', true, '111', ['100', '1'], ['0001', '1 ih:2', '1', ['ih', 'il'], [2, 1]]],
] as const) {
  for (const sub of [false, true]) {
    const fmt = bf16 ? sf.BF16 : fmtOf(za)
    const s = sub ? 1 : 0
    add(
      {
        m: `${bf16 ? 'bf' : 'f'}ml${sub ? 's' : 'a'}`,
        feature: feat,
        za,
        src: za,
        n: 1,
        k: 1,
        desc: T(`${fpName(za, bf16).zh}乘${sub ? '减' : '加'}：Zn × Zm ${sub ? '从 ZA 向量减去' : '加到 ZA 向量'}（融合）`, `${fpName(za, bf16).en} multiply-${sub ? 'subtract' : 'add'}: Zn × Zm ${sub ? 'subtracted from' : 'added to'} ZA vectors (fused)`),
        calc: (acc, a, b, env) => sf.fpMulAdd(env, fmt, acc, sub ? sf.fpNeg(env, fmt, a[0]!) : a[0]!, b[0]!, false),
      },
      {
        S: [X, S, `0${s}`],
        M: [X, M[0], M[1] ? `${s}1` : `0${s}`],
        I: [I[0], I[1], I[2], I[3].length > 1 ? `${s} il` : `${s}0`, [...I[3]], [...I[4]]],
      },
    )
  }
}

/* ------------------------------------------------------------------ widening: FMLAL … UMLSL (2 vectors), SMLALL … (4 vectors) */

for (const [X, list] of [
  [0, [['fmlal', false, false], ['fmlsl', true, false], ['bfmlal', false, true], ['bfmlsl', true, true]]],
  [1, [['smlal', false, false], ['smlsl', true, false], ['umlal', false, true], ['umlsl', true, true]]],
] as const) {
  list.forEach(([m, sub, alt], q) => {
    const q2 = q.toString(2).padStart(2, '0')
    const desc = X
      ? T(`16 位${alt ? '无符号' : '有符号'}整数相乘，乘积${sub ? '从' : '加到'}两个 32 位 ZA 向量${sub ? '减去' : ''}：偶数号元素进第一个，奇数号进第二个`, `Multiply ${alt ? 'unsigned' : 'signed'} 16-bit integers and ${sub ? 'subtract the products from' : 'add the products to'} two 32-bit ZA vectors: even elements to the first, odd to the second`)
      : T(`${alt ? 'BF16' : '半精度'}相乘（加宽到单精度，融合），乘积${sub ? '从' : '加到'}两个单精度 ZA 向量${sub ? '减去' : ''}：偶数号元素进第一个，奇数号进第二个`, `Multiply ${alt ? 'BFloat16' : 'half-precision'} values (widened to single precision, fused) and ${sub ? 'subtract the products from' : 'add the products to'} two single-precision ZA vectors: even elements to the first, odd to the second`)
    const calc: Op['calc'] = X
      ? intDot(2, 1, alt, alt, sub)
      : alt
        ? (acc, a, b, env) => bfMulAddH(env, acc, sub ? sf.fpNeg(env, sf.BF16, a[0]!) : a[0]!, b[0]!)
        : (acc, a, b, env) => sf.fpMulAdd(env, sf.F32, acc, widenHalf(env, sub ? sf.fpNeg(env, sf.F16, a[0]!) : a[0]!), widenHalf(env, b[0]!), false)
    add(
      { m, feature: 'sme2', za: 2, src: 1, n: 2, k: 1, desc, calc },
      {
        S: [X, '010', `${q2}0`],
        M: [X, '010', `${q2}0`],
        I: [X ? '1101' : '1001', '1 ih:2', '0', `${q2} il`, ['ih', 'il'], [2, 1]],
        O: [X, '011', q2],
        OI: [X ? '1100' : '1000', 'ih', '1 il:2', q2, ['ih', 'il']],
      },
    )
  })
}

// [mnemonic, subtract, Zn unsigned, Zm unsigned, bits 4–2 (single forms), bits 5 and 4–3 (indexed)]
for (const [m, sub, uA, uB, q3, Ib5, Iq] of [
  ['smlall', false, false, false, '000', '0', '00'],
  ['smlsll', true, false, false, '010', '0', '01'],
  ['umlall', false, true, true, '100', '0', '10'],
  ['umlsll', true, true, true, '110', '0', '11'],
  ['usmlall', false, true, false, '001', '1', '00'],
  ['sumlall', false, false, true, '101', '1', '10'],
] as const) {
  for (const [za, src, X] of [
    [2, 0, 0],
    [3, 1, 1],
  ] as const) {
    if (uA !== uB && za === 3) continue
    const kind = uA === uB ? (uA ? T('无符号', 'unsigned') : T('有符号', 'signed')) : uA ? T('Zn 无符号、Zm 有符号', 'Zn unsigned, Zm signed') : T('Zn 有符号、Zm 无符号', 'Zn signed, Zm unsigned')
    const desc = T(
      `${sizeName(src).zh}整数（${kind.zh}）相乘，乘积${sub ? '从' : '加到'}四个${sizeName(za).zh} ZA 向量${sub ? '减去' : ''}：第 4e+i 个元素进第 i 个向量`,
      `Multiply ${sizeName(src).en} integers (${kind.en}) and ${sub ? 'subtract the products from' : 'add the products to'} four ${sizeName(za).en} ZA vectors: element 4e+i goes to vector i`,
    )
    const enc: Enc = {
      S: [X, '000', `${q3}0`],
      I: [za === 2 ? '0001' : '1001', za === 2 ? '0 ih:2' : '00 ih', Ib5, `${Iq} il:2`, ['ih', 'il'], [za === 2 ? 2 : 1, 2]],
      OI: [za === 2 ? '0000' : '1000', 'ih', za === 2 ? 'il:3' : '0 il:2', q3, ['ih', 'il']],
    }
    if (m !== 'sumlall') {
      enc.M = [X, '000', `${q3}0`]
      enc.O = [X, '001', q3]
    }
    add({ m, feature: za === 3 ? 'sme-i16i64' : 'sme2', za, src, n: 4, k: 1, desc, calc: intDot(za, src, uA, uB, sub) }, enc)
  }
}

/* ------------------------------------------------------------------ dot products */

for (const [m, za, src, X, feat, S, I, calc, desc] of [
  ['fdot', 2, 1, 0, 'sme2', ['100', '00'], ['0101', '1 i:2', '0', '01'], (acc: bigint, a: bigint[], b: bigint[], env: sf.FpEnv) => sf.fpAdd(env, sf.F32, acc, sf.fpDot(env, sf.F16, a[0]!, a[1]!, b[0]!, b[1]!, false), false, false), T('半精度点积：每两对相乘求和（舍入一次），加到单精度 ZA 向量', 'Half-precision dot product: two products summed (rounded once) and added to single-precision ZA vectors')],
  ['bfdot', 2, 1, 0, 'sme2', ['100', '10'], ['0101', '1 i:2', '0', '11'], (acc: bigint, a: bigint[], b: bigint[], env: sf.FpEnv) => bfDotAdd(acc, a[0]!, a[1]!, b[0]!, b[1]!, env.fpcr), T('BF16 点积：每两对相乘求和，加到单精度 ZA 向量（向奇数舍入，非规格化数当 0）', 'BFloat16 dot product: two products summed and added to single-precision ZA vectors (round to odd, denormals as zero)')],
  ['sdot', 2, 0, 0, 'sme2', ['101', '00'], ['0101', '1 i:2', '1', '00'], intDot(2, 0, false, false, false), T('8 位有符号整数点积：每四对相乘求和，加到 32 位 ZA 向量', 'Signed 8-bit dot product: four products summed into 32-bit ZA vectors')],
  ['udot', 2, 0, 0, 'sme2', ['101', '10'], ['0101', '1 i:2', '1', '10'], intDot(2, 0, true, true, false), T('8 位无符号整数点积：每四对相乘求和，加到 32 位 ZA 向量', 'Unsigned 8-bit dot product: four products summed into 32-bit ZA vectors')],
  ['usdot', 2, 0, 0, 'sme2', ['101', '01'], ['0101', '1 i:2', '1', '01'], intDot(2, 0, true, false, false), T('8 位点积（Zn 无符号、Zm 有符号），加到 32 位 ZA 向量', '8-bit dot product (Zn unsigned, Zm signed) into 32-bit ZA vectors')],
  ['sudot', 2, 0, 0, 'sme2', ['101', '11'], ['0101', '1 i:2', '1', '11'], intDot(2, 0, false, true, false), T('8 位点积（Zn 有符号、Zm 无符号），加到 32 位 ZA 向量', '8-bit dot product (Zn signed, Zm unsigned) into 32-bit ZA vectors')],
  ['sdot', 2, 1, 1, 'sme2', ['101', '01'], ['0101', '1 i:2', '0', '00'], intDot(2, 1, false, false, false), T('16 位有符号整数点积：每两对相乘求和，加到 32 位 ZA 向量', 'Signed 16-bit dot product: two products summed into 32-bit ZA vectors')],
  ['udot', 2, 1, 1, 'sme2', ['101', '11'], ['0101', '1 i:2', '0', '10'], intDot(2, 1, true, true, false), T('16 位无符号整数点积：每两对相乘求和，加到 32 位 ZA 向量', 'Unsigned 16-bit dot product: two products summed into 32-bit ZA vectors')],
  ['sdot', 3, 1, 1, 'sme-i16i64', ['101', '00'], ['1101', '00 i', '0', '01'], intDot(3, 1, false, false, false), T('16 位有符号整数点积：每四对相乘求和，加到 64 位 ZA 向量', 'Signed 16-bit dot product: four products summed into 64-bit ZA vectors')],
  ['udot', 3, 1, 1, 'sme-i16i64', ['101', '10'], ['1101', '00 i', '0', '11'], intDot(3, 1, true, true, false), T('16 位无符号整数点积：每四对相乘求和，加到 64 位 ZA 向量', 'Unsigned 16-bit dot product: four products summed into 64-bit ZA vectors')],
] as const) {
  const k = ESIZE[za]! / ESIZE[src]!
  const enc: Enc = { S: [X, S[0], S[1]], I: [I[0], I[1], I[2], I[3], ['i'], [I[1].endsWith(':2') ? 2 : 1]] }
  if (m !== 'sudot') enc.M = [X, S[0], S[1]]
  add({ m, feature: feat, za, src, n: 1, k, desc, calc }, enc)
}

for (const [m, za, src, vg, hi4, mid3, b5, low, calc, desc] of [
  ['fvdot', 2, 1, 2, '0101', '0 i:2', '0', '01', (acc: bigint, a: bigint[], b: bigint[], env: sf.FpEnv) => sf.fpAdd(env, sf.F32, acc, sf.fpDot(env, sf.F16, a[0]!, a[1]!, b[0]!, b[1]!, false), false, false), T('半精度纵向点积：第 r 个 ZA 向量的元素 e 取两个源向量的第 2e+r 个元素', 'Half-precision vertical dot product: element e of ZA vector r takes element 2e+r of both source vectors')],
  ['bfvdot', 2, 1, 2, '0101', '0 i:2', '0', '11', (acc: bigint, a: bigint[], b: bigint[], env: sf.FpEnv) => bfDotAdd(acc, a[0]!, a[1]!, b[0]!, b[1]!, env.fpcr), T('BF16 纵向点积：第 r 个 ZA 向量的元素 e 取两个源向量的第 2e+r 个元素', 'BFloat16 vertical dot product: element e of ZA vector r takes element 2e+r of both source vectors')],
  ['svdot', 2, 1, 2, '0101', '0 i:2', '1', '00', intDot(2, 1, false, false, false), T('16 位有符号纵向点积：第 r 个 ZA 向量的元素 e 取两个源向量的第 2e+r 个元素', 'Signed 16-bit vertical dot product: element e of ZA vector r takes element 2e+r of both source vectors')],
  ['uvdot', 2, 1, 2, '0101', '0 i:2', '1', '10', intDot(2, 1, true, true, false), T('16 位无符号纵向点积：第 r 个 ZA 向量的元素 e 取两个源向量的第 2e+r 个元素', 'Unsigned 16-bit vertical dot product: element e of ZA vector r takes element 2e+r of both source vectors')],
  ['svdot', 2, 0, 4, '0101', '0 i:2', '1', '00', intDot(2, 0, false, false, false), T('8 位有符号纵向点积：第 r 个 ZA 向量的元素 e 取四个源向量的第 4e+r 个元素', 'Signed 8-bit vertical dot product: element e of ZA vector r takes element 4e+r of the four source vectors')],
  ['uvdot', 2, 0, 4, '0101', '0 i:2', '1', '10', intDot(2, 0, true, true, false), T('8 位无符号纵向点积：第 r 个 ZA 向量的元素 e 取四个源向量的第 4e+r 个元素', 'Unsigned 8-bit vertical dot product: element e of ZA vector r takes element 4e+r of the four source vectors')],
  ['usvdot', 2, 0, 4, '0101', '0 i:2', '1', '01', intDot(2, 0, true, false, false), T('8 位纵向点积（Zn 无符号、Zm 有符号）', '8-bit vertical dot product (Zn unsigned, Zm signed)')],
  ['suvdot', 2, 0, 4, '0101', '0 i:2', '1', '11', intDot(2, 0, false, true, false), T('8 位纵向点积（Zn 有符号、Zm 无符号）', '8-bit vertical dot product (Zn signed, Zm unsigned)')],
  ['svdot', 3, 1, 4, '1101', '01 i', '0', '01', intDot(3, 1, false, false, false), T('16 位有符号纵向点积，加到 64 位 ZA 向量：元素 e 取四个源向量的第 4e+r 个元素', 'Signed 16-bit vertical dot product into 64-bit ZA vectors: element e takes element 4e+r of the four source vectors')],
  ['uvdot', 3, 1, 4, '1101', '01 i', '0', '11', intDot(3, 1, true, true, false), T('16 位无符号纵向点积，加到 64 位 ZA 向量：元素 e 取四个源向量的第 4e+r 个元素', 'Unsigned 16-bit vertical dot product into 64-bit ZA vectors: element e takes element 4e+r of the four source vectors')],
] as const) {
  add({ m, feature: za === 3 ? 'sme-i16i64' : 'sme2', za, src, n: 1, k: ESIZE[za]! / ESIZE[src]!, desc, calc }, { V: [hi4, mid3, b5, low, ['i'], [mid3.endsWith(':2') ? 2 : 1], vg] })
}

export const ALIASES: AliasSpec[] = []
