/**
 * SME2 and SME2.1 multi-vector instructions on groups of two or four z registers: maximum and minimum,
 * rounding shifts, ADD and SQDMULH with a single or a multi-vector second source, the clamps, ZIP and UZP,
 * conversions and rounding, saturating narrowing (SQCVT…) and narrowing shifts (SQRSHR…), the unpacks, SEL
 * by a predicate-as-counter, and the multi-vector loads and stores LD1/LDNT1/ST1/STNT1 (consecutive and
 * strided registers).
 */
import { T, type Text } from '../../../core/i18n'
import { NEED, type AliasSpec, type InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { ESIZE, sat, shiftReg, shiftSve, sx, ux } from './vec'
import { zget, zset } from './zvec'
import { counterBits } from './sve-pred'
import * as sf from '../softfloat'

export const INSTRS: InstrSpec[] = []
export const ALIASES: AliasSpec[] = []
const G = 'sme2'
const LET = 'bhsdq'
const M64 = (1n << 64n) - 1n
const STREAMING = NEED.streaming
const FMT = [sf.BF16, sf.F16, sf.F32, sf.F64]

/** The registers of a list: consecutive from first × n, or strided (16 / n apart) from first. */
const regsOf = (first: number, n: number, strided = false) => Array.from({ length: n }, (_, r) => (strided ? first + (r * 16) / n : first * n + r))
const elemsOf = (c: Cpu, es: number) => (c.vl * 8) / ESIZE[es]!

/**
 * For each register of a multi-vector destination, Zdn op the matching (or the single) second source. A
 * single Zm is read once, before any result is written, even when it is one of the destinations (the M5
 * agrees).
 */
function binary(c: Cpu, f: Fields, es: number, vg: number, multi: boolean, fn: (a: bigint, b: bigint, env: sf.FpEnv) => bigint, fp: boolean): void {
  const env = c.fpEnv()
  const single = multi ? null : zget(c, f.Zm!, es)
  regsOf(f.Zdn!, vg).forEach((d, r) => {
    const A = zget(c, d, es)
    const B = single ?? zget(c, f.Zm! * vg + r, es)
    zset(c, d, A.map((a, i) => fn(a, B[i]!, env)), es)
  })
  if (fp) c.fpFlags(env)
}

/* ------------------------------------------------------------------ max, min, shifts, add, sqdmulh */

interface Bin {
  m: string
  opA: string
  opB: string
  o: number
  /** 'int' for every size, 'fp' for h/s/d with a BFloat16 twin `bf` in size 00. */
  kind: 'int' | 'fp'
  bf?: string
  single?: boolean
  desc: Text
  fn: (es: number, fmt: sf.Fmt) => (a: bigint, b: bigint, env: sf.FpEnv) => bigint
}

const smax = (es: number) => (a: bigint, b: bigint) => (sx(a, es) > sx(b, es) ? a : b)
const smin = (es: number) => (a: bigint, b: bigint) => (sx(a, es) < sx(b, es) ? a : b)
const BINS: Bin[] = [
  { m: 'smax', opA: '000', opB: '000', o: 0, kind: 'int', desc: T('有符号最大值', 'Signed maximum'), fn: (es) => smax(es) },
  { m: 'umax', opA: '000', opB: '000', o: 1, kind: 'int', desc: T('无符号最大值', 'Unsigned maximum'), fn: () => (a, b) => (a > b ? a : b) },
  { m: 'smin', opA: '000', opB: '001', o: 0, kind: 'int', desc: T('有符号最小值', 'Signed minimum'), fn: (es) => smin(es) },
  { m: 'umin', opA: '000', opB: '001', o: 1, kind: 'int', desc: T('无符号最小值', 'Unsigned minimum'), fn: () => (a, b) => (a < b ? a : b) },
  { m: 'fmax', opA: '001', opB: '000', o: 0, kind: 'fp', bf: 'bfmax', desc: T('最大值（有 NaN 时结果是 NaN）', 'Maximum (a NaN gives NaN)'), fn: (_es, t) => (a, b, e) => sf.fpMaxMin(e, t, a, b, true, true) },
  { m: 'fmin', opA: '001', opB: '000', o: 1, kind: 'fp', bf: 'bfmin', desc: T('最小值（有 NaN 时结果是 NaN）', 'Minimum (a NaN gives NaN)'), fn: (_es, t) => (a, b, e) => sf.fpMaxMin(e, t, a, b, false, true) },
  { m: 'fmaxnm', opA: '001', opB: '001', o: 0, kind: 'fp', bf: 'bfmaxnm', desc: T('最大值（一个是 NaN 时取另一个数）', 'Maximum number (a quiet NaN loses to a number)'), fn: (_es, t) => (a, b, e) => sf.fpMaxMinNum(e, t, a, b, true) },
  { m: 'fminnm', opA: '001', opB: '001', o: 1, kind: 'fp', bf: 'bfminnm', desc: T('最小值（一个是 NaN 时取另一个数）', 'Minimum number (a quiet NaN loses to a number)'), fn: (_es, t) => (a, b, e) => sf.fpMaxMinNum(e, t, a, b, false) },
  { m: 'srshl', opA: '010', opB: '001', o: 0, kind: 'int', desc: T('有符号舍入移位：第二个源为正左移、为负右移（舍入）', 'Signed rounding shift: left by a positive second source, right (rounded) by a negative one'), fn: (es) => (a, b) => shiftSve(a, b, es, false, true, false) },
  { m: 'urshl', opA: '010', opB: '001', o: 1, kind: 'int', desc: T('无符号舍入移位：第二个源为正左移、为负右移（舍入）', 'Unsigned rounding shift: left by a positive second source, right (rounded) by a negative one'), fn: (es) => (a, b) => shiftSve(a, b, es, true, true, false) },
  { m: 'add', opA: '011', opB: '000', o: 0, kind: 'int', single: true, desc: T('加', 'Add'), fn: (es) => (a, b) => ux(a + b, es) },
  { m: 'sqdmulh', opA: '100', opB: '000', o: 0, kind: 'int', desc: T('有符号相乘乘 2，取高半（饱和）', 'Signed multiply, doubled, high half (saturating)'), fn: (es) => (a, b) => sat((2n * sx(a, es) * sx(b, es)) >> BigInt(ESIZE[es]!), es, false)[0] },
]

for (const o of BINS) {
  const variants: [string, string, string, number | null, string][] = [[o.m, 'size:2', 'size', null, o.kind === 'fp' ? 'sme2' : 'sme2']]
  if (o.bf) variants.push([o.bf, '00', 'h', 0, 'sme-b16b16'])
  for (const [m, sizeBits, letter, fixedFmt, feature] of variants) {
    const valid = o.kind === 'fp' && fixedFmt === null ? (f: Fields) => f.size !== 0 : undefined
    const run = (c: Cpu, f: Fields, vg: number, multi: boolean) => {
      const es = fixedFmt === null ? f.size! : 1
      const fmt = fixedFmt === null ? FMT[es]! : sf.BF16
      binary(c, f, es, vg, multi, o.fn(es, fmt), o.kind === 'fp')
    }
    for (const vg of [2, 4]) {
      const v4 = vg === 4 ? 1 : 0
      const zdn = vg === 2 ? 'Zdn:4' : 'Zdn:3 0'
      const list = `<LM:Zdn:${vg}:${letter}>`
      INSTRS.push({
        id: `${m}-${vg}-single`,
        mnemonic: m,
        group: G,
        feature,
        bits: `11000001 ${sizeBits} 10 Zm:4 1010 ${v4} ${o.opA} ${o.opB} ${zdn} ${o.o}`,
        syntax: `${list}, ${list}, <Zm.${letter}>`,
        valid,
        desc: T(`${o.desc.zh}：${vg} 个 z 寄存器各自和同一个 Zm 运算`, `${o.desc.en}: each of ${vg} z registers with the same Zm`),
        exec: (c, f) => run(c, f, vg, false),
        needs: STREAMING,
      })
      if (!o.single)
        INSTRS.push({
          id: `${m}-${vg}-multi`,
          mnemonic: m,
          group: G,
          feature,
          bits: vg === 2 ? `11000001 ${sizeBits} 1 Zm:4 0 1011 0 ${o.opA} ${o.opB} Zdn:4 ${o.o}` : `11000001 ${sizeBits} 1 Zm:3 00 1011 1 ${o.opA} ${o.opB} Zdn:3 0 ${o.o}`,
          syntax: `${list}, ${list}, <LM:Zm:${vg}:${letter}>`,
          valid,
          desc: T(`${o.desc.zh}：${vg} 个 z 寄存器两两运算`, `${o.desc.en}: ${vg} pairs of z registers`),
          exec: (c, f) => run(c, f, vg, true),
          needs: STREAMING,
        })
    }
  }
}

/* ------------------------------------------------------------------ clamps */

for (const [m, int, U, sizeBits, letter, feature] of [
  ['sclamp', 1, 0, 'size:2', 'size', 'sme2'],
  ['uclamp', 1, 1, 'size:2', 'size', 'sme2'],
  ['fclamp', 0, 0, 'size:2', 'size', 'sme2'],
  ['bfclamp', 0, 0, '00', 'h', 'sme-b16b16'],
] as const) {
  for (const vg of [2, 4]) {
    INSTRS.push({
      id: `${m}-${vg}`,
      mnemonic: m,
      group: G,
      feature,
      bits: `11000001 ${sizeBits} 1 Zm:5 1100 ${vg === 4 ? 1 : 0} ${int} Zn:5 ${vg === 2 ? 'Zd:4' : 'Zd:3 0'} ${U}`,
      syntax: `<LM:Zd:${vg}:${letter}>, <Zn.${letter}>, <Zm.${letter}>`,
      valid: m === 'fclamp' ? (f) => f.size !== 0 : undefined,
      desc: int
        ? T(`把 ${vg} 个 z 寄存器的每个元素限制在 [Zn, Zm] 之间（${U ? '无' : '有'}符号）`, `Clamp each element of ${vg} z registers to [Zn, Zm] (${U ? 'unsigned' : 'signed'})`)
        : T(`把 ${vg} 个 z 寄存器的每个元素限制在 [Zn, Zm] 之间：minNum(maxNum(Zn, Zd), Zm)`, `Clamp each element of ${vg} z registers to [Zn, Zm]: minNum(maxNum(Zn, Zd), Zm)`),
      exec(c, f) {
        const es = letter === 'h' ? 1 : f.size!
        const t = letter === 'h' ? sf.BF16 : FMT[es]!
        const lo = zget(c, f.Zn!, es)
        const hi = zget(c, f.Zm!, es)
        const env = c.fpEnv()
        for (const d of regsOf(f.Zd!, vg)) {
          zset(c, d, zget(c, d, es).map((x, i) => {
            if (!int) return sf.fpMaxMinNum(env, t, sf.fpMaxMinNum(env, t, lo[i]!, x, true), hi[i]!, false)
            const v = (y: bigint) => (U ? y : sx(y, es))
            const mx = v(x) > v(lo[i]!) ? x : lo[i]!
            return v(mx) < v(hi[i]!) ? mx : hi[i]!
          }), es)
        }
        if (!int) c.fpFlags(env)
      },
      needs: STREAMING,
    })
  }
}

/* ------------------------------------------------------------------ ZIP, UZP */

/** Interleave (zip) or de-interleave (uzp) `srcs` vectors of element size es into as many vectors. */
function permute(c: Cpu, srcs: number[], dsts: number[], es: number, unzip: boolean): void {
  const n = srcs.length
  const all = srcs.map((r) => zget(c, r, es))
  const E = all[0]!.length
  const flat = unzip ? all.flat() : Array.from({ length: n * E }, (_, x) => all[x % n]![Math.floor(x / n)]!)
  const out = unzip ? dsts.map((_, k) => Array.from({ length: E }, (_, i) => flat[i * n + k]!)) : dsts.map((_, k) => flat.slice(k * E, k * E + E))
  out.forEach((v, k) => zset(c, dsts[k]!, v, es))
}

for (const [U, m] of [
  [0, 'zip'],
  [1, 'uzp'],
] as const) {
  const what = U ? T('解交错：把源拼起来，第 k 个结果取下标模 n 为 k 的元素', 'De-interleave: the sources joined, result k taking the elements whose index modulo n is k') : T('交错：依次从每个源取一个元素', 'Interleave: one element from each source in turn')
  for (const q of [0, 1]) {
    const sizeBits = q ? '00' : 'size:2'
    const letter = q ? 'q' : 'size'
    const esOf = (f: Fields) => (q ? 4 : f.size!)
    INSTRS.push(
      {
        id: `${m}-2${q ? 'q' : ''}`,
        mnemonic: m,
        group: G,
        feature: 'sme2',
        bits: `11000001 ${sizeBits} 1 Zm:5 1101 0 ${q} Zn:5 Zd:4 ${U}`,
        syntax: `<LM:Zd:2:${letter}>, <Zn.${letter}>, <Zm.${letter}>`,
        desc: T(`${what.zh}（两个源 Zn、Zm）`, `${what.en} (two sources, Zn and Zm)`),
        exec: (c, f) => permute(c, [f.Zn!, f.Zm!], regsOf(f.Zd!, 2), esOf(f), U === 1),
        needs: STREAMING,
      },
      {
        id: `${m}-4${q ? 'q' : ''}`,
        mnemonic: m,
        group: G,
        feature: 'sme2',
        bits: `11000001 ${sizeBits} 1 1011 ${q} 111000 Zn:3 00 Zd:3 ${U} 0`,
        syntax: `<LM:Zd:4:${letter}>, <LM:Zn:4:${letter}>`,
        desc: T(`${what.zh}（四个源）`, `${what.en} (four sources)`),
        exec: (c, f) => permute(c, regsOf(f.Zn!, 4), regsOf(f.Zd!, 4), esOf(f), U === 1),
        needs: STREAMING,
      },
    )
  }
}

/* ------------------------------------------------------------------ conversions and rounding */

/**
 * Narrow `srcs` vectors of element size from into one of size to: concatenated (the first source fills the
 * low part) or, with `interleave`, element i of source k going to element i × n + k.
 */
function narrow(c: Cpu, srcs: number[], d: number, from: number, to: number, interleave: boolean, fn: (v: bigint) => bigint): void {
  const n = srcs.length
  const all = srcs.map((r) => zget(c, r, from))
  const E = all[0]!.length
  const out = Array.from({ length: E * n }, (_, x) => (interleave ? fn(all[x % n]![Math.floor(x / n)]!) : fn(all[Math.floor(x / E)]![x % E]!)))
  zset(c, d, out, to)
}

for (const [m, S, N, bf16] of [
  ['fcvt', 0, 0, false],
  ['fcvtn', 0, 1, false],
  ['bfcvt', 1, 0, true],
  ['bfcvtn', 1, 1, true],
] as const)
  INSTRS.push({
    id: `${m}-2`,
    mnemonic: m,
    group: G,
    feature: 'sme2',
    bits: `11000001 0 ${S} 1 00000 111000 Zn:4 ${N} Zd:5`,
    syntax: '<Zd.h>, <LM:Zn:2:s>',
    desc: T(`把两个寄存器的单精度数转成${bf16 ? ' BF16' : '半精度'}，${N ? '交错放进' : '依次放进'} Zd${N ? '（Zn1 的在偶数位置）' : '（Zn1 的在低半）'}`, `Convert the single-precision values of two registers to ${bf16 ? 'BFloat16' : 'half precision'}, ${N ? 'interleaved in Zd (Zn1 in the even elements)' : 'one after the other in Zd (Zn1 in the low half)'}`),
    exec(c, f) {
      // Half precision here is always IEEE: FPCR.AHP does not apply (the M5 agrees).
      const env = c.fpEnv().with(0, sf.AHP)
      narrow(c, regsOf(f.Zn!, 2), f.Zd!, 2, 1, N === 1, (v) => (bf16 ? sf.fpConvertBF(env, v) : sf.fpConvert(env, sf.F32, sf.F16, v)))
      c.fpFlags(env)
    },
    needs: STREAMING,
  })
for (const [m, L] of [
  ['fcvt', 0],
  ['fcvtl', 1],
] as const)
  INSTRS.push({
    id: `${m}-w2`,
    mnemonic: m,
    group: G,
    feature: 'sme-f16f16',
    bits: `11000001 10 1 00000 111000 Zn:5 Zd:4 ${L}`,
    syntax: '<LM:Zd:2:s>, <Zn.h>',
    desc: L
      ? T('把 Zn 的半精度数转成单精度：偶数号元素进第一个寄存器，奇数号进第二个', 'Convert the half-precision values of Zn to single precision: even elements to the first register, odd to the second')
      : T('把 Zn 的半精度数转成单精度：低半进第一个寄存器，高半进第二个', 'Convert the half-precision values of Zn to single precision: the low half to the first register, the high half to the second'),
    exec(c, f) {
      // As for the narrowing forms, FPCR.AHP does not apply.
      const env = c.fpEnv().with(0, sf.AHP)
      const N = zget(c, f.Zn!, 1)
      const E = N.length / 2
      regsOf(f.Zd!, 2).forEach((d, k) => zset(c, d, Array.from({ length: E }, (_, i) => sf.fpConvert(env, sf.F16, sf.F32, N[L ? 2 * i + k : k * E + i]!)), 2))
      c.fpFlags(env)
    },
    needs: STREAMING,
  })

/** One unary operation on each of vg registers of single precision. */
function unary(m: string, opc: string, mid: string, desc: Text, fn: (env: sf.FpEnv, v: bigint) => bigint): void {
  for (const vg of [2, 4])
    INSTRS.push({
      id: `${m}-${vg}`,
      mnemonic: m,
      group: G,
      feature: 'sme2',
      bits: `11000001 ${opc.slice(0, 2)} 1 ${vg === 4 ? 1 : 0} ${opc.slice(2)} 111000 ${vg === 2 ? 'Zn:4' : 'Zn:3 0'} ${mid} ${vg === 2 ? 'Zd:4' : 'Zd:3 0'} 0`,
      syntax: `<LM:Zd:${vg}:s>, <LM:Zn:${vg}:s>`,
      desc: T(`${desc.zh}（${vg} 个寄存器）`, `${desc.en} (${vg} registers)`),
      exec(c, f) {
        const env = c.fpEnv()
        const ds = regsOf(f.Zd!, vg)
        regsOf(f.Zn!, vg).forEach((n, r) => zset(c, ds[r]!, zget(c, n, 2).map((v) => fn(env, v)), 2))
        c.fpFlags(env)
      },
      needs: STREAMING,
    })
}
unary('fcvtzs', '000001', '0', T('单精度转有符号 32 位整数（向零舍入）', 'Single precision to signed 32-bit integers (toward zero)'), (e, v) => sf.fpToFixed(e, sf.F32, v, 0, false, sf.RZ, 32))
unary('fcvtzu', '000001', '1', T('单精度转无符号 32 位整数（向零舍入）', 'Single precision to unsigned 32-bit integers (toward zero)'), (e, v) => sf.fpToFixed(e, sf.F32, v, 0, true, sf.RZ, 32))
unary('scvtf', '000010', '0', T('有符号 32 位整数转单精度', 'Signed 32-bit integers to single precision'), (e, v) => sf.fixedToFp(e, sf.F32, v, 0, false, 32))
unary('ucvtf', '000010', '1', T('无符号 32 位整数转单精度', 'Unsigned 32-bit integers to single precision'), (e, v) => sf.fixedToFp(e, sf.F32, v, 0, true, 32))
for (const [m, rr, mode, what] of [
  ['frintn', '000', sf.RN, T('就近，平局取偶', 'to nearest, ties to even')],
  ['frintp', '001', sf.RP, T('向正无穷', 'toward plus infinity')],
  ['frintm', '010', sf.RM, T('向负无穷', 'toward minus infinity')],
  ['frinta', '100', sf.RA, T('就近，平局远离零', 'to nearest, ties away from zero')],
] as const)
  unary(m, `101${rr}`, '0', T(`单精度舍入到整数（${what.zh}）`, `Round single precision to integers (${what.en})`), (e, v) => sf.fpRoundInt(e, sf.F32, v, mode, false))

/* ------------------------------------------------------------------ saturating narrowing */

/** Signed or unsigned source, saturated to a signed or unsigned result. */
const satTo = (v: bigint, from: number, to: number, srcU: boolean, dstU: boolean) => sat(srcU ? v : sx(v, from), to, dstU)[0]

for (const [m, S, U, srcU, dstU] of [
  ['sqcvt', 0, 0, false, false],
  ['uqcvt', 0, 1, true, true],
  ['sqcvtu', 1, 0, false, true],
] as const) {
  const kind = srcU ? T('无符号', 'unsigned') : T('有符号', 'signed')
  const res = dstU ? T('无符号', 'unsigned') : T('有符号', 'signed')
  INSTRS.push({
    id: `${m}-2`,
    mnemonic: m,
    group: G,
    feature: 'sme2',
    bits: `11000001 0 ${S} 1 0 0011 111000 Zn:4 ${U} Zd:5`,
    syntax: '<Zd.h>, <LM:Zn:2:s>',
    desc: T(`两个寄存器的 32 位${kind.zh}整数饱和成 16 位${res.zh}整数，依次放进 Zd`, `Saturate the ${kind.en} 32-bit integers of two registers to ${res.en} 16-bit integers, one after the other in Zd`),
    exec: (c, f) => narrow(c, regsOf(f.Zn!, 2), f.Zd!, 2, 1, false, (v) => satTo(v, 2, 1, srcU, dstU)),
    needs: STREAMING,
  })
  for (const N of [0, 1])
    for (const [D, from, to] of [
      [0, 2, 0],
      [1, 3, 1],
    ] as const)
      INSTRS.push({
        id: `${m}${N ? 'n' : ''}-4${LET[from]}`,
        mnemonic: `${m}${N ? 'n' : ''}`,
        group: G,
        feature: from === 3 ? 'sme-i16i64' : 'sme2',
        bits: `11000001 ${D} ${S} 1 1 0011 111000 Zn:3 ${N} ${U} Zd:5`,
        syntax: `<Zd.${LET[to]}>, <LM:Zn:4:${LET[from]}>`,
        desc: T(`四个寄存器的 ${ESIZE[from]} 位${kind.zh}整数饱和成 ${ESIZE[to]} 位${res.zh}整数，${N ? '交错' : '依次'}放进 Zd`, `Saturate the ${kind.en} ${ESIZE[from]}-bit integers of four registers to ${res.en} ${ESIZE[to]}-bit integers, ${N ? 'interleaved' : 'one after the other'} in Zd`),
        exec: (c, f) => narrow(c, regsOf(f.Zn!, 4), f.Zd!, from, to, N === 1, (v) => satTo(v, from, to, srcU, dstU)),
        needs: STREAMING,
      })
}

/* ------------------------------------------------------------------ narrowing shifts */

/** Rounding shift right by sh, then saturate. */
const rshrSat = (v: bigint, sh: number, from: number, to: number, srcU: boolean, dstU: boolean) => sat(((srcU ? v : sx(v, from)) + (1n << BigInt(sh - 1))) >> BigInt(sh), to, dstU)[0]

for (const [m, R, U, srcU, dstU] of [
  ['sqrshr', 0, 0, false, false],
  ['uqrshr', 0, 1, true, true],
  ['sqrshru', 1, 0, false, true],
] as const) {
  const kind = srcU ? T('无符号', 'unsigned') : T('有符号', 'signed')
  const res = dstU ? T('无符号', 'unsigned') : T('有符号', 'signed')
  INSTRS.push({
    id: `${m}-2`,
    mnemonic: m,
    group: G,
    feature: 'sme2',
    bits: `11000001 111 ${R} imm4:4 110101 Zn:4 ${U} Zd:5`,
    syntax: '<Zd.h>, <LM:Zn:2:s>, #<nshift:16:imm4>',
    desc: T(`两个寄存器的 32 位${kind.zh}整数舍入右移，饱和成 16 位${res.zh}整数，依次放进 Zd`, `Shift the ${kind.en} 32-bit integers of two registers right with rounding and saturate to ${res.en} 16-bit integers, one after the other in Zd`),
    exec: (c, f) => narrow(c, regsOf(f.Zn!, 2), f.Zd!, 2, 1, false, (v) => rshrSat(v, 16 - f.imm4!, 2, 1, srcU, dstU)),
    needs: STREAMING,
  })
  for (const N of [0, 1])
    for (const [from, to] of [
      [2, 0],
      [3, 1],
    ] as const) {
      const d = from === 3
      INSTRS.push({
        id: `${m}${N ? 'n' : ''}-4${LET[from]}`,
        mnemonic: `${m}${N ? 'n' : ''}`,
        group: G,
        feature: d ? 'sme-i16i64' : 'sme2',
        bits: `11000001 ${d ? '1 ih' : '0 1'} 1 imm5:5 11011 ${N} Zn:3 ${R} ${U} Zd:5`,
        syntax: `<Zd.${LET[to]}>, <LM:Zn:4:${LET[from]}>, #<nshift:${d ? '64:ih+imm5' : '32:imm5'}>`,
        desc: T(`四个寄存器的 ${ESIZE[from]} 位${kind.zh}整数舍入右移，饱和成 ${ESIZE[to]} 位${res.zh}整数，${N ? '交错' : '依次'}放进 Zd`, `Shift the ${kind.en} ${ESIZE[from]}-bit integers of four registers right with rounding and saturate to ${res.en} ${ESIZE[to]}-bit integers, ${N ? 'interleaved' : 'one after the other'} in Zd`),
        exec: (c, f) => narrow(c, regsOf(f.Zn!, 4), f.Zd!, from, to, N === 1, (v) => rshrSat(v, (d ? 64 - ((f.ih! << 5) | f.imm5!) : 32 - f.imm5!), from, to, srcU, dstU)),
        needs: STREAMING,
      })
    }
}

/* ------------------------------------------------------------------ unpacks */

for (const [m, U] of [
  ['sunpk', 0],
  ['uunpk', 1],
] as const) {
  const what = U ? T('零扩展', 'zero-extend') : T('符号扩展', 'sign-extend')
  const valid = (f: Fields) => f.size !== 0
  // Every source is read before any result is written: the destinations may include the sources.
  const widen = (c: Cpu, srcs: number[], dsts: number[], es: number) => {
    srcs.map((n) => zget(c, n, es - 1)).forEach((N, k) => {
      const E = N.length / 2
      for (const h of [0, 1]) zset(c, dsts[2 * k + h]!, N.slice(h * E, h * E + E).map((v) => (U ? v : ux(sx(v, es - 1), es))), es)
    })
  }
  INSTRS.push(
    {
      id: `${m}-2`,
      mnemonic: m,
      group: G,
      feature: 'sme2',
      bits: `11000001 size:2 1 00101 111000 Zn:5 Zd:4 ${U}`,
      syntax: '<LM:Zd:2:size>, <Zn.size-1>',
      valid,
      desc: T(`把 Zn 的元素${what.zh}到两倍宽：低半进第一个寄存器，高半进第二个`, `${what.en} the elements of Zn to twice the width: the low half to the first register, the high half to the second`),
      exec: (c, f) => widen(c, [f.Zn!], regsOf(f.Zd!, 2), f.size!),
      needs: STREAMING,
    },
    {
      id: `${m}-4`,
      mnemonic: m,
      group: G,
      feature: 'sme2',
      bits: `11000001 size:2 1 10101 111000 Zn:4 0 Zd:3 0 ${U}`,
      syntax: '<LM:Zd:4:size>, <LM:Zn:2:size-1>',
      valid,
      desc: T(`把两个寄存器的元素${what.zh}到两倍宽，放进四个寄存器`, `${what.en} the elements of two registers to twice the width, into four registers`),
      exec: (c, f) => widen(c, regsOf(f.Zn!, 2), regsOf(f.Zd!, 4), f.size!),
      needs: STREAMING,
    },
  )
}

/* ------------------------------------------------------------------ SEL */

for (const vg of [2, 4])
  INSTRS.push({
    id: `sel-${vg}`,
    mnemonic: 'sel',
    group: G,
    feature: 'sme2',
    bits: vg === 2 ? '11000001 size:2 1 Zm:4 0 100 PNg:3 Zn:4 0 Zd:4 0' : '11000001 size:2 1 Zm:3 01 100 PNg:3 Zn:3 00 Zd:3 00',
    syntax: `<LM:Zd:${vg}:size>, <PNg>, <LM:Zn:${vg}:size>, <LM:Zm:${vg}:size>`,
    desc: T(`按计数谓词（覆盖 ${vg} 个向量）逐个元素选择：活跃取 Zn，否则取 Zm`, `Select element by element by a predicate-as-counter covering ${vg} vectors: Zn where active, Zm elsewhere`),
    exec(c, f) {
      const es = f.size!
      const bytes = ESIZE[es]! / 8
      const E = elemsOf(c, es)
      const p = counterBits(c, c.pread(8 + f.PNg!), vg)
      const ds = regsOf(f.Zd!, vg)
      const ns = regsOf(f.Zn!, vg).map((r) => zget(c, r, es))
      const ms = regsOf(f.Zm!, vg).map((r) => zget(c, r, es))
      ds.forEach((d, r) => zset(c, d, ns[r]!.map((a, e) => (p[(r * E + e) * bytes] ? a : ms[r]![e]!)), es))
    },
    needs: STREAMING,
  })

/* ------------------------------------------------------------------ multi-vector loads and stores */

const BYTES = [T('字节', 'bytes'), T('半字', 'halfwords'), T('字', 'words'), T('双字', 'doublewords')]

for (let msz = 0; msz < 4; msz++) {
  const L = LET[msz]!
  const mb = 1 << msz
  const lsl = msz ? `, lsl #${msz}` : ''
  for (const store of [false, true]) {
    for (const nt of [false, true]) {
      const m = `${store ? 'st' : 'ld'}${nt ? 'nt' : ''}1${'bhwd'[msz]}`
      for (const strided of [false, true]) {
        for (const vg of [2, 4]) {
          const zt = strided ? (vg === 2 ? `T ${nt ? 1 : 0} Zt:3` : `T ${nt ? 1 : 0} 0 Zt:2`) : vg === 2 ? `Zt:4 ${nt ? 1 : 0}` : `Zt:3 0 ${nt ? 1 : 0}`
          const list = strided ? `<LS:T:Zt:${vg}:${L}>` : `<LM:Zt:${vg}:${L}>`
          const pred = store ? '<PNg>' : '<PNg/z>'
          const regs = (f: Fields) => (strided ? regsOf(f.T! * 16 + f.Zt!, vg, true) : regsOf(f.Zt!, vg))
          const run = (c: Cpu, f: Fields, base: bigint) => {
            const E = elemsOf(c, msz)
            const p = counterBits(c, c.pread(8 + f.PNg!), vg)
            const at = (x: number) => (base + BigInt(x * mb)) & M64
            regs(f).forEach((z, r) => {
              if (store) {
                const vals = zget(c, z, msz)
                vals.forEach((v, e) => {
                  if (p[(r * E + e) * mb]) c.store(at(r * E + e), mb, v)
                })
              } else
                zset(c, z, Array.from({ length: E }, (_, e) => (p[(r * E + e) * mb] ? c.load(at(r * E + e), mb) : 0n)), msz)
            })
          }
          const what = store
            ? T(`把 ${vg} 个${strided ? '间隔排列的' : '连续的'} z 寄存器里活跃的${BYTES[msz]!.zh}存到内存（按计数谓词）`, `Store the active ${BYTES[msz]!.en} of ${vg} ${strided ? 'strided' : 'consecutive'} z registers to memory (by a predicate-as-counter)`)
            : T(`从内存读${BYTES[msz]!.zh}到 ${vg} 个${strided ? '间隔排列的' : '连续的'} z 寄存器（按计数谓词，不活跃的元素清零）`, `Load ${BYTES[msz]!.en} from memory into ${vg} ${strided ? 'strided' : 'consecutive'} z registers (by a predicate-as-counter; inactive elements become zero)`)
          const ntText = nt ? T('；不需要长期缓存（non-temporal）', '; a non-temporal hint') : T('', '')
          const base = {
            mnemonic: m,
            group: G,
            feature: strided ? 'sme2' : 'sve2p1',
            // The strided forms exist in Streaming SVE mode only; the consecutive ones are SVE2.1 too.
            needs: strided ? STREAMING : undefined,
          }
          const top = `1010000 ${strided ? 1 : 0} 0`
          INSTRS.push(
            {
              ...base,
              id: `${m}-${strided ? 's' : 'c'}${vg}-imm`,
              bits: `${top} 1 ${store ? 1 : 0} 0 imm4:4 ${vg === 4 ? 1 : 0} ${msz.toString(2).padStart(2, '0')} PNg:3 Rn:5 ${zt}`,
              syntax: `${list}, ${pred}, [<Xn|SP>{, #<s:imm4*${vg}>, mul vl}]`,
              desc: T(`${what.zh}；地址是 Xn + imm × 向量字节数${ntText.zh}`, `${what.en}; the address is Xn + imm × the vector length in bytes${ntText.en}`),
              exec: (c, f) => run(c, f, (c.base(f.Rn!) + BigInt.asIntN(4, BigInt(f.imm4!)) * BigInt(vg * c.vl)) & M64),
            },
            {
              ...base,
              id: `${m}-${strided ? 's' : 'c'}${vg}-reg`,
              bits: `${top} 0 ${store ? 1 : 0} Rm:5 ${vg === 4 ? 1 : 0} ${msz.toString(2).padStart(2, '0')} PNg:3 Rn:5 ${zt}`,
              syntax: `${list}, ${pred}, [<Xn|SP>, <Xm>${lsl}]`,
              desc: T(`${what.zh}；地址是 Xn + Xm${msz ? ` × ${mb}` : ''}${ntText.zh}`, `${what.en}; the address is Xn + Xm${msz ? ` × ${mb}` : ''}${ntText.en}`),
              exec: (c, f) => run(c, f, (c.base(f.Rn!) + (c.x(f.Rm!) << BigInt(msz))) & M64),
            },
          )
        }
      }
    }
  }
}
