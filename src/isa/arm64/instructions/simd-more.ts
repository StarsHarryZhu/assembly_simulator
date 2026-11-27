/**
 * Advanced SIMD integer instructions, part two: shifts by an immediate, element copies (DUP, INS, UMOV,
 * SMOV and their MOV aliases), modified immediates (MOVI, MVNI, ORR, BIC, FMOV vector), permutes (UZP,
 * TRN, ZIP), EXT, table lookups (TBL, TBX), multiplies by element, rounding doubling multiply-accumulate
 * (FEAT_RDM), dot products (FEAT_DotProd, FEAT_I8MM) and the 8-bit matrix multiplies.
 *
 * The shifts and copies are one encoding per element size: the size is the position of the top set bit
 * of immh, or the bottom set bit of imm5, so fixing it leaves the shift amount or the element index as a
 * plain field (`sh`, `idx`, `idx2`).
 */
import { T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { ESIZE, elems, half, int, maskEs, readV, sat, sx, ux, writeNarrow, writeV } from './vec'
import { type Sat } from './simd-int'

const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')
const LETTER = 'bhsd'
const INSTRS_: InstrSpec[] = []
const ALIASES_: AliasSpec[] = []

const satTo = (v: bigint, es: number, unsigned: boolean, st: Sat) => {
  const [r, s] = sat(v, es, unsigned)
  if (s) st.qc = true
  return r
}
const lanes = (bytes: number, es: number) => bytes / (ESIZE[es]! / 8)

/* ------------------------------------------------------------------ shifts by immediate */

/** immh:immb with the element size fixed: the rest is the field `sh`. */
const SH_BITS = ['0001 sh:3', '001 sh:4', '01 sh:5', '1 sh:6']

type ShLane = (a: bigint, d: bigint, es: number, sh: number, st: Sat) => bigint
const rnd = (round: boolean, sh: number) => (round && sh > 0 ? 1n << BigInt(sh - 1) : 0n)

const shr = (unsigned: boolean, round: boolean, acc: boolean): ShLane => (a, d, es, sh) => ux((acc ? d : 0n) + ((int(a, es, unsigned) + rnd(round, sh)) >> BigInt(sh)), es)
const sri: ShLane = (a, d, es, sh) => {
  const mask = maskEs(es) >> BigInt(sh)
  return (d & ~mask & maskEs(es)) | (a >> BigInt(sh))
}
const sli: ShLane = (a, d, es, sh) => {
  const mask = (maskEs(es) << BigInt(sh)) & maskEs(es)
  return (d & ~mask) | ((a << BigInt(sh)) & mask)
}
const qshl = (srcUnsigned: boolean, dstUnsigned: boolean): ShLane => (a, _d, es, sh, st) => satTo(int(a, es, srcUnsigned) << BigInt(sh), es, dstUnsigned, st)

interface ShOp {
  U: number
  opc: number
  m: string
  kind: 'right' | 'left'
  /** Element sizes of the vector and scalar forms. */
  v: string
  s: string
  desc: Text
  lane: ShLane
  acc?: boolean
}
const SHIFTS: ShOp[] = [
  { U: 0, opc: 0b00000, m: 'sshr', kind: 'right', v: 'bhsd', s: 'd', desc: T('有符号（算术）右移', 'Signed (arithmetic) shift right'), lane: shr(false, false, false) },
  { U: 0, opc: 0b00010, m: 'ssra', kind: 'right', v: 'bhsd', s: 'd', desc: T('有符号右移后累加到 Vd', 'Signed shift right and accumulate into Vd'), lane: shr(false, false, true), acc: true },
  { U: 0, opc: 0b00100, m: 'srshr', kind: 'right', v: 'bhsd', s: 'd', desc: T('有符号舍入右移', 'Signed rounding shift right'), lane: shr(false, true, false) },
  { U: 0, opc: 0b00110, m: 'srsra', kind: 'right', v: 'bhsd', s: 'd', desc: T('有符号舍入右移后累加', 'Signed rounding shift right and accumulate'), lane: shr(false, true, true), acc: true },
  { U: 0, opc: 0b01010, m: 'shl', kind: 'left', v: 'bhsd', s: 'd', desc: T('左移', 'Shift left'), lane: (a, _d, es, sh) => ux(a << BigInt(sh), es) },
  { U: 0, opc: 0b01110, m: 'sqshl', kind: 'left', v: 'bhsd', s: 'bhsd', desc: T('有符号饱和左移', 'Signed saturating shift left'), lane: qshl(false, false) },
  { U: 1, opc: 0b00000, m: 'ushr', kind: 'right', v: 'bhsd', s: 'd', desc: T('无符号（逻辑）右移', 'Unsigned (logical) shift right'), lane: shr(true, false, false) },
  { U: 1, opc: 0b00010, m: 'usra', kind: 'right', v: 'bhsd', s: 'd', desc: T('无符号右移后累加到 Vd', 'Unsigned shift right and accumulate into Vd'), lane: shr(true, false, true), acc: true },
  { U: 1, opc: 0b00100, m: 'urshr', kind: 'right', v: 'bhsd', s: 'd', desc: T('无符号舍入右移', 'Unsigned rounding shift right'), lane: shr(true, true, false) },
  { U: 1, opc: 0b00110, m: 'ursra', kind: 'right', v: 'bhsd', s: 'd', desc: T('无符号舍入右移后累加', 'Unsigned rounding shift right and accumulate'), lane: shr(true, true, true), acc: true },
  { U: 1, opc: 0b01000, m: 'sri', kind: 'right', v: 'bhsd', s: 'd', desc: T('右移后插入：移入的高位保持 Vd 原来的值', 'Shift right and insert: the vacated top bits keep Vd'), lane: sri, acc: true },
  { U: 1, opc: 0b01010, m: 'sli', kind: 'left', v: 'bhsd', s: 'd', desc: T('左移后插入：移出的低位保持 Vd 原来的值', 'Shift left and insert: the vacated low bits keep Vd'), lane: sli, acc: true },
  { U: 1, opc: 0b01100, m: 'sqshlu', kind: 'left', v: 'bhsd', s: 'bhsd', desc: T('有符号值饱和左移成无符号', 'Signed saturating shift left, unsigned result'), lane: qshl(false, true) },
  { U: 1, opc: 0b01110, m: 'uqshl', kind: 'left', v: 'bhsd', s: 'bhsd', desc: T('无符号饱和左移', 'Unsigned saturating shift left'), lane: qshl(true, true) },
]

const shiftOf = (op: { kind: string }, es: number, f: Fields) => (op.kind === 'left' ? f.sh! : ESIZE[es]! - f.sh!)

for (const op of SHIFTS)
  for (const L of op.v) {
    const es = LETTER.indexOf(L)
    const q = es === 3 ? '1' : 'Q'
    INSTRS_.push({
      id: `${op.m}-v${L}`,
      mnemonic: op.m,
      group: 'simd',
      bits: `0 ${q} ${op.U} 011110 ${SH_BITS[es]} ${bin(op.opc, 5)} 1 Rn:5 Rd:5`,
      syntax: `<Vd:${L}:${q}>, <Vn:${L}:${q}>, #${op.kind === 'left' ? '<u:sh>' : `<rsh:${ESIZE[es]}>`}`,
      desc: op.desc,
      exec: (c, f) => {
        const bytes = f.Q === 0 && es < 3 ? 8 : 16
        const sh = shiftOf(op, es, f)
        const A = readV(c, f.Rn!, es, bytes)
        const D = op.acc ? readV(c, f.Rd!, es, bytes) : null
        const st: Sat = { qc: false }
        const R = A.map((a, i) => op.lane(a, D ? D[i]! : 0n, es, sh, st))
        if (st.qc) c.setQC()
        writeV(c, f.Rd!, R, es)
      },
    })
  }
for (const op of SHIFTS)
  for (const L of op.s) {
    const es = LETTER.indexOf(L)
    const R = L.toUpperCase()
    INSTRS_.push({
      id: `${op.m}-s${L}`,
      mnemonic: op.m,
      group: 'simd',
      bits: `01 ${op.U} 111110 ${SH_BITS[es]} ${bin(op.opc, 5)} 1 Rn:5 Rd:5`,
      syntax: `<${R}d>, <${R}n>, #${op.kind === 'left' ? '<u:sh>' : `<rsh:${ESIZE[es]}>`}`,
      desc: op.desc,
      exec: (c, f) => {
        const bytes = 1 << es
        const st: Sat = { qc: false }
        const r = op.lane(c.vget(f.Rn!, bytes), op.acc ? c.vget(f.Rd!, bytes) : 0n, es, shiftOf(op, es, f), st)
        if (st.qc) c.setQC()
        c.vset(f.Rd!, bytes, r)
      },
    })
  }

/* Narrowing right shifts: es is the narrow (destination) size; the source elements are twice as wide. */
type NLane = (a: bigint, es: number, sh: number, st: Sat) => bigint
const nshr = (srcUnsigned: boolean, dstUnsigned: boolean, round: boolean, saturate: boolean): NLane => (a, es, sh, st) => {
  const v = (int(a, es + 1, srcUnsigned) + rnd(round, sh)) >> BigInt(sh)
  return saturate ? satTo(v, es, dstUnsigned, st) : ux(v, es)
}
const NARROW: [number, number, string, boolean, Text, NLane][] = [
  [0, 0b10000, 'shrn', false, T('右移后取低半部分（变窄）', 'Shift right and narrow'), nshr(true, true, false, false)],
  [0, 0b10001, 'rshrn', false, T('舍入右移后变窄', 'Rounding shift right and narrow'), nshr(true, true, true, false)],
  [0, 0b10010, 'sqshrn', true, T('有符号右移后饱和变窄', 'Signed saturating shift right narrow'), nshr(false, false, false, true)],
  [0, 0b10011, 'sqrshrn', true, T('有符号舍入右移后饱和变窄', 'Signed saturating rounding shift right narrow'), nshr(false, false, true, true)],
  [1, 0b10000, 'sqshrun', true, T('有符号右移后饱和变窄成无符号', 'Signed saturating shift right, unsigned narrow'), nshr(false, true, false, true)],
  [1, 0b10001, 'sqrshrun', true, T('有符号舍入右移后饱和变窄成无符号', 'Signed saturating rounding shift right, unsigned narrow'), nshr(false, true, true, true)],
  [1, 0b10010, 'uqshrn', true, T('无符号右移后饱和变窄', 'Unsigned saturating shift right narrow'), nshr(true, true, false, true)],
  [1, 0b10011, 'uqrshrn', true, T('无符号舍入右移后饱和变窄', 'Unsigned saturating rounding shift right narrow'), nshr(true, true, true, true)],
]
for (const [U, opc, m, scalar, desc, lane] of NARROW)
  for (const L of 'bhs') {
    const es = LETTER.indexOf(L)
    const W = LETTER[es + 1]!
    for (const Q of [0, 1]) {
      const mm = Q ? `${m}2` : m
      INSTRS_.push({
        id: `${mm}-v${L}`,
        mnemonic: mm,
        group: 'simd',
        bits: `0 ${Q} ${U} 011110 ${SH_BITS[es]} ${bin(opc, 5)} 1 Rn:5 Rd:5`,
        syntax: `<Vd:${L}:${Q}>, <Vn:${W}:1>, #<rsh:${ESIZE[es]}>`,
        desc: Q ? T(`${desc.zh}，写进 Vd 的高半部分`, `${desc.en}, into the upper half of Vd`) : desc,
        exec: (c, f) => {
          const st: Sat = { qc: false }
          const sh = ESIZE[es]! - f.sh!
          const R = readV(c, f.Rn!, es + 1, 16).map((a) => lane(a, es, sh, st))
          if (st.qc) c.setQC()
          writeNarrow(c, f.Rd!, R, es, Q === 1)
        },
      })
    }
    if (scalar)
      INSTRS_.push({
        id: `${m}-s${L}`,
        mnemonic: m,
        group: 'simd',
        bits: `01 ${U} 111110 ${SH_BITS[es]} ${bin(opc, 5)} 1 Rn:5 Rd:5`,
        syntax: `<${L.toUpperCase()}d>, <${W.toUpperCase()}n>, #<rsh:${ESIZE[es]}>`,
        desc,
        exec: (c, f) => {
          const st: Sat = { qc: false }
          const r = lane(c.vget(f.Rn!, 2 << es), es, ESIZE[es]! - f.sh!, st)
          if (st.qc) c.setQC()
          c.vset(f.Rd!, 1 << es, r)
        },
      })
  }

/* Widening left shifts SSHLL, USHLL (and SXTL, UXTL for a shift of 0). */
for (const [U, m, x] of [
  [0, 'sshll', 'sxtl'],
  [1, 'ushll', 'uxtl'],
] as const)
  for (const L of 'bhs') {
    const es = LETTER.indexOf(L)
    const W = LETTER[es + 1]!
    for (const Q of [0, 1]) {
      const mm = Q ? `${m}2` : m
      const id = `${mm}-v${L}`
      INSTRS_.push({
        id,
        mnemonic: mm,
        group: 'simd',
        bits: `0 ${Q} ${U} 011110 ${SH_BITS[es]} 10100 1 Rn:5 Rd:5`,
        syntax: `<Vd:${W}:1>, <Vn:${L}:${Q}>, #<u:sh>`,
        desc: T(`${U ? '无' : '有'}符号扩展加宽后左移${Q ? '（取源的高半部分）' : ''}`, `${U ? 'Zero' : 'Sign'}-extend to twice the width, then shift left${Q ? ' (from the upper half)' : ''}`),
        exec: (c, f) =>
          writeV(
            c,
            f.Rd!,
            half(c, f.Rn!, es, Q === 1).map((a) => ux(int(a, es, U === 1) << BigInt(f.sh!), es + 1)),
            es + 1,
          ),
      })
      ALIASES_.push({
        id: `${Q ? `${x}2` : x}-v${L}`,
        of: id,
        mnemonic: Q ? `${x}2` : x,
        syntax: `<Vd:${W}:1>, <Vn:${L}:${Q}>`,
        fixed: { sh: 0 },
        prefer: false,
        desc: T(`把每个元素${U ? '零' : '符号'}扩展到两倍宽${Q ? '（取源的高半部分）' : ''}`, `${U ? 'Zero' : 'Sign'}-extend each element to twice the width${Q ? ' (from the upper half)' : ''}`),
        group: 'simd',
      })
    }
  }

/* ------------------------------------------------------------------ element copies */

/** imm5 with the element size fixed: the rest is the index `idx`. */
const IMM5 = ['idx:4 1', 'idx:3 10', 'idx:2 100', 'idx:1 1000']
/** INS (element)'s source index in imm4; the bits below it are ignored. */
const IMM4 = ['idx2:4', 'idx2:3 x:1', 'idx2:2 x:2', 'idx2:1 x:3']

const elemOf = (c: Cpu, n: number, es: number, i: number) => elems(c.vread(n, 16), es)[i]!
const gpr = (es: number) => (es === 3 ? 'X' : 'W')

for (const L of LETTER) {
  const es = LETTER.indexOf(L)
  const q = es === 3 ? '1' : 'Q'
  INSTRS_.push({
    id: `dup-e${L}`,
    mnemonic: 'dup',
    group: 'simd',
    bits: `0 ${q} 0 01110000 ${IMM5[es]} 0 0000 1 Rn:5 Rd:5`,
    syntax: `<Vd:${L}:${q}>, <X:n:${L}:idx>`,
    desc: T('把一个元素复制到向量的每个元素', 'Copy one element to every element of a vector'),
    exec: (c, f) => {
      const e = elemOf(c, f.Rn!, es, f.idx!)
      writeV(c, f.Rd!, Array(lanes(f.Q === 0 && es < 3 ? 8 : 16, es)).fill(e), es)
    },
  })
  INSTRS_.push({
    id: `dup-g${L}`,
    mnemonic: 'dup',
    group: 'simd',
    bits: `0 ${q} 0 01110000 ${IMM5[es].replace('idx', 'x')} 0 0001 1 Rn:5 Rd:5`,
    syntax: `<Vd:${L}:${q}>, <${gpr(es)}n>`,
    desc: T('把通用寄存器的值复制到向量的每个元素', 'Copy a general register to every element of a vector'),
    exec: (c, f) => {
      const e = ux(c.r(es === 3 ? 1 : 0, f.Rn!), es)
      writeV(c, f.Rd!, Array(lanes(f.Q === 0 && es < 3 ? 8 : 16, es)).fill(e), es)
    },
  })
  const insG = `ins-g${L}`
  INSTRS_.push({
    id: insG,
    mnemonic: 'ins',
    group: 'simd',
    bits: `0 1 0 01110000 ${IMM5[es]} 0 0011 1 Rn:5 Rd:5`,
    syntax: `<X:d:${L}:idx>, <${gpr(es)}n>`,
    desc: T('把通用寄存器的值写进向量的一个元素，其余元素不变', 'Insert a general register into one element of a vector, keeping the others'),
    exec: (c, f) => {
      const E = readV(c, f.Rd!, es, 16)
      E[f.idx!] = ux(c.r(es === 3 ? 1 : 0, f.Rn!), es)
      writeV(c, f.Rd!, E, es)
    },
  })
  ALIASES_.push({ id: `mov-${insG}`, of: insG, mnemonic: 'mov', syntax: `<X:d:${L}:idx>, <${gpr(es)}n>`, desc: T('把通用寄存器的值写进向量的一个元素（ins 的别名）', 'Insert a general register into a vector element (alias of ins)'), group: 'simd' })
  const insE = `ins-e${L}`
  INSTRS_.push({
    id: insE,
    mnemonic: 'ins',
    group: 'simd',
    bits: `0 1 1 01110000 ${IMM5[es]} 0 ${IMM4[es]} 1 Rn:5 Rd:5`,
    syntax: `<X:d:${L}:idx>, <X:n:${L}:idx2>`,
    desc: T('把一个向量元素复制到另一个向量的某个元素，其余元素不变', 'Copy one vector element into an element of another, keeping the others'),
    exec: (c, f) => {
      const e = elemOf(c, f.Rn!, es, f.idx2!)
      const E = readV(c, f.Rd!, es, 16)
      E[f.idx!] = e
      writeV(c, f.Rd!, E, es)
    },
  })
  ALIASES_.push({ id: `mov-${insE}`, of: insE, mnemonic: 'mov', syntax: `<X:d:${L}:idx>, <X:n:${L}:idx2>`, desc: T('复制向量元素（ins 的别名）', 'Copy a vector element (alias of ins)'), group: 'simd' })
  const dupS = `dup-s${L}`
  INSTRS_.push({
    id: dupS,
    mnemonic: 'dup',
    group: 'simd',
    bits: `01 0 11110000 ${IMM5[es]} 0 0000 1 Rn:5 Rd:5`,
    syntax: `<${L.toUpperCase()}d>, <X:n:${L}:idx>`,
    desc: T('把一个向量元素复制到标量寄存器', 'Copy a vector element to a scalar register'),
    exec: (c, f) => c.vset(f.Rd!, 1 << es, elemOf(c, f.Rn!, es, f.idx!)),
  })
  ALIASES_.push({ id: `mov-${dupS}`, of: dupS, mnemonic: 'mov', syntax: `<${L.toUpperCase()}d>, <X:n:${L}:idx>`, desc: T('把一个向量元素复制到标量寄存器（dup 的别名）', 'Copy a vector element to a scalar register (alias of dup)'), group: 'simd' })
}

/* UMOV and SMOV: an element to a general register, zero- or sign-extended. */
for (const [m, U, forms] of [
  ['umov', 1, [[0, 'bhs'], [1, 'd']]],
  ['smov', 0, [[0, 'bh'], [1, 'bhs']]],
] as [string, number, [number, string][]][])
  for (const [Q, sizes] of forms)
    for (const L of sizes) {
      const es = LETTER.indexOf(L)
      const id = `${m}-${Q ? 'x' : 'w'}${L}`
      const R = Q ? 'X' : 'W'
      INSTRS_.push({
        id,
        mnemonic: m,
        group: 'simd',
        bits: `0 ${Q} 0 01110000 ${IMM5[es]} 0 01${U}1 1 Rn:5 Rd:5`,
        syntax: `<${R}d>, <X:n:${L}:idx>`,
        desc: U ? T('把向量元素零扩展后放进通用寄存器', 'Move a vector element to a general register, zero-extended') : T('把向量元素符号扩展后放进通用寄存器', 'Move a vector element to a general register, sign-extended'),
        exec: (c, f) => {
          const e = elemOf(c, f.Rn!, es, f.idx!)
          c.setR(Q, f.Rd!, BigInt.asUintN(Q ? 64 : 32, U ? e : sx(e, es)))
        },
      })
      if (U && (es === 2 || es === 3))
        ALIASES_.push({ id: `mov-${id}`, of: id, mnemonic: 'mov', syntax: `<${R}d>, <X:n:${L}:idx>`, desc: T('把向量元素放进通用寄存器（umov 的别名）', 'Move a vector element to a general register (alias of umov)'), group: 'simd' })
    }

/* ------------------------------------------------------------------ modified immediates */

/** The bits of an 8-bit FP immediate in a format with `e` exponent and `f` fraction bits. */
export function fpImmBits(imm8: number, e: number, f: number): bigint {
  const a = (imm8 >> 7) & 1
  const b = (imm8 >> 6) & 1
  const cd = (imm8 >> 4) & 3
  const efgh = imm8 & 15
  let exp = b ? 0 : 1
  for (let i = 0; i < e - 3; i++) exp = (exp << 1) | b
  exp = (exp << 2) | cd
  return (BigInt(a) << BigInt(e + f)) | (BigInt(exp) << BigInt(f)) | (BigInt(efgh) << BigInt(f - 4))
}

const imm8Of = (f: Fields) => BigInt((f.abc! << 5) | f.defgh!)
type ImmKind = 'movi' | 'mvni' | 'orr' | 'bic'
function applyImm(c: Cpu, f: Fields, kind: ImmKind, es: number, elem: bigint, bytes = f.Q ? 16 : 8): void {
  const n = lanes(bytes, es)
  const imm = Array<bigint>(n).fill(elem)
  if (kind === 'movi') return writeV(c, f.Rd!, imm, es)
  if (kind === 'mvni') return writeV(c, f.Rd!, imm.map((v) => ~v & maskEs(es)), es)
  const D = readV(c, f.Rd!, es, bytes)
  writeV(
    c,
    f.Rd!,
    D.map((d) => (kind === 'orr' ? d | elem : d & ~elem)),
    es,
  )
}
const IMM_DESC: Record<ImmKind, Text> = {
  movi: T('把立即数（可移位）写进向量的每个元素', 'Move an immediate (optionally shifted) into every element'),
  mvni: T('把立即数（可移位）取反后写进每个元素', 'Move the inverted immediate (optionally shifted) into every element'),
  orr: T('每个元素和立即数（可移位）按位或', 'Bitwise OR of every element with an immediate (optionally shifted)'),
  bic: T('每个元素清除立即数（可移位）里为 1 的位', 'Clear in every element the bits set in an immediate (optionally shifted)'),
}
for (const [op, kinds] of [
  [0, ['movi', 'orr']],
  [1, ['mvni', 'bic']],
] as [number, ImmKind[]][]) {
  for (const [bit, kind] of kinds.map((k, i) => [i, k] as const)) {
    INSTRS_.push({
      id: `${kind}-i32`,
      mnemonic: kind,
      group: 'simd',
      bits: `0 Q ${op} 0111100000 abc:3 0 cm:2 ${bit} 0 1 defgh:5 Rd:5`,
      syntax: '<Vd:s:Q>, #<mimm8>{, lsl #<mlsl24>}',
      desc: IMM_DESC[kind],
      exec: (c, f) => applyImm(c, f, kind, 2, imm8Of(f) << BigInt(8 * f.cm!)),
    })
    INSTRS_.push({
      id: `${kind}-i16`,
      mnemonic: kind,
      group: 'simd',
      bits: `0 Q ${op} 0111100000 abc:3 10 cm:1 ${bit} 0 1 defgh:5 Rd:5`,
      syntax: '<Vd:h:Q>, #<mimm8>{, lsl #<mlsl8>}',
      desc: IMM_DESC[kind],
      exec: (c, f) => applyImm(c, f, kind, 1, imm8Of(f) << BigInt(8 * f.cm!)),
    })
  }
  const kind = kinds[0]!
  INSTRS_.push({
    id: `${kind}-msl`,
    mnemonic: kind,
    group: 'simd',
    bits: `0 Q ${op} 0111100000 abc:3 110 cm:1 0 1 defgh:5 Rd:5`,
    syntax: '<Vd:s:Q>, #<mimm8>, msl #<msl>',
    desc: T(`${kind === 'movi' ? '' : '取反后'}写进每个元素：立即数左移 8 或 16 位，移入的低位是 1`, `${kind === 'movi' ? 'Move' : 'Move the inverse of'} an immediate shifted left by 8 or 16 with ones shifted in`),
    exec: (c, f) => {
      const s = BigInt(8 * (f.cm! + 1))
      applyImm(c, f, kind, 2, (imm8Of(f) << s) | ((1n << s) - 1n))
    },
  })
}
INSTRS_.push({
  id: 'movi-i8',
  mnemonic: 'movi',
  group: 'simd',
  bits: '0 Q 0 0111100000 abc:3 1110 0 1 defgh:5 Rd:5',
  syntax: '<Vd:b:Q>, #<mimm8>',
  desc: T('把 8 位立即数写进每个字节', 'Move an 8-bit immediate into every byte'),
  exec: (c, f) => applyImm(c, f, 'movi', 0, imm8Of(f)),
})
const imm64 = (f: Fields) => {
  const imm8 = Number(imm8Of(f))
  let v = 0n
  for (let i = 0; i < 8; i++) if (imm8 & (1 << i)) v |= 0xffn << BigInt(8 * i)
  return v
}
INSTRS_.push({
  id: 'movi-d',
  mnemonic: 'movi',
  group: 'simd',
  bits: '0 0 1 0111100000 abc:3 1110 0 1 defgh:5 Rd:5',
  syntax: '<Dd>, #<mimm64>',
  desc: T('把 64 位立即数（每个字节 0x00 或 0xff）写进 Dd', 'Move a 64-bit immediate (each byte 0x00 or 0xff) into Dd'),
  exec: (c, f) => c.vset(f.Rd!, 8, imm64(f)),
})
INSTRS_.push({
  id: 'movi-2d',
  mnemonic: 'movi',
  group: 'simd',
  bits: '0 1 1 0111100000 abc:3 1110 0 1 defgh:5 Rd:5',
  syntax: '<Vd:d:1>, #<mimm64>',
  desc: T('把 64 位立即数（每个字节 0x00 或 0xff）写进两个元素', 'Move a 64-bit immediate (each byte 0x00 or 0xff) into both elements'),
  exec: (c, f) => applyImm(c, f, 'movi', 3, imm64(f), 16),
})
for (const [id, Q, op, o2, L, e, fr] of [
  ['fmov-vs', 'Q', 0, 0, 's', 8, 23],
  ['fmov-vh', 'Q', 0, 1, 'h', 5, 10],
  ['fmov-vd', '1', 1, 0, 'd', 11, 52],
] as const)
  INSTRS_.push({
    id,
    mnemonic: 'fmov',
    group: 'simd',
    feature: L === 'h' ? 'fp16' : undefined,
    bits: `0 ${Q} ${op} 0111100000 abc:3 1111 ${o2} 1 defgh:5 Rd:5`,
    syntax: `<Vd:${L}:${Q}>, #<fimmv>`,
    desc: T('把浮点立即数写进向量的每个元素', 'Move a floating-point immediate into every element'),
    exec: (c, f) => applyImm(c, f, 'movi', LETTER.indexOf(L), fpImmBits(Number(imm8Of(f)), e, fr), Q === '1' ? 16 : undefined),
  })

/* ------------------------------------------------------------------ permutes, EXT, table lookups */

const PERMUTE: [number, string, Text, (A: bigint[], B: bigint[], i: number) => bigint][] = [
  [0b001, 'uzp1', T('取 Vn:Vm 拼起来后的偶数号元素', 'Even-numbered elements of Vn:Vm together'), (A, B, i) => [...A, ...B][2 * i]!],
  [0b101, 'uzp2', T('取 Vn:Vm 拼起来后的奇数号元素', 'Odd-numbered elements of Vn:Vm together'), (A, B, i) => [...A, ...B][2 * i + 1]!],
  [0b010, 'trn1', T('转置：偶数位置取 Vn 的偶数号元素，奇数位置取 Vm 的偶数号元素', 'Transpose: even elements of Vn and Vm, interleaved'), (A, B, i) => (i % 2 ? B[i - 1]! : A[i]!)],
  [0b110, 'trn2', T('转置：取 Vn 和 Vm 的奇数号元素交错排列', 'Transpose: odd elements of Vn and Vm, interleaved'), (A, B, i) => (i % 2 ? B[i]! : A[i + 1]!)],
  [0b011, 'zip1', T('交错 Vn 和 Vm 的低半部分', 'Interleave the lower halves of Vn and Vm'), (A, B, i) => (i % 2 ? B : A)[i >> 1]!],
  [0b111, 'zip2', T('交错 Vn 和 Vm 的高半部分', 'Interleave the upper halves of Vn and Vm'), (A, B, i) => (i % 2 ? B : A)[(A.length >> 1) + (i >> 1)]!],
]
for (const [opc, m, desc, pick] of PERMUTE)
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    bits: `0 Q 001110 size:2 0 Rm:5 0 ${bin(opc, 3)} 10 Rn:5 Rd:5`,
    syntax: '<Vd:size:Q>, <Vn:size:Q>, <Vm:size:Q>',
    valid: (f) => !(f.size === 3 && f.Q === 0),
    desc,
    exec: (c, f) => {
      const bytes = f.Q ? 16 : 8
      const A = readV(c, f.Rn!, f.size!, bytes)
      const B = readV(c, f.Rm!, f.size!, bytes)
      writeV(
        c,
        f.Rd!,
        A.map((_, i) => pick(A, B, i)),
        f.size!,
      )
    },
  })

INSTRS_.push({
  id: 'ext-v',
  mnemonic: 'ext',
  group: 'simd',
  bits: '0 Q 101110 00 0 Rm:5 0 imm4:4 0 Rn:5 Rd:5',
  syntax: '<Vd:b:Q>, <Vn:b:Q>, <Vm:b:Q>, #<u:imm4>',
  valid: (f) => f.Q === 1 || f.imm4! < 8,
  check: (f) => (f.Q === 0 && f.imm4! >= 8 ? 'index' : undefined),
  desc: T('从 Vm:Vn 拼起来的字节里，从第 index 个字节开始取一个向量', 'Extract a vector from the bytes of Vm:Vn, starting at byte index'),
  example: 'ext v0.16b, v1.16b, v2.16b, #4',
  exec: (c, f) => {
    const bytes = f.Q ? 16 : 8
    const cat = new Uint8Array(2 * bytes)
    cat.set(c.vread(f.Rn!, bytes), 0)
    cat.set(c.vread(f.Rm!, bytes), bytes)
    c.vwrite(f.Rd!, cat.slice(f.imm4!, f.imm4! + bytes))
  },
})

for (const [op, m] of [
  [0, 'tbl'],
  [1, 'tbx'],
] as const)
  for (let len = 0; len < 4; len++)
    INSTRS_.push({
      id: `${m}${len + 1}`,
      mnemonic: m,
      group: 'simd',
      bits: `0 Q 001110 000 Rm:5 0 ${bin(len, 2)} ${op} 00 Rn:5 Rd:5`,
      syntax: `<Vd:b:Q>, <L:Rn:${len + 1}:b:1>, <Vm:b:Q>`,
      desc: op
        ? T(`查表：Vm 的每个字节是 ${len + 1} 个寄存器组成的表里的下标；超出范围的位置保持 Vd 不变`, `Table lookup: each byte of Vm indexes a table of ${len + 1} registers; out-of-range bytes keep Vd`)
        : T(`查表：Vm 的每个字节是 ${len + 1} 个寄存器组成的表里的下标；超出范围的得 0`, `Table lookup: each byte of Vm indexes a table of ${len + 1} registers; out-of-range bytes give 0`),
      example: len === 0 ? `${m} v0.16b, { v1.16b }, v2.16b` : undefined,
      exec: (c, f) => {
        const bytes = f.Q ? 16 : 8
        const table = new Uint8Array(16 * (len + 1))
        for (let i = 0; i <= len; i++) table.set(c.vread((f.Rn! + i) % 32, 16), 16 * i)
        const idx = c.vread(f.Rm!, bytes)
        const out = op ? c.vread(f.Rd!, bytes) : new Uint8Array(bytes)
        for (let i = 0; i < bytes; i++) if (idx[i]! < table.length) out[i] = table[idx[i]!]!
        c.vwrite(f.Rd!, out)
      },
    })

/* ------------------------------------------------------------------ multiplies by element */

/** The element an indexed operand names: h uses a 4-bit Rm and H:L:M, s uses M:Rm and H:L. */
export function indexedElem(c: Cpu, f: Fields, es: number): bigint {
  const reg = es === 1 ? f.Rm! : (f.M! << 4) | f.Rm!
  const i = es === 1 ? (f.H! << 2) | (f.L! << 1) | f.M! : es === 2 ? (f.H! << 1) | f.L! : f.H!
  return elems(c.vread(reg, 16), es)[i]!
}

type ElemLane = (a: bigint, b: bigint, d: bigint, es: number, st: Sat) => bigint
const rdm = (sub: boolean): ElemLane => (a, b, d, es, st) => {
  const e = BigInt(ESIZE[es]!)
  const prod = 2n * sx(a, es) * sx(b, es)
  return satTo(((sx(d, es) << e) + (sub ? -prod : prod) + (1n << (e - 1n))) >> e, es, false, st)
}
const dmulhE = (round: boolean): ElemLane => (a, b, _d, es, st) => satTo((2n * sx(a, es) * sx(b, es) + (round ? 1n << BigInt(ESIZE[es]! - 1) : 0n)) >> BigInt(ESIZE[es]!), es, false, st)

const BYELEM: [number, number, string, Text, ElemLane, boolean, string][] = [
  [0, 0b1000, 'mul', T('乘以 Vm 的一个元素', 'Multiply by an element of Vm'), (a, b, _d, es) => ux(a * b, es), false, ''],
  [1, 0b0000, 'mla', T('乘以 Vm 的一个元素后加到 Vd', 'Multiply by an element and add to Vd'), (a, b, d, es) => ux(d + a * b, es), true, ''],
  [1, 0b0100, 'mls', T('乘以 Vm 的一个元素后从 Vd 减去', 'Multiply by an element and subtract from Vd'), (a, b, d, es) => ux(d - a * b, es), true, ''],
  [0, 0b1100, 'sqdmulh', T('有符号饱和加倍乘以元素，取高半部分', 'Signed saturating doubling multiply by element, high half'), dmulhE(false), false, 's'],
  [0, 0b1101, 'sqrdmulh', T('有符号饱和舍入加倍乘以元素，取高半部分', 'Signed saturating rounding doubling multiply by element, high half'), dmulhE(true), false, 's'],
  [1, 0b1101, 'sqrdmlah', T('有符号饱和舍入加倍乘以元素后累加，取高半部分', 'Signed saturating rounding doubling multiply by element, accumulate, high half'), rdm(false), true, 'r'],
  [1, 0b1111, 'sqrdmlsh', T('有符号饱和舍入加倍乘以元素后从 Vd 减去，取高半部分', 'Signed saturating rounding doubling multiply by element, subtract, high half'), rdm(true), true, 'r'],
]
for (const [U, opc, m, desc, lane, acc, scalar] of BYELEM) {
  const feature = scalar === 'r' ? 'rdm' : undefined
  INSTRS_.push({
    id: `${m}-ve`,
    mnemonic: m,
    group: 'simd',
    feature,
    bits: `0 Q ${U} 01111 size:2 L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
    syntax: '<Vd:size:Q>, <Vn:size:Q>, <E@mul>',
    valid: (f) => f.size === 1 || f.size === 2,
    desc,
    exec: (c, f) => {
      const es = f.size!
      const bytes = f.Q ? 16 : 8
      const b = indexedElem(c, f, es)
      const D = acc ? readV(c, f.Rd!, es, bytes) : null
      const st: Sat = { qc: false }
      const R = readV(c, f.Rn!, es, bytes).map((a, i) => lane(a, b, D ? D[i]! : 0n, es, st))
      if (st.qc) c.setQC()
      writeV(c, f.Rd!, R, es)
    },
  })
  if (scalar)
    INSTRS_.push({
      id: `${m}-se`,
      mnemonic: m,
      group: 'simd',
      feature,
      bits: `01 ${U} 11111 size:2 L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
      syntax: '<Ed:size>, <En:size>, <E@mul>',
      valid: (f) => f.size === 1 || f.size === 2,
      desc,
      exec: (c, f) => {
        const es = f.size!
        const st: Sat = { qc: false }
        const r = lane(c.vget(f.Rn!, 1 << es), indexedElem(c, f, es), acc ? c.vget(f.Rd!, 1 << es) : 0n, es, st)
        if (st.qc) c.setQC()
        c.vset(f.Rd!, 1 << es, r)
      },
    })
}

/* Widening multiplies by element. */
const lmul = (unsigned: boolean, sign: number): ElemLane => (a, b, d, es) => ux(d + BigInt(sign) * int(a, es, unsigned) * int(b, es, unsigned), es + 1)
const ldmul = (sign: number, acc: boolean): ElemLane => (a, b, d, es, st) => {
  const p = satTo(2n * sx(a, es) * sx(b, es), es + 1, false, st)
  return acc ? satTo(sx(d, es + 1) + BigInt(sign) * sx(p, es + 1), es + 1, false, st) : p
}
const LONG_ELEM: [number, number, string, Text, ElemLane, boolean, boolean][] = [
  [0, 0b0010, 'smlal', T('有符号加宽乘以元素后累加', 'Signed multiply-add long by element'), lmul(false, 1), true, false],
  [0, 0b0110, 'smlsl', T('有符号加宽乘以元素后减', 'Signed multiply-subtract long by element'), lmul(false, -1), true, false],
  [0, 0b1010, 'smull', T('有符号加宽乘以元素', 'Signed multiply long by element'), lmul(false, 1), false, false],
  [1, 0b0010, 'umlal', T('无符号加宽乘以元素后累加', 'Unsigned multiply-add long by element'), lmul(true, 1), true, false],
  [1, 0b0110, 'umlsl', T('无符号加宽乘以元素后减', 'Unsigned multiply-subtract long by element'), lmul(true, -1), true, false],
  [1, 0b1010, 'umull', T('无符号加宽乘以元素', 'Unsigned multiply long by element'), lmul(true, 1), false, false],
  [0, 0b0011, 'sqdmlal', T('有符号饱和加倍乘以元素后累加（加宽）', 'Signed saturating doubling multiply-add long by element'), ldmul(1, true), true, true],
  [0, 0b0111, 'sqdmlsl', T('有符号饱和加倍乘以元素后减（加宽）', 'Signed saturating doubling multiply-subtract long by element'), ldmul(-1, true), true, true],
  [0, 0b1011, 'sqdmull', T('有符号饱和加倍乘以元素（加宽）', 'Signed saturating doubling multiply long by element'), ldmul(1, false), false, true],
]
for (const [U, opc, m, desc, lane, acc, scalar] of LONG_ELEM) {
  for (const Q of [0, 1]) {
    const mm = Q ? `${m}2` : m
    INSTRS_.push({
      id: `${mm}-ve`,
      mnemonic: mm,
      group: 'simd',
      bits: `0 ${Q} ${U} 01111 size:2 L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
      syntax: `<Vd:size+1:1>, <Vn:size:${Q}>, <E@mull>`,
      valid: (f) => f.size === 1 || f.size === 2,
      desc: Q ? T(`${desc.zh}（取 Vn 的高半部分）`, `${desc.en} (upper half of Vn)`) : desc,
      exec: (c, f) => {
        const es = f.size!
        const b = indexedElem(c, f, es)
        const D = acc ? readV(c, f.Rd!, es + 1, 16) : null
        const st: Sat = { qc: false }
        const R = half(c, f.Rn!, es, Q === 1).map((a, i) => lane(a, b, D ? D[i]! : 0n, es, st))
        if (st.qc) c.setQC()
        writeV(c, f.Rd!, R, es + 1)
      },
    })
  }
  if (scalar)
    INSTRS_.push({
      id: `${m}-se`,
      mnemonic: m,
      group: 'simd',
      bits: `01 ${U} 11111 size:2 L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
      syntax: '<Ed:size+1>, <En:size>, <E@mull>',
      valid: (f) => f.size === 1 || f.size === 2,
      desc,
      exec: (c, f) => {
        const es = f.size!
        const st: Sat = { qc: false }
        const r = lane(c.vget(f.Rn!, 1 << es), indexedElem(c, f, es), acc ? c.vget(f.Rd!, 2 << es) : 0n, es, st)
        if (st.qc) c.setQC()
        c.vset(f.Rd!, 2 << es, r)
      },
    })
}

/* ------------------------------------------------------------------ RDM, dot products, matrix multiplies */

for (const [opc, m, sub] of [
  [0, 'sqrdmlah', false],
  [1, 'sqrdmlsh', true],
] as const) {
  const desc = BYELEM.find((b) => b[2] === m)![3]
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    feature: 'rdm',
    bits: `0 Q 1 01110 size:2 0 Rm:5 1 000${opc} 1 Rn:5 Rd:5`,
    syntax: '<Vd:size:Q>, <Vn:size:Q>, <Vm:size:Q>',
    valid: (f) => f.size === 1 || f.size === 2,
    desc: T(desc.zh.replace('以元素', ''), desc.en.replace(' by element', '')),
    exec: (c, f) => {
      const es = f.size!
      const bytes = f.Q ? 16 : 8
      const B = readV(c, f.Rm!, es, bytes)
      const D = readV(c, f.Rd!, es, bytes)
      const st: Sat = { qc: false }
      const R = readV(c, f.Rn!, es, bytes).map((a, i) => rdm(sub)(a, B[i]!, D[i]!, es, st))
      if (st.qc) c.setQC()
      writeV(c, f.Rd!, R, es)
    },
  })
  INSTRS_.push({
    id: `${m}-sc`,
    mnemonic: m,
    group: 'simd',
    feature: 'rdm',
    bits: `01 1 11110 size:2 0 Rm:5 1 000${opc} 1 Rn:5 Rd:5`,
    syntax: '<Ed:size>, <En:size>, <Em:size>',
    valid: (f) => f.size === 1 || f.size === 2,
    desc: T(desc.zh.replace('以元素', ''), desc.en.replace(' by element', '')),
    exec: (c, f) => {
      const es = f.size!
      const st: Sat = { qc: false }
      const r = rdm(sub)(c.vget(f.Rn!, 1 << es), c.vget(f.Rm!, 1 << es), c.vget(f.Rd!, 1 << es), es, st)
      if (st.qc) c.setQC()
      c.vset(f.Rd!, 1 << es, r)
    },
  })
}

/** Four-way dot product of bytes into 32-bit lanes: Vd.s[i] += Σ n[4i+k] × m[4i+k]. */
function dot(c: Cpu, f: Fields, nU: boolean, mU: boolean, m: (i: number) => bigint[]): void {
  const bytes = f.Q ? 16 : 8
  const N = readV(c, f.Rn!, 0, bytes)
  const D = readV(c, f.Rd!, 2, bytes)
  writeV(
    c,
    f.Rd!,
    D.map((d, i) => {
      const M = m(i)
      let s = d
      for (let k = 0; k < 4; k++) s += int(N[4 * i + k]!, 0, nU) * int(M[k]!, 0, mU)
      return ux(s, 2)
    }),
    2,
  )
}
const dotDesc = (n: string, m: string) => T(`点积：Vn 和 Vm 每 4 个字节（${n} × ${m}）相乘求和，加到 Vd 的 32 位元素`, `Dot product: each group of 4 bytes of Vn and Vm (${n} × ${m}) multiplied and summed into a 32-bit element of Vd`)
const SIGN = ['signed', 'unsigned']
for (const [U, opc, m, nU, mU, feature] of [
  [0, 0b0010, 'sdot', false, false, 'dotprod'],
  [1, 0b0010, 'udot', true, true, 'dotprod'],
  [0, 0b0011, 'usdot', true, false, 'i8mm'],
] as const) {
  const desc = dotDesc(SIGN[+nU]!, SIGN[+mU]!)
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    feature,
    bits: `0 Q ${U} 01110 10 0 Rm:5 1 ${bin(opc, 4)} 1 Rn:5 Rd:5`,
    syntax: '<Vd:s:Q>, <Vn:b:Q>, <Vm:b:Q>',
    desc,
    exec: (c, f) => {
      const M = readV(c, f.Rm!, 0, 16)
      dot(c, f, nU, mU, (i) => M.slice(4 * i, 4 * i + 4))
    },
  })
}
const groupOf = (c: Cpu, f: Fields) => {
  const reg = (f.M! << 4) | f.Rm!
  const i = (f.H! << 1) | f.L!
  return readV(c, reg, 0, 16).slice(4 * i, 4 * i + 4)
}
for (const [U, opc, size, m, nU, mU, feature] of [
  [0, 0b1110, 2, 'sdot', false, false, 'dotprod'],
  [1, 0b1110, 2, 'udot', true, true, 'dotprod'],
  [0, 0b1111, 2, 'usdot', true, false, 'i8mm'],
  [0, 0b1111, 0, 'sudot', false, true, 'i8mm'],
] as const)
  INSTRS_.push({
    id: `${m}-ve`,
    mnemonic: m,
    group: 'simd',
    feature,
    bits: `0 Q ${U} 01111 ${bin(size, 2)} L M Rm:4 ${bin(opc, 4)} H 0 Rn:5 Rd:5`,
    syntax: '<Vd:s:Q>, <Vn:b:Q>, <E@dot4b>',
    desc: T(`${dotDesc(SIGN[+nU]!, SIGN[+mU]!).zh}；Vm 的同一组 4 个字节用于每个元素`, `${dotDesc(SIGN[+nU]!, SIGN[+mU]!).en}; the same 4-byte group of Vm for every element`),
    exec: (c, f) => {
      const g = groupOf(c, f)
      dot(c, f, nU, mU, () => g)
    },
  })

for (const [U, opc, m, nU, mU] of [
  [0, 0b0100, 'smmla', false, false],
  [1, 0b0100, 'ummla', true, true],
  [0, 0b0101, 'usmmla', true, false],
] as const)
  INSTRS_.push({
    id: `${m}-v`,
    mnemonic: m,
    group: 'simd',
    feature: 'i8mm',
    bits: `0 1 ${U} 01110 10 0 Rm:5 1 ${bin(opc, 4)} 1 Rn:5 Rd:5`,
    syntax: '<Vd:s:1>, <Vn:b:1>, <Vm:b:1>',
    desc: T('8 位整数矩阵乘加：Vd（2×2 的 32 位）+= Vn（2×8）× Vm（2×8）的转置', '8-bit integer matrix multiply-accumulate: Vd (2×2 of 32 bits) += Vn (2×8) × transpose of Vm (2×8)'),
    exec: (c, f) => {
      const N = readV(c, f.Rn!, 0, 16)
      const M = readV(c, f.Rm!, 0, 16)
      const D = readV(c, f.Rd!, 2, 16)
      writeV(
        c,
        f.Rd!,
        D.map((d, k) => {
          const i = k >> 1
          const j = k & 1
          let s = d
          for (let x = 0; x < 8; x++) s += int(N[8 * i + x]!, 0, nU) * int(M[8 * j + x]!, 0, mU)
          return ux(s, 2)
        }),
        2,
      )
    },
  })

export const INSTRS = INSTRS_
export const ALIASES = ALIASES_
