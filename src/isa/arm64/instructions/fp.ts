/**
 * Scalar floating point: arithmetic with one, two and three sources, comparisons, conditional compare and
 * select, moves (between registers, from an immediate, to and from general registers), conversions between
 * precisions (FCVT, BFCVT), to and from integers and fixed point, rounding to an integral value (FRINT*),
 * and the JavaScript conversion FJCVTZS. ftype picks the precision: 0 single (s), 1 double (d), 3 half
 * (h, FEAT_FP16). The arithmetic itself is ../softfloat.ts.
 */
import { T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import { fpImm8 } from '../encoding/simd'
import * as sf from '../softfloat'
import type { Cpu, Fields } from './types'

const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')

/** Bytes and format of each ftype (2 is unallocated). */
export const FT_BYTES = [4, 8, 0, 2]
export const fmtOfFt = (ft: number) => (ft === 0 ? sf.F32 : ft === 1 ? sf.F64 : sf.F16)
const okFt = (f: Fields) => f.ftype !== 2

type Env = sf.FpEnv
type Fmt = sf.Fmt

/** Run one scalar FP operation: read FPCR, compute, fold the flags into FPSR, write Vd (merging from `merge` with FPCR.NEP). */
function scalarOp(c: Cpu, f: Fields, merge: number | undefined, op: (env: Env, fmt: Fmt, bytes: number) => bigint): void {
  const bytes = FT_BYTES[f.ftype!]!
  const env = c.fpEnv()
  const r = op(env, fmtOfFt(f.ftype!), bytes)
  c.fpFlags(env)
  c.vset(f.Rd!, bytes, r, merge)
}

const INSTRS_: InstrSpec[] = []
const ALIASES_: AliasSpec[] = []

/* ------------------------------------------------------------------ two sources */

const TWO: [string, number, Text, (e: Env, t: Fmt, a: bigint, b: bigint) => bigint][] = [
  ['fmul', 0, T('浮点乘：Fd = Fn × Fm', 'Floating-point multiply: Fd = Fn × Fm'), (e, t, a, b) => sf.fpMul(e, t, a, b)],
  ['fdiv', 1, T('浮点除：Fd = Fn ÷ Fm', 'Floating-point divide: Fd = Fn ÷ Fm'), (e, t, a, b) => sf.fpDiv(e, t, a, b)],
  ['fadd', 2, T('浮点加：Fd = Fn + Fm', 'Floating-point add: Fd = Fn + Fm'), (e, t, a, b) => sf.fpAdd(e, t, a, b)],
  ['fsub', 3, T('浮点减：Fd = Fn − Fm', 'Floating-point subtract: Fd = Fn − Fm'), (e, t, a, b) => sf.fpSub(e, t, a, b)],
  ['fmax', 4, T('浮点最大值（有 NaN 时结果是 NaN）', 'Floating-point maximum (a NaN operand gives NaN)'), (e, t, a, b) => sf.fpMaxMin(e, t, a, b, true, true)],
  ['fmin', 5, T('浮点最小值（有 NaN 时结果是 NaN）', 'Floating-point minimum (a NaN operand gives NaN)'), (e, t, a, b) => sf.fpMaxMin(e, t, a, b, false, true)],
  ['fmaxnm', 6, T('浮点最大值，忽略单个安静 NaN（IEEE 754 maxNum）', 'Floating-point maximum number: a single quiet NaN is ignored (IEEE 754 maxNum)'), (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, true)],
  ['fminnm', 7, T('浮点最小值，忽略单个安静 NaN（IEEE 754 minNum）', 'Floating-point minimum number: a single quiet NaN is ignored (IEEE 754 minNum)'), (e, t, a, b) => sf.fpMaxMinNum(e, t, a, b, false)],
  ['fnmul', 8, T('浮点乘后取负：Fd = −(Fn × Fm)', 'Floating-point multiply-negate: Fd = −(Fn × Fm)'), (e, t, a, b) => sf.fpNeg(e, t, sf.fpMul(e, t, a, b))],
]
for (const [m, opcode, desc, op] of TWO)
  INSTRS_.push({
    id: `${m}-s`,
    mnemonic: m,
    group: 'fp',
    bits: `0 0 0 11110 ftype:2 1 Rm:5 ${bin(opcode, 4)} 10 Rn:5 Rd:5`,
    syntax: '<Ed:ftype>, <En:ftype>, <Em:ftype>',
    valid: okFt,
    desc,
    exec: (c, f) => scalarOp(c, f, f.Rn, (e, t, bytes) => op(e, t, c.vget(f.Rn!, bytes), c.vget(f.Rm!, bytes))),
  })

/* ------------------------------------------------------------------ three sources */

const THREE: [string, number, number, Text][] = [
  ['fmadd', 0, 0, T('浮点乘加（只舍入一次）：Fd = Fa + Fn × Fm', 'Fused multiply-add (rounded once): Fd = Fa + Fn × Fm')],
  ['fmsub', 0, 1, T('浮点乘减（只舍入一次）：Fd = Fa − Fn × Fm', 'Fused multiply-subtract (rounded once): Fd = Fa − Fn × Fm')],
  ['fnmadd', 1, 0, T('浮点负乘加：Fd = −Fa − Fn × Fm', 'Fused negated multiply-add: Fd = −Fa − Fn × Fm')],
  ['fnmsub', 1, 1, T('浮点负乘减：Fd = −Fa + Fn × Fm', 'Fused negated multiply-subtract: Fd = −Fa + Fn × Fm')],
]
for (const [m, o1, o0, desc] of THREE)
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'fp',
    bits: `0 0 0 11111 ftype:2 ${o1} Rm:5 ${o0} Ra:5 Rn:5 Rd:5`,
    syntax: '<Ed:ftype>, <En:ftype>, <Em:ftype>, <Ea:ftype>',
    valid: okFt,
    desc,
    exec: (c, f) =>
      scalarOp(c, f, f.Ra, (e, t, bytes) => {
        let a = c.vget(f.Ra!, bytes)
        let n = c.vget(f.Rn!, bytes)
        const m2 = c.vget(f.Rm!, bytes)
        if (o1) a = sf.fpNeg(e, t, a)
        if (o0 !== o1) n = sf.fpNeg(e, t, n)
        return sf.fpMulAdd(e, t, a, n, m2)
      }),
  })

/* ------------------------------------------------------------------ one source */

const ROUND_NAMES: [string, number, number | null, boolean, Text][] = [
  ['frintn', 0b001000, sf.RN, false, T('舍入到整数值，就近取偶', 'Round to an integral value, to nearest with ties to even')],
  ['frintp', 0b001001, sf.RP, false, T('舍入到整数值，向正无穷（向上取整）', 'Round to an integral value, toward +infinity (ceiling)')],
  ['frintm', 0b001010, sf.RM, false, T('舍入到整数值，向负无穷（向下取整）', 'Round to an integral value, toward −infinity (floor)')],
  ['frintz', 0b001011, sf.RZ, false, T('舍入到整数值，向零（截断）', 'Round to an integral value, toward zero (truncate)')],
  ['frinta', 0b001100, sf.RA, false, T('舍入到整数值，就近，正好一半时远离零', 'Round to an integral value, to nearest with ties away from zero')],
  ['frintx', 0b001110, null, true, T('按 FPCR 的舍入方式舍入到整数值，不精确时报 IXC', 'Round to an integral value in the FPCR mode, signalling inexact')],
  ['frinti', 0b001111, null, false, T('按 FPCR 的舍入方式舍入到整数值', 'Round to an integral value in the FPCR mode')],
]

const ONE: [string, number, Text, (e: Env, t: Fmt, a: bigint) => bigint, boolean][] = [
  ['fabs', 1, T('浮点绝对值', 'Floating-point absolute value'), (e, t, a) => sf.fpAbs(e, t, a), false],
  ['fneg', 2, T('浮点取负', 'Floating-point negate'), (e, t, a) => sf.fpNeg(e, t, a), false],
  ['fsqrt', 3, T('浮点平方根', 'Floating-point square root'), (e, t, a) => sf.fpSqrt(e, t, a), true],
  ...ROUND_NAMES.map(([m, op, mode, exact, desc]): [string, number, Text, (e: Env, t: Fmt, a: bigint) => bigint, boolean] => [m, op, desc, (e, t, a) => sf.fpRoundInt(e, t, a, mode ?? e.rmode, exact), true]),
]
for (const [m, opcode, desc, op] of ONE)
  INSTRS_.push({
    id: `${m}-s`,
    mnemonic: m,
    group: 'fp',
    bits: `0 0 0 11110 ftype:2 1 ${bin(opcode, 6)} 10000 Rn:5 Rd:5`,
    syntax: '<Ed:ftype>, <En:ftype>',
    valid: okFt,
    desc,
    // With FPCR.NEP, one-source operations keep the rest of the destination (checked on the CPU).
    exec: (c, f) => scalarOp(c, f, f.Rd, (e, t, bytes) => op(e, t, c.vget(f.Rn!, bytes))),
  })

INSTRS_.push({
  id: 'fmov-s-reg',
  mnemonic: 'fmov',
  group: 'fp',
  bits: '0 0 0 11110 ftype:2 1 000000 10000 Rn:5 Rd:5',
  syntax: '<Ed:ftype>, <En:ftype>',
  valid: okFt,
  desc: T('复制浮点寄存器', 'Copy a floating-point register'),
  exec: (c, f) => {
    const bytes = FT_BYTES[f.ftype!]!
    c.vset(f.Rd!, bytes, c.vget(f.Rn!, bytes))
  },
})

for (const [m, opcode, size] of [
  ['frint32z', 0b010000, 32],
  ['frint32x', 0b010001, 32],
  ['frint64z', 0b010010, 64],
  ['frint64x', 0b010011, 64],
] as const) {
  const z = m.endsWith('z')
  INSTRS_.push({
    id: `${m}-s`,
    mnemonic: m,
    group: 'fp',
    feature: 'frintts',
    bits: `0 0 0 11110 0 ftype:1 1 ${bin(opcode, 6)} 10000 Rn:5 Rd:5`,
    syntax: '<Ed:ftype>, <En:ftype>',
    desc: T(`舍入到 ${size} 位整数能表示的整数值（${z ? '向零' : '按 FPCR 的方式'}），超出范围时结果是 −2^${size - 1}`, `Round to an integral value that fits a ${size}-bit integer (${z ? 'toward zero' : 'in the FPCR mode'}); out of range gives −2^${size - 1}`),
    exec: (c, f) => scalarOp(c, f, f.Rd, (e, t, bytes) => sf.fpRoundIntN(e, t, c.vget(f.Rn!, bytes), z ? sf.RZ : e.rmode, size)),
  })
}

INSTRS_.push({
  id: 'fcvt-s',
  mnemonic: 'fcvt',
  group: 'fp',
  bits: '0 0 0 11110 ftype:2 1 0001 opc:2 10000 Rn:5 Rd:5',
  syntax: '<Ed:fopc>, <En:ftype>',
  valid: (f) => okFt(f) && f.opc !== 2 && f.opc !== f.ftype,
  desc: T('换精度：在半精度、单精度和双精度之间转换', 'Convert between half, single and double precision'),
  exec: (c, f) => {
    const env = c.fpEnv()
    const r = sf.fpConvert(env, fmtOfFt(f.ftype!), fmtOfFt(f.opc!), c.vget(f.Rn!, FT_BYTES[f.ftype!]!))
    c.fpFlags(env)
    c.vset(f.Rd!, FT_BYTES[f.opc!]!, r, f.Rd)
  },
})

INSTRS_.push({
  id: 'bfcvt-s',
  mnemonic: 'bfcvt',
  group: 'fp',
  feature: 'bf16',
  bits: '0 0 0 11110 01 1 000110 10000 Rn:5 Rd:5',
  syntax: '<Hd>, <Sn>',
  desc: T('单精度转成 BFloat16（8 位指数、7 位尾数）', 'Convert single precision to BFloat16 (8-bit exponent, 7-bit fraction)'),
  exec: (c, f) => {
    const env = c.fpEnv()
    const r = sf.fpConvertBF(env, c.vget(f.Rn!, 4))
    c.fpFlags(env)
    c.vset(f.Rd!, 2, r, f.Rd)
  },
})

/* ------------------------------------------------------------------ compare and select */

for (const [m, E] of [
  ['fcmp', 0],
  ['fcmpe', 1],
] as const) {
  const desc = (zero: boolean) =>
    T(
      `浮点比较${zero ? ' 0.0' : ''}，结果写进 NZCV${E ? '；有任何 NaN 都报无效运算' : '；只有发信号的 NaN 报无效运算'}`,
      `Floating-point compare${zero ? ' with 0.0' : ''}, setting NZCV${E ? '; any NaN signals invalid operation' : '; only signalling NaNs signal invalid operation'}`,
    )
  INSTRS_.push({
    id: `${m}-reg`,
    mnemonic: m,
    group: 'fp',
    bits: `0 0 0 11110 ftype:2 1 Rm:5 001000 Rn:5 ${E}0000`,
    syntax: '<En:ftype>, <Em:ftype>',
    valid: okFt,
    desc: desc(false),
    exec: (c, f) => {
      const bytes = FT_BYTES[f.ftype!]!
      const env = c.fpEnv()
      const nzcv = sf.fpCompare(env, fmtOfFt(f.ftype!), c.vget(f.Rn!, bytes), c.vget(f.Rm!, bytes), !!E)
      c.fpFlags(env)
      c.setFlags(nzcv)
    },
  })
  INSTRS_.push({
    id: `${m}-zero`,
    mnemonic: m,
    group: 'fp',
    bits: `0 0 0 11110 ftype:2 1 00000 001000 Rn:5 ${E}1000`,
    syntax: '<En:ftype>, #<fzero>',
    valid: okFt,
    desc: desc(true),
    exec: (c, f) => {
      const bytes = FT_BYTES[f.ftype!]!
      const env = c.fpEnv()
      const nzcv = sf.fpCompare(env, fmtOfFt(f.ftype!), c.vget(f.Rn!, bytes), 0n, !!E)
      c.fpFlags(env)
      c.setFlags(nzcv)
    },
  })
}

for (const [m, op] of [
  ['fccmp', 0],
  ['fccmpe', 1],
] as const)
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'fp',
    bits: `0 0 0 11110 ftype:2 1 Rm:5 cond:4 01 Rn:5 ${op} nzcv:4`,
    syntax: '<En:ftype>, <Em:ftype>, #<u:nzcv>, <cond>',
    valid: okFt,
    desc: T(`条件成立时做浮点比较${op ? '（任何 NaN 都报无效运算）' : ''}，否则 NZCV 取立即数`, `If the condition holds, floating-point compare${op ? ' (any NaN signals invalid operation)' : ''}; otherwise NZCV takes the immediate`),
    exec: (c, f) => {
      if (!c.cond(f.cond!)) return c.setFlags(f.nzcv!)
      const bytes = FT_BYTES[f.ftype!]!
      const env = c.fpEnv()
      const nzcv = sf.fpCompare(env, fmtOfFt(f.ftype!), c.vget(f.Rn!, bytes), c.vget(f.Rm!, bytes), !!op)
      c.fpFlags(env)
      c.setFlags(nzcv)
    },
  })

INSTRS_.push({
  id: 'fcsel',
  mnemonic: 'fcsel',
  group: 'fp',
  bits: '0 0 0 11110 ftype:2 1 Rm:5 cond:4 11 Rn:5 Rd:5',
  syntax: '<Ed:ftype>, <En:ftype>, <Em:ftype>, <cond>',
  valid: okFt,
  desc: T('条件选择：条件成立取 Fn，否则取 Fm', 'Conditional select: Fn if the condition holds, else Fm'),
  exec: (c, f) => {
    const bytes = FT_BYTES[f.ftype!]!
    c.vset(f.Rd!, bytes, c.cond(f.cond!) ? c.vget(f.Rn!, bytes) : c.vget(f.Rm!, bytes))
  },
})

/* ------------------------------------------------------------------ immediates and moves */

INSTRS_.push({
  id: 'fmov-s-imm',
  mnemonic: 'fmov',
  group: 'fp',
  bits: '0 0 0 11110 ftype:2 1 imm8:8 100 00000 Rd:5',
  syntax: '<Ed:ftype>, #<fimm8>',
  valid: okFt,
  desc: T('浮点立即数：±(1 + n/16) × 2^e，n 为 0–15，e 为 −3–4（如 1.5、0.25、10.0）', 'Floating-point immediate: ±(1 + n/16) × 2^e with n 0–15 and e −3–4 (such as 1.5, 0.25, 10.0)'),
  exec: (c, f) => c.vset(f.Rd!, FT_BYTES[f.ftype!]!, sf.fromNumber(fmtOfFt(f.ftype!), fpImm8(f.imm8!))),
})

/** FMOV between general and SIMD&FP registers: [sf, ftype, rmode, to general?, syntax]. */
const MOVES: [number, number, number, boolean, string][] = [
  [0, 0, 0, true, '<Wd>, <Sn>'],
  [0, 0, 0, false, '<Sd>, <Wn>'],
  [1, 1, 0, true, '<Xd>, <Dn>'],
  [1, 1, 0, false, '<Dd>, <Xn>'],
  [0, 3, 0, true, '<Wd>, <Hn>'],
  [1, 3, 0, true, '<Xd>, <Hn>'],
  [0, 3, 0, false, '<Hd>, <Wn>'],
  [1, 3, 0, false, '<Hd>, <Xn>'],
  [1, 2, 1, true, '<Xd>, <VD1:n>'],
  [1, 2, 1, false, '<VD1:d>, <Xn>'],
]
for (const [sfb, ftype, rmode, toGen, syntax] of MOVES) {
  const bytes = ftype === 2 ? 8 : FT_BYTES[ftype]!
  const upper = ftype === 2
  INSTRS_.push({
    id: `fmov-${toGen ? 'to' : 'from'}-${sfb}${ftype}`,
    mnemonic: 'fmov',
    group: 'fp',
    bits: `${sfb} 0 0 11110 ${bin(ftype, 2)} 1 ${bin(rmode, 2)} ${toGen ? '110' : '111'} 000000 Rn:5 Rd:5`,
    syntax,
    desc: toGen
      ? T(`把浮点或向量寄存器的${upper ? '高 64 位' : '位'}原样复制到通用寄存器`, `Copy the ${upper ? 'upper 64 ' : ''}bits of a SIMD&FP register to a general register unchanged`)
      : T(`把通用寄存器的位原样复制到浮点或向量寄存器${upper ? '的高 64 位（低 64 位不变）' : ''}`, `Copy the bits of a general register to a SIMD&FP register${upper ? "'s upper 64 bits (the lower 64 are kept)" : ' unchanged'}`),
    exec: (c, f) => {
      if (toGen) {
        const v = upper ? c.vread(f.Rn!, 16) : null
        c.setR(sfb, f.Rd!, v ? new DataView(v.buffer).getBigUint64(8, true) : c.vget(f.Rn!, bytes))
      } else if (upper) {
        const v = c.vread(f.Rd!, 16)
        new DataView(v.buffer).setBigUint64(8, c.x(f.Rn!), true)
        c.vwrite(f.Rd!, v)
      } else c.vset(f.Rd!, bytes, c.r(sfb, f.Rn!) & ((1n << BigInt(8 * bytes)) - 1n))
    },
  })
}

/* `fmov s0, #0.0` is written as a move from the zero register. */
for (const [id, syntax] of [
  ['fmov-from-00', '<Sd>, #<fzero>'],
  ['fmov-from-11', '<Dd>, #<fzero>'],
  ['fmov-from-03', '<Hd>, #<fzero>'],
] as const)
  ALIASES_.push({ id: `${id}-zero`, of: id, mnemonic: 'fmov', syntax, fixed: { Rn: 31 }, prefer: false, desc: T('把浮点寄存器清零（用零寄存器写）', 'Set a floating-point register to zero (moved from the zero register)') })

/* ------------------------------------------------------------------ conversions with integers */

const ROUNDINGS: [string, number, number | null, string][] = [
  ['n', 0, sf.RN, '就近取偶'],
  ['p', 1, sf.RP, '向正无穷'],
  ['m', 2, sf.RM, '向负无穷'],
  ['z', 3, sf.RZ, '向零'],
]
const ROUND_EN: Record<string, string> = { n: 'to nearest, ties to even', p: 'toward +infinity', m: 'toward −infinity', z: 'toward zero', a: 'to nearest, ties away from zero' }

function toInt(m: string, rmode: number, opcode: number, rounding: number, unsigned: boolean, zh: string, letter: string): InstrSpec {
  return {
    id: `${m}-s`,
    mnemonic: m,
    group: 'fp',
    bits: `sf 0 0 11110 ftype:2 1 ${bin(rmode, 2)} ${bin(opcode, 3)} 000000 Rn:5 Rd:5`,
    syntax: '<Rd>, <En:ftype>',
    valid: okFt,
    desc: T(`浮点转${unsigned ? '无' : '有'}符号整数，${zh}舍入，超出范围时饱和`, `Convert floating point to a${unsigned ? 'n unsigned' : ' signed'} integer, rounding ${ROUND_EN[letter]}, saturating`),
    exec: (c, f) => {
      const env = c.fpEnv()
      const r = sf.fpToFixed(env, fmtOfFt(f.ftype!), c.vget(f.Rn!, FT_BYTES[f.ftype!]!), 0, unsigned, rounding, f.sf ? 64 : 32)
      c.fpFlags(env)
      c.setR(f.sf!, f.Rd!, r)
    },
  }
}
for (const [letter, rmode, rounding, zh] of ROUNDINGS) {
  INSTRS_.push(toInt(`fcvt${letter}s`, rmode, 0, rounding!, false, zh, letter))
  INSTRS_.push(toInt(`fcvt${letter}u`, rmode, 1, rounding!, true, zh, letter))
}
INSTRS_.push(toInt('fcvtas', 0, 4, sf.RA, false, '就近（一半时远离零）', 'a'))
INSTRS_.push(toInt('fcvtau', 0, 5, sf.RA, true, '就近（一半时远离零）', 'a'))

for (const [m, opcode, unsigned] of [
  ['scvtf', 2, false],
  ['ucvtf', 3, true],
] as const)
  INSTRS_.push({
    id: `${m}-s`,
    mnemonic: m,
    group: 'fp',
    bits: `sf 0 0 11110 ftype:2 1 00 ${bin(opcode, 3)} 000000 Rn:5 Rd:5`,
    syntax: '<Ed:ftype>, <Rn>',
    valid: okFt,
    desc: T(`${unsigned ? '无' : '有'}符号整数转浮点（按 FPCR 的方式舍入）`, `Convert a${unsigned ? 'n unsigned' : ' signed'} integer to floating point (rounded in the FPCR mode)`),
    exec: (c, f) => {
      const env = c.fpEnv()
      const r = sf.fixedToFp(env, fmtOfFt(f.ftype!), c.r(f.sf!, f.Rn!), 0, unsigned, f.sf ? 64 : 32)
      c.fpFlags(env)
      c.vset(f.Rd!, FT_BYTES[f.ftype!]!, r, f.Rd)
    },
  })

INSTRS_.push({
  id: 'fjcvtzs',
  mnemonic: 'fjcvtzs',
  group: 'fp',
  feature: 'jscvt',
  bits: '0 0 0 11110 01 1 11 110 000000 Rn:5 Rd:5',
  syntax: '<Wd>, <Dn>',
  desc: T('按 JavaScript 的 ToInt32 把双精度转成 32 位整数（向零舍入后取模 2^32）；精确时 Z = 1', "Convert double precision to a 32-bit integer as JavaScript's ToInt32 does (truncate, then modulo 2^32); Z = 1 when exact"),
  exec: (c, f) => {
    const env = c.fpEnv()
    const { value, z } = sf.fpToFixedJS(env, c.vget(f.Rn!, 8))
    c.fpFlags(env)
    c.setR(0, f.Rd!, value)
    c.setFlags(z ? 0b0100 : 0)
  },
})

/* ------------------------------------------------------------------ fixed point */

for (const [m, rmode, opcode, unsigned] of [
  ['fcvtzs', 3, 0, false],
  ['fcvtzu', 3, 1, true],
] as const)
  INSTRS_.push({
    id: `${m}-fix`,
    mnemonic: m,
    group: 'fp',
    bits: `sf 0 0 11110 ftype:2 0 ${bin(rmode, 2)} ${bin(opcode, 3)} scale:6 Rn:5 Rd:5`,
    syntax: '<Rd>, <En:ftype>, #<fbits>',
    valid: (f) => okFt(f) && (f.sf === 1 || f.scale! >= 32),
    desc: T(`浮点转${unsigned ? '无' : '有'}符号定点数（向零舍入）：结果 = 值 × 2^小数位数`, `Convert floating point to ${unsigned ? 'unsigned' : 'signed'} fixed point (toward zero): result = value × 2^fbits`),
    exec: (c, f) => {
      const env = c.fpEnv()
      const r = sf.fpToFixed(env, fmtOfFt(f.ftype!), c.vget(f.Rn!, FT_BYTES[f.ftype!]!), 64 - f.scale!, unsigned, sf.RZ, f.sf ? 64 : 32)
      c.fpFlags(env)
      c.setR(f.sf!, f.Rd!, r)
    },
  })

for (const [m, opcode, unsigned] of [
  ['scvtf', 2, false],
  ['ucvtf', 3, true],
] as const)
  INSTRS_.push({
    id: `${m}-fix`,
    mnemonic: m,
    group: 'fp',
    bits: `sf 0 0 11110 ftype:2 0 00 ${bin(opcode, 3)} scale:6 Rn:5 Rd:5`,
    syntax: '<Ed:ftype>, <Rn>, #<fbits>',
    valid: (f) => okFt(f) && (f.sf === 1 || f.scale! >= 32),
    desc: T(`${unsigned ? '无' : '有'}符号定点数转浮点：结果 = 整数 ÷ 2^小数位数`, `Convert ${unsigned ? 'unsigned' : 'signed'} fixed point to floating point: result = integer ÷ 2^fbits`),
    exec: (c, f) => {
      const env = c.fpEnv()
      const r = sf.fixedToFp(env, fmtOfFt(f.ftype!), c.r(f.sf!, f.Rn!), 64 - f.scale!, unsigned, f.sf ? 64 : 32)
      c.fpFlags(env)
      c.vset(f.Rd!, FT_BYTES[f.ftype!]!, r, f.Rd)
    },
  })

export const INSTRS = INSTRS_
export const ALIASES = ALIASES_
