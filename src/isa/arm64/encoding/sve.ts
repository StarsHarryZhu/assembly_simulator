/**
 * Operand types of the SVE instructions, resolved from template placeholders (see resolveSve). Register
 * placeholders name their encoding field, then the element size after a dot:
 *
 *   <Zdn.size> <Zn.size-1> <Zm.s> <Zt>    a Z register (the field may be 3 or 4 bits wide) with an element
 *                                        size: a field (+/- an offset), a fixed letter, `tsz` (the highest
 *                                        set bit of tszh:tszl, for shifts), `tszlo` (the lowest set bit of
 *                                        tsz, for DUP's index) or `limm` (the logical immediate's element);
 *                                        no suffix when there is no dot
 *   <Pg> <Pg/m> <Pg/z> <Pg/M> <Pd.size>  a predicate; /m, /z, or either chosen by the field M
 *   <PNd.size> <PNg>                     a predicate-as-counter, pn8–pn15 in a 3-bit field
 *   <Vd.size> <Rd:size> <Rn|SP:size>     a scalar SIMD&FP register named by the element size, and a general
 *                                        register that is X for 64-bit elements and W otherwise
 *   <L:Zt:3:size> <LM:Zn:2:s>            a list of consecutive Z registers ({ z0.b - z2.b }); LM: the field
 *                                        holds the first register divided by the count
 *   <PL:Pd:size> <PLA:Pd:size>           a pair of predicates { p0.b, p1.b } whose field holds the first / 2;
 *                                        PLA: any first predicate, wrapping ({ p15.b, p0.b })
 *   <Zm.h[i3h+i3l]>                      a Z element whose index is made of the listed fields
 *   <Zn.tszlo[dup]>                      DUP's element: index and size both in imm2:tsz
 *   <PNn[idx]>                           a predicate-as-counter with an index (PEXT)
 *
 * and immediates: <imm8sh:s|u> (8 bits, optionally shifted left by 8), <limm> (logical, 13 bits), <pattern>
 * (ptrue and element counts), <sveprf> (prefetch operation), <xs> (uxtw/sxtw), <fimm1:a:b> (one of two
 * floating-point values), <tsr> and <tsl> (shift amounts in tszh:tszl:imm3), <vlx> (vlx2/vlx4), <Wv> (w12–w15
 * in the 2-bit field Rv).
 *
 * Where the element size sits in a field shared with something else (tsz, imm13), parsing records it in
 * the pseudo field `_es`, which no pattern has, for the operands after it.
 */
import { L } from '../../../core/i18n'
import { gprName, parseGpr, parseSveReg, parseVreg } from '../registers'
import { decodeBitmask, encodeBitmask } from './bitmask'
import { printWidths } from './operands'
import { readFloat } from './simd'
import { fmtImm, unify, type Fields, type OperandStream, type OperandType, type OpSpec } from './syntax'

const LETTERS = 'bhsdq'
const ESIZE = [8, 16, 32, 64, 128]

export const highBit = (v: number) => 31 - Math.clz32(v)
export const lowBit = (v: number) => 31 - Math.clz32(v & -v)

/* ------------------------------------------------------------------ element sizes */

export type Es = { k: 'fixed'; es: number } | { k: 'field'; field: string; add: number } | { k: 'tsz'; add: number } | { k: 'tszlo' } | { k: 'limm' }

export function parseEs(text: string): Es {
  if (text.length === 1 && LETTERS.includes(text)) return { k: 'fixed', es: LETTERS.indexOf(text) }
  const m = /^([A-Za-z_]\w*?)([+-]\d)?$/.exec(text)
  if (!m) throw new Error(`bad element size ${text}`)
  const add = m[2] ? Number(m[2]) : 0
  if (m[1] === 'tsz') return { k: 'tsz', add }
  if (m[1] === 'tszlo') return { k: 'tszlo' }
  if (m[1] === 'limm') return { k: 'limm' }
  return { k: 'field', field: m[1]!, add }
}

const width = (f: string) => printWidths.current[f] ?? 0

/** tszh:tszl (or a single tsz field) as one number. */
function tszOf(f: Fields): number | undefined {
  if (f.tszh !== undefined && f.tszl !== undefined) return (f.tszh << width('tszl')) | f.tszl
  return f.tsz
}

/** The element size of a logical immediate's encoding: the size of its repeating pattern (at least a byte). */
export function limmEs(imm13: number): number {
  const N = imm13 >> 12
  const imms = imm13 & 0x3f
  const combined = (N << 6) | (~imms & 0x3f)
  const len = combined ? highBit(combined) : 0
  return Math.max(0, len - 3)
}

export function esOf(f: Fields, e: Es): number | undefined {
  switch (e.k) {
    case 'fixed':
      return e.es
    case 'field':
      return f[e.field] === undefined ? undefined : f[e.field]! + e.add
    case 'tsz': {
      const t = tszOf(f)
      return t ? highBit(t) + e.add : f._es === undefined ? undefined : f._es + e.add
    }
    case 'tszlo':
      return f.tsz ? lowBit(f.tsz) : f._es
    case 'limm':
      return f.imm13 !== undefined ? limmEs(f.imm13) : f._es
  }
}

function setEs(s: OperandStream, f: Fields, e: Es, es: number): void {
  const bad = () => s.fail(L('元素大小不对', 'Wrong element size'))
  const differ = L('元素大小不一致', 'The element sizes do not match')
  switch (e.k) {
    case 'fixed':
      if (es !== e.es) bad()
      return
    case 'field': {
      const v = es - e.add
      if (v < 0 || v >= 1 << s.width(e.field)) bad()
      unify(s, f, e.field, v, differ)
      return
    }
    case 'tsz':
      if (es - e.add < 0 || es - e.add > 3) bad()
      unify(s, f, '_es', es - e.add, differ)
      return
    case 'tszlo':
      if (es > 4) bad()
      unify(s, f, '_es', es, differ)
      return
    case 'limm':
      if (es > 3) bad()
      unify(s, f, '_es', es, differ)
  }
}

/** The fields an element size is read from, for the decoder's field meanings. */
const esFields = (e: Es | null): string[] => (!e ? [] : e.k === 'field' ? [e.field] : e.k === 'tsz' ? ['tszh', 'tszl'] : e.k === 'tszlo' ? ['tsz'] : e.k === 'limm' ? ['imm13'] : [])

/** A sample element size: s where the field allows it, else the smallest allowed. */
function sampleEs(f: Fields, e: Es): number {
  const known = esOf(f, e)
  if (known !== undefined) return known
  if (e.k === 'field') {
    const w = width(e.field) || 2
    const v = Math.min(Math.max(2 - e.add, 0), (1 << w) - 1)
    f[e.field] = v
    return v + e.add
  }
  f._es = 2
  return e.k === 'tsz' ? 2 + e.add : 2
}

const SAMPLE: Record<string, number> = { Zd: 0, Zdn: 0, Zda: 0, Zt: 0, Zn: 1, Zm: 2, Zk: 3, Za: 3, Pd: 0, Pdn: 0, Pdm: 0, Pg: 1, Pn: 2, Pm: 3, Pt: 0, Pv: 1, Vd: 0, Vdn: 0, Vn: 1, Vm: 2 }
const suffix = (es: number | undefined) => (es === undefined ? '' : '.' + LETTERS[es])

function ident(s: OperandStream): string | null {
  const t = s.peek()
  return t && t.kind === 'ident' ? t.text : null
}

/* ------------------------------------------------------------------ Z registers */

interface ZArg {
  field: string
  es: Es | null
}

const zreg: OperandType<ZArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const text = ident(s)
    const r = text ? parseSveReg(text) : null
    if (!r || r.kind !== 'z') s.fail(L('这里应该是 z 寄存器', 'Expected a z register'))
    if (a.es === null && r.es !== null) s.fail(L('这里的 z 寄存器不带元素大小', 'This z register takes no element size'))
    if (a.es !== null && r.es === null) s.fail(L('z 寄存器要写元素大小，例如 z0.s', 'Give the z register an element size, e.g. z0.s'))
    if (r.n >= 1 << s.width(a.field)) s.fail(L(`这里只能用 z0 到 z${(1 << s.width(a.field)) - 1}`, `Only z0 to z${(1 << s.width(a.field)) - 1} are allowed here`), true)
    if (a.es !== null) setEs(s, f, a.es, r.es!)
    unify(s, f, a.field, r.n, L('这两个 z 寄存器必须是同一个', 'These z registers must be the same one'))
    s.pos++
  },
  print: (f, a) => `z${f[a.field] ?? 0}${a.es ? suffix(esOf(f, a.es)) : ''}`,
  fields: (a) => [a.field, ...esFields(a.es)],
  sample(f, a) {
    const n = f[a.field] ?? SAMPLE[a.field] ?? 0
    f[a.field] = n
    return `z${n}${a.es ? suffix(sampleEs(f, a.es)) : ''}`
  },
  hint: (a) => (a.es ? L('z 寄存器，例如 z0.s', 'a z register, e.g. z0.s') : L('z 寄存器，例如 z0', 'a z register, e.g. z0')),
  options: (f, a) => Array.from({ length: 1 << (width(a.field) || 5) }, (_, i) => `z${i}${a.es ? suffix(esOf(f, a.es) ?? 2) : ''}`),
}

/* ------------------------------------------------------------------ predicates */

interface PArg {
  field: string
  es: Es | null
  /** '/m', '/z', or 'M' for either one chosen by the field M. */
  qual: '' | 'm' | 'z' | 'M'
  /** A predicate-as-counter (pn): 3-bit fields hold pn8–pn15. */
  counter: boolean
}

const pbase = (a: PArg) => (a.counter && width(a.field) === 3 ? 8 : 0)

const preg: OperandType<PArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const text = ident(s)
    const r = text ? parseSveReg(text) : null
    const want = a.counter ? 'pn' : 'p'
    if (!r || r.kind !== want) s.fail(a.counter ? L('这里应该是计数谓词 pn8 到 pn15', 'Expected a predicate-as-counter, pn8 to pn15') : L('这里应该是谓词寄存器 p0 到 p15', 'Expected a predicate register, p0 to p15'))
    if (a.es === null && r.es !== null) s.fail(L('这个谓词不带元素大小', 'This predicate takes no element size'))
    if (a.es !== null && r.es === null) s.fail(L('谓词要写元素大小，例如 p0.s', 'Give the predicate an element size, e.g. p0.s'))
    const base = a.counter && s.width(a.field) === 3 ? 8 : 0
    const n = r.n - base
    if (n < 0 || n >= 1 << s.width(a.field)) {
      const hi = base + (1 << s.width(a.field)) - 1
      s.fail(L(`这里只能用 ${want}${base} 到 ${want}${hi}`, `Only ${want}${base} to ${want}${hi} are allowed here`), true)
    }
    if (a.es !== null) setEs(s, f, a.es, r.es!)
    unify(s, f, a.field, n, L('这两个谓词必须是同一个', 'These predicates must be the same one'))
    s.pos++
    if (!a.qual) return
    if (!s.eat('/')) s.fail(a.qual === 'M' ? L('谓词后面要写 /m（保留）或 /z（清零）', 'Write /m (merge) or /z (zero) after the predicate') : L(`谓词后面要写 /${a.qual}`, `Write /${a.qual} after the predicate`))
    const q = s.word()
    if (a.qual === 'M') {
      if (q !== 'm' && q !== 'z') s.fail(L('这里应该是 /m 或 /z', 'Expected /m or /z'))
      unify(s, f, 'M', q === 'm' ? 1 : 0)
    } else if (q !== a.qual) s.fail(L(`这里只能是 /${a.qual}`, `Only /${a.qual} is allowed here`))
    s.pos++
  },
  print(f, a) {
    const name = `${a.counter ? 'pn' : 'p'}${(f[a.field] ?? 0) + pbase(a)}${a.es ? suffix(esOf(f, a.es)) : ''}`
    if (!a.qual) return name
    return `${name}/${a.qual === 'M' ? (f.M ? 'm' : 'z') : a.qual}`
  },
  fields: (a) => [a.field, ...esFields(a.es), ...(a.qual === 'M' ? ['M'] : [])],
  sample(f, a) {
    const n = f[a.field] ?? SAMPLE[a.field] ?? 0
    f[a.field] = n
    if (a.qual === 'M' && f.M === undefined) f.M = 1
    const name = `${a.counter ? 'pn' : 'p'}${n + pbase(a)}${a.es ? suffix(sampleEs(f, a.es)) : ''}`
    return a.qual ? `${name}/${a.qual === 'M' ? (f.M ? 'm' : 'z') : a.qual}` : name
  },
  hint: (a) => (a.counter ? L('计数谓词，例如 pn8.s', 'a predicate-as-counter, e.g. pn8.s') : a.qual ? L(`执行谓词，例如 p0/${a.qual === 'z' ? 'z' : 'm'}`, `a governing predicate, e.g. p0/${a.qual === 'z' ? 'z' : 'm'}`) : L('谓词寄存器，例如 p0', 'a predicate register, e.g. p0')),
  options: (f, a) => Array.from({ length: 1 << (width(a.field) || 4) }, (_, i) => `${a.counter ? 'pn' : 'p'}${i + pbase(a)}${a.es ? suffix(esOf(f, a.es) ?? 0) : ''}${a.qual === 'm' || a.qual === 'z' ? '/' + a.qual : ''}`),
}

/* ------------------------------------------------------------------ scalar registers */

/** A SIMD&FP scalar named by an element size: b0, h0, s0, d0, q0. */
const vscalar: OperandType<ZArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const text = ident(s)
    const r = text ? parseVreg(text) : null
    if (!r || r.kind === 'v') s.fail(L('这里应该是标量浮点或 SIMD 寄存器，例如 s0', 'Expected a scalar SIMD&FP register, e.g. s0'))
    setEs(s, f, a.es!, LETTERS.indexOf(r.kind))
    unify(s, f, a.field, r.n, L('这两个寄存器必须是同一个', 'These registers must be the same one'))
    s.pos++
  },
  print: (f, a) => `${LETTERS[esOf(f, a.es!) ?? 2]}${f[a.field] ?? 0}`,
  fields: (a) => [a.field, ...esFields(a.es)],
  sample(f, a) {
    const n = f[a.field] ?? SAMPLE[a.field] ?? 0
    f[a.field] = n
    return `${LETTERS[sampleEs(f, a.es!)]}${n}`
  },
  hint: () => L('标量寄存器，例如 s0', 'a scalar register, e.g. s0'),
}

interface RArg {
  field: string
  /** X when this element size is 3 (64-bit), W otherwise; null for always X. */
  es: Es | null
  sp: boolean
}

/** A general register whose width follows an element size (W for b, h, s; X for d). */
const rsized: OperandType<RArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const text = ident(s)
    const r = text ? parseGpr(text) : null
    if (!r) s.fail(L('这里应该是通用寄存器', 'Expected a general register'))
    if (r.sp && !a.sp) s.fail(L('这里不能用 sp', 'sp is not allowed here'))
    if (r.zr && a.sp) s.fail(L('这里不能用零寄存器（编号 31 在这里是 sp）', 'The zero register is not allowed here (number 31 means sp here)'))
    const es = a.es ? esOf(f, a.es) : 3
    if (es !== undefined && r.x !== (es === 3)) s.fail(es === 3 ? L('64 位元素要用 X 寄存器', '64-bit elements take an X register') : L('8、16、32 位元素要用 W 寄存器', '8-, 16- and 32-bit elements take a W register'))
    unify(s, f, a.field, r.n)
    s.pos++
  },
  print: (f, a) => gprName(f[a.field] ?? 0, (a.es ? esOf(f, a.es) : 3) === 3, a.sp),
  fields: (a) => [a.field],
  sample(f, a) {
    const n = f[a.field] ?? 1
    f[a.field] = n
    return gprName(n, (a.es ? sampleEs(f, a.es) : 3) === 3, a.sp)
  },
  hint: () => L('通用寄存器（64 位元素用 X，其余用 W）', 'a general register (X for 64-bit elements, W otherwise)'),
}

/* ------------------------------------------------------------------ lists */

interface ListArg {
  field: string
  count: number
  es: Es
  /** The field holds the first register divided by the count (multi-vector operands). */
  mult: boolean
}

function printList(first: number, count: number, letter: string, kind = 'z'): string {
  const regs = Array.from({ length: count }, (_, i) => `${kind}${(first + i) % (kind === 'p' ? 16 : 32)}.${letter}`)
  if (count > 2 && first + count <= 32) return `{ ${regs[0]} - ${regs[count - 1]} }`
  return `{ ${regs.join(', ')} }`
}

/** Read `{ z0.b, z1.b }` or `{ z0.b - z3.b }`; returns the register numbers and the element size. */
function readList(s: OperandStream, kind: 'z' | 'p'): { regs: number[]; es: number | null } {
  if (!s.eat('{')) s.fail(L('这里应该是寄存器列表，例如 { z0.s }', 'Expected a register list, e.g. { z0.s }'))
  const regs: number[] = []
  let es: number | null | undefined
  const one = () => {
    const text = ident(s)
    const r = text ? parseSveReg(text) : null
    if (!r || r.kind !== kind) s.fail(L(`列表里应该是 ${kind} 寄存器`, `Expected ${kind} registers in the list`))
    if (es !== undefined && r.es !== es) s.fail(L('列表里的元素大小要一致', 'The list must use one element size'), true)
    es = r.es
    s.pos++
    return r.n
  }
  regs.push(one())
  if (s.eat('-')) {
    const last = one()
    const max = kind === 'z' ? 32 : 16
    for (let n = (regs[0]! + 1) % max; regs.length < 5; n = (n + 1) % max) {
      regs.push(n)
      if (n === last) break
    }
  } else while (s.eat(',')) regs.push(one())
  if (!s.eat('}')) s.fail(L('寄存器列表缺少 }', 'The register list is missing }'))
  return { regs, es: es ?? null }
}

const zlist: OperandType<ListArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    const { regs, es } = readList(s, 'z')
    if (regs.length !== a.count) s.fail(L(`这里要 ${a.count} 个寄存器`, `Expected ${a.count} registers here`), true, at)
    for (let i = 1; i < regs.length; i++) if (regs[i] !== (regs[0]! + i) % 32) s.fail(L('列表里的寄存器编号要连续', 'The registers in the list must be consecutive'), true, at)
    if (es === null) s.fail(L('列表里的 z 寄存器要写元素大小', 'Give the z registers in the list an element size'), true, at)
    setEs(s, f, a.es, es)
    let n = regs[0]!
    if (a.mult) {
      if (n % a.count) s.fail(L(`第一个寄存器的编号要是 ${a.count} 的倍数`, `The first register must be a multiple of ${a.count}`), true, at)
      n /= a.count
    }
    if (n >= 1 << s.width(a.field)) s.fail(L('这里不能用这个寄存器', 'This register is not allowed here'), true, at)
    unify(s, f, a.field, n)
  },
  print: (f, a) => printList((f[a.field] ?? 0) * (a.mult ? a.count : 1), a.count, LETTERS[esOf(f, a.es) ?? 2]!),
  fields: (a) => [a.field, ...esFields(a.es)],
  sample(f, a) {
    f[a.field] ??= 0
    return printList(f[a.field]! * (a.mult ? a.count : 1), a.count, LETTERS[sampleEs(f, a.es)]!)
  },
  hint: (a) => L(`${a.count} 个连续的 z 寄存器，例如 ${printList(0, a.count, 's')}`, `${a.count} consecutive z registers, e.g. ${printList(0, a.count, 's')}`),
}

/** A pair of predicates { p2.b, p3.b }: the field holds the first one divided by 2. */
const plist: OperandType<{ field: string; es: Es; any: boolean }> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    const { regs, es } = readList(s, 'p')
    if (regs.length !== 2 || regs[1] !== (regs[0]! + 1) % 16 || (!a.any && regs[0]! % 2))
      s.fail(a.any ? L('这里要两个连续的谓词，例如 { p0.b, p1.b }', 'Expected two consecutive predicates, e.g. { p0.b, p1.b }') : L('这里要两个连续的谓词，第一个是偶数编号，例如 { p0.b, p1.b }', 'Expected two consecutive predicates starting at an even one, e.g. { p0.b, p1.b }'), true, at)
    if (es === null) s.fail(L('谓词要写元素大小', 'Give the predicates an element size'), true, at)
    setEs(s, f, a.es, es)
    unify(s, f, a.field, a.any ? regs[0]! : regs[0]! / 2)
  },
  print: (f, a) => printList((f[a.field] ?? 0) * (a.any ? 1 : 2), 2, LETTERS[esOf(f, a.es) ?? 0]!, 'p'),
  fields: (a) => [a.field, ...esFields(a.es)],
  sample(f, a) {
    f[a.field] ??= 0
    return printList(f[a.field]! * (a.any ? 1 : 2), 2, LETTERS[sampleEs(f, a.es)]!, 'p')
  },
  hint: () => L('两个连续的谓词，例如 { p0.b, p1.b }', 'two consecutive predicates, e.g. { p0.b, p1.b }'),
}

/* ------------------------------------------------------------------ indexed elements */

interface IdxArg {
  field: string
  es: Es
  /** Fields that make the index, most significant first. */
  idx: string[]
}

const idxWidth = (fields: string[], w: (f: string) => number) => fields.reduce((n, x) => n + w(x), 0)

function setIndex(s: OperandStream, f: Fields, fields: string[], v: number): void {
  let rest = v
  for (let i = fields.length - 1; i >= 0; i--) {
    const w = s.width(fields[i]!)
    unify(s, f, fields[i]!, rest & ((1 << w) - 1))
    rest >>= w
  }
}
function getIndex(f: Fields, fields: string[]): number {
  let v = 0
  for (const x of fields) v = (v << width(x)) | (f[x] ?? 0)
  return v
}

function readIndex(s: OperandStream, max: number): number {
  if (!s.eat('[')) s.fail(L('这里要写元素编号，例如 [1]', 'Expected an element index, e.g. [1]'))
  const at = s.pos
  const v = Number(s.expr())
  if (v < 0 || v > max) s.fail(L(`元素编号应在 0 到 ${max} 之间`, `The element index must be 0 to ${max}`), true, at)
  if (!s.eat(']')) s.fail(L('缺少 ]', 'Missing ]'))
  return v
}

/** z2.h[7]: a register in a narrow field and an index in the listed fields. */
const zidx: OperandType<IdxArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    zreg.parse(s, f, { field: a.field, es: a.es })
    setIndex(s, f, a.idx, readIndex(s, (1 << idxWidth(a.idx, (x) => s.width(x))) - 1))
  },
  print: (f, a) => `${zreg.print(f, { field: a.field, es: a.es }, { pc: 0 })}[${getIndex(f, a.idx)}]`,
  fields: (a) => [a.field, ...esFields(a.es), ...a.idx],
  sample: (f, a) => `${zreg.sample(f, { field: a.field, es: a.es })}[1]`,
  hint: () => L('z 寄存器的一个元素，例如 z2.s[1]', 'an element of a z register, e.g. z2.s[1]'),
}

/** DUP (indexed) and DUPQ: z1.b[46], the size the lowest set bit of tsz, the index the bits above it. */
const zdup: OperandType<{ field: string; idx: string[] }> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const es: Es = { k: 'tszlo' }
    zreg.parse(s, f, { field: a.field, es })
    const e = f._es!
    const total = idxWidth(a.idx, (x) => s.width(x))
    if (e + 1 > total) s.fail(L('元素大小不对', 'Wrong element size'))
    const i = readIndex(s, (1 << (total - e - 1)) - 1)
    setIndex(s, f, a.idx, (i << (e + 1)) | (1 << e))
  },
  print(f, a) {
    const v = getIndex(f, a.idx)
    const e = v ? lowBit(v) : 0
    return `z${f[a.field] ?? 0}.${LETTERS[e]}[${v >> (e + 1)}]`
  },
  fields: (a) => [a.field, ...a.idx],
  sample(f, a) {
    f[a.field] ??= 1
    setIndexRaw(f, a.idx, (1 << 3) | (1 << 2))
    return `z${f[a.field]}.s[1]`
  },
  hint: () => L('z 寄存器的一个元素，例如 z1.s[1]', 'an element of a z register, e.g. z1.s[1]'),
}

function setIndexRaw(f: Fields, fields: string[], v: number): void {
  let rest = v
  for (let i = fields.length - 1; i >= 0; i--) {
    const w = width(fields[i]!) || 1
    f[fields[i]!] = rest & ((1 << w) - 1)
    rest >>= w
  }
}

/** pn8[1]: a predicate-as-counter with an index (PEXT). */
const pnidx: OperandType<{ field: string; idx: string }> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    preg.parse(s, f, { field: a.field, es: null, qual: '', counter: true })
    unify(s, f, a.idx, readIndex(s, (1 << s.width(a.idx)) - 1))
  },
  print: (f, a) => `pn${(f[a.field] ?? 0) + 8}[${f[a.idx] ?? 0}]`,
  fields: (a) => [a.field, a.idx],
  sample(f, a) {
    f[a.field] ??= 0
    f[a.idx] ??= 0
    return `pn${f[a.field]! + 8}[0]`
  },
  hint: () => L('计数谓词和编号，例如 pn8[0]', 'a predicate-as-counter and an index, e.g. pn8[0]'),
}

/* ------------------------------------------------------------------ immediates */

const esBits = (f: Fields, e: Es | null) => ESIZE[(e && esOf(f, e)) ?? 3]!

/** Read an immediate's value and wrap it into an element of `bits` (a negative value counts as its two's complement). */
function elementValue(s: OperandStream, bits: number): bigint {
  const at = s.pos
  if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
  const v = s.expr()
  const lo = -(1n << BigInt(bits - 1))
  const hi = (1n << BigInt(bits)) - 1n
  if (v < lo || v > hi) s.fail(L(`立即数 ${v} 超出元素的范围`, `Immediate ${v} does not fit the element`), true, at)
  return v
}

/** An 8-bit immediate, optionally shifted left by 8: #-128 to #127 or #0 to #255, or those times 256. */
const imm8sh: OperandType<{ signed: boolean; es: Es | null }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    const bits = esBits(f, a.es)
    let v = BigInt.asIntN(bits, elementValue(s, bits))
    let shift: number | null = null
    if (s.isPunct(',') && s.word(1) === 'lsl') {
      if (!s.plainStart(at)) s.fail(L('后面跟 lsl 的立即数要以 # 或数字开头', 'An immediate followed by lsl must start with # or a number'), true, at)
      s.pos += 2
      const sh = Number(s.plainAmount())
      if (sh !== 0 && sh !== 8) s.fail(L('这里只能左移 0 或 8 位', 'Only lsl #0 or lsl #8 is allowed here'), true)
      shift = sh / 8
    }
    const fits = (x: bigint) => (a.signed ? x >= -128n && x <= 127n : x >= 0n && x <= 255n)
    // Unsigned forms read the element as unsigned.
    if (!a.signed && v < 0n) v = BigInt.asUintN(bits, v)
    if (a.signed && !fits(v) && v > 0n) v = BigInt.asIntN(bits, v)
    if (shift === null) {
      if (fits(v)) shift = 0
      else if (v % 256n === 0n && fits(v / 256n)) {
        shift = 1
        v /= 256n
      } else s.fail(L(`${v} 不能写成 8 位立即数（或它乘 256）`, `${v} is not an 8-bit immediate (or one times 256)`), true, at)
    } else if (!fits(v)) s.fail(L(`${v} 超出 8 位立即数的范围`, `${v} does not fit 8 bits`), true, at)
    unify(s, f, 'imm8', Number(BigInt.asUintN(8, v)))
    unify(s, f, 'sh', shift!)
  },
  print(f, a) {
    const raw = f.imm8 ?? 0
    if (raw === 0 && f.sh) return '0, lsl #8'
    const v = a.signed ? BigInt.asIntN(8, BigInt(raw)) : BigInt(raw)
    return fmtImm(v << BigInt(8 * (f.sh ?? 0)))
  },
  fields: () => ['imm8', 'sh'],
  sample(f) {
    f.imm8 = 16
    f.sh = 0
    return '16'
  },
  hint: (a) => (a.signed ? L('−128 到 127 的整数（或它乘 256）', 'integer from −128 to 127 (or one times 256)') : L('0 到 255 的整数（或它乘 256）', 'integer from 0 to 255 (or one times 256)')),
}

export const limmValue = (imm13: number) => decodeBitmask(imm13 >> 12, (imm13 >> 6) & 63, imm13 & 63, 64)

/** A logical immediate for the element size of the register before it (AND, ORR, EOR, DUPM). */
const limm: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    const at = s.pos
    const es = f._es ?? 3
    const bits = ESIZE[es]!
    let v = BigInt.asUintN(bits, elementValue(s, bits))
    for (let b = bits; b < 64; b *= 2) v |= v << BigInt(b)
    const enc = encodeBitmask(v, 64)
    if (!enc) s.fail(L(`${fmtImm(BigInt.asUintN(bits, v))} 不能写成逻辑立即数（要是循环移位后的一串连续的 1，按 2、4、8、16、32 或 64 位重复）`, `${fmtImm(BigInt.asUintN(bits, v))} is not a logical immediate (a rotated run of ones, repeated every 2, 4, 8, 16, 32 or 64 bits)`), true, at)
    unify(s, f, 'imm13', (enc.N << 12) | (enc.immr << 6) | enc.imms)
  },
  print(f) {
    const v = limmValue(f.imm13 ?? 0) ?? 0n
    return fmtImm(BigInt.asUintN(ESIZE[limmEs(f.imm13 ?? 0)]!, v))
  },
  fields: () => ['imm13'],
  sample(f) {
    // 0xff in 32-bit elements.
    f.imm13 = 0x007
    f._es = 2
    return '255'
  },
  hint: () => L('逻辑立即数，例如 0xff', 'a logical immediate, e.g. 0xff'),
}

const PATTERNS: Record<number, string> = { 0: 'pow2', 1: 'vl1', 2: 'vl2', 3: 'vl3', 4: 'vl4', 5: 'vl5', 6: 'vl6', 7: 'vl7', 8: 'vl8', 9: 'vl16', 10: 'vl32', 11: 'vl64', 12: 'vl128', 13: 'vl256', 29: 'mul4', 30: 'mul3', 31: 'all' }
const PATTERN_BY_NAME = new Map(Object.entries(PATTERNS).map(([k, v]) => [v, Number(k)]))

/** The predicate pattern of PTRUE and the element counts: pow2, vl1–vl256, mul4, mul3, all, or #0–#31. */
const pattern: OperandType<null> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields) {
    const w = s.word()
    if (w !== null && PATTERN_BY_NAME.has(w)) {
      unify(s, f, 'pattern', PATTERN_BY_NAME.get(w)!)
      s.pos++
      return
    }
    const at = s.pos
    if (!s.isPunct('#') && !s.startsValue()) s.fail(L('这里应该是模式：all、pow2、vl1…vl256、mul4、mul3 或 #0–#31', 'Expected a pattern: all, pow2, vl1…vl256, mul4, mul3 or #0–#31'))
    s.eat('#')
    const v = Number(s.expr())
    if (v < 0 || v > 31) s.fail(L('模式编号应在 0 到 31 之间', 'The pattern number must be 0 to 31'), true, at)
    unify(s, f, 'pattern', v)
  },
  print: (f) => PATTERNS[f.pattern ?? 31] ?? `#${f.pattern}`,
  fields: () => ['pattern'],
  isDefault: (f) => (f.pattern ?? 31) === 31,
  fillDefault(f) {
    f.pattern ??= 31
  },
  sample(f) {
    f.pattern = 31
    return 'all'
  },
  hint: () => L('模式：all、pow2、vl1…vl256、mul4、mul3', 'a pattern: all, pow2, vl1…vl256, mul4, mul3'),
  options: () => Object.values(PATTERNS),
}

const SVE_PRF = ['pldl1keep', 'pldl1strm', 'pldl2keep', 'pldl2strm', 'pldl3keep', 'pldl3strm', '', '', 'pstl1keep', 'pstl1strm', 'pstl2keep', 'pstl2strm', 'pstl3keep', 'pstl3strm', '', '']

/** The prefetch operation of the SVE PRF instructions (4 bits). */
const sveprf: OperandType<null> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields) {
    const w = s.word()
    const i = w ? SVE_PRF.indexOf(w) : -1
    if (w && i >= 0) {
      unify(s, f, 'prfop', i)
      s.pos++
      return
    }
    const at = s.pos
    if (!s.isPunct('#') && !s.startsValue()) s.fail(L('这里应该是预取操作，例如 pldl1keep', 'Expected a prefetch operation, e.g. pldl1keep'))
    s.numberHash()
    const v = Number(s.expr())
    if (v < 0 || v > 15) s.fail(L('预取操作编号应在 0 到 15 之间', 'The prefetch operation must be 0 to 15'), true, at)
    unify(s, f, 'prfop', v)
  },
  print: (f) => SVE_PRF[f.prfop ?? 0] || `#${f.prfop}`,
  fields: () => ['prfop'],
  sample(f) {
    f.prfop = 0
    return 'pldl1keep'
  },
  hint: () => L('预取操作，例如 pldl1keep', 'a prefetch operation, e.g. pldl1keep'),
  options: () => SVE_PRF.filter(Boolean),
}

/** uxtw or sxtw, in the field xs. */
const xs: OperandType<{ field: string }> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields, a) {
    const w = s.word()
    if (w !== 'uxtw' && w !== 'sxtw') s.fail(L('这里应该是 uxtw 或 sxtw', 'Expected uxtw or sxtw'))
    unify(s, f, a.field, w === 'sxtw' ? 1 : 0)
    s.pos++
  },
  print: (f, a) => (f[a.field] ? 'sxtw' : 'uxtw'),
  fields: (a) => [a.field],
  sample(f, a) {
    f[a.field] = 0
    return 'uxtw'
  },
  hint: () => 'uxtw | sxtw',
  options: () => ['uxtw', 'sxtw'],
}

/** One of two floating-point values chosen by a one-bit field (#0.5 or #1.0 for FADD, …). */
const fimm1: OperandType<{ field: string; values: [string, string] }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    const v = readFloat(s)
    // Object.is: -0.0 is not 0.0 here.
    const i = a.values.findIndex((x) => Object.is(Number(x), v))
    if (i < 0) s.fail(L(`这里只能是 #${a.values[0]} 或 #${a.values[1]}`, `Only #${a.values[0]} or #${a.values[1]} is allowed here`), v !== null, at)
    unify(s, f, a.field, i)
  },
  print: (f, a) => a.values[f[a.field] ?? 0]!,
  fields: (a) => [a.field],
  sample(f, a) {
    f[a.field] = 1
    return a.values[1]
  },
  hint: (a) => `${a.values[0]} | ${a.values[1]}`,
  options: (_f, a) => a.values.map((v) => '#' + v),
}

/** Shift amounts held as tszh:tszl:imm3 with the element size in tsz: right 1–esize, left 0–(esize − 1). */
const tshift: OperandType<{ right: boolean }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    if (!s.startsValue()) s.fail(L('这里应该是移位量', 'Expected a shift amount'))
    const v = Number(s.expr())
    const es = f._es ?? 0
    const esize = ESIZE[es]!
    const [lo, hi] = a.right ? [1, esize] : [0, esize - 1]
    if (v < lo || v > hi) s.fail(L(`移位量应在 ${lo} 到 ${hi} 之间`, `The shift must be ${lo} to ${hi}`), true, at)
    const total = a.right ? 2 * esize - v : esize + v
    const tsz = total >> 3
    unify(s, f, 'imm3', total & 7)
    if ('tszh' in s.widths) {
      const wl = s.width('tszl')
      unify(s, f, 'tszl', tsz & ((1 << wl) - 1))
      unify(s, f, 'tszh', tsz >> wl)
    } else unify(s, f, 'tsz', tsz)
  },
  print(f, a) {
    const tsz = tszOf(f) ?? 1
    const total = (tsz << 3) | (f.imm3 ?? 0)
    const esize = ESIZE[highBit(tsz || 1)]!
    return String(a.right ? 2 * esize - total : total - esize)
  },
  fields: () => ['tszh', 'tszl', 'imm3'],
  sample(f, a) {
    const es = f._es ?? 2
    const esize = ESIZE[es]!
    const total = a.right ? 2 * esize - 1 : esize + 1
    f.imm3 = total & 7
    const tsz = total >> 3
    const wl = width('tszl') || 2
    f.tszl = tsz & ((1 << wl) - 1)
    f.tszh = tsz >> wl
    return '1'
  },
  hint: (a) => (a.right ? L('右移位数：1 到元素位数', 'right shift: 1 to the element size') : L('左移位数：0 到元素位数 − 1', 'left shift: 0 to the element size − 1')),
}

/** vlx2 or vlx4 (the vector count of predicate-as-counter operations), in the field vl. */
const vlx: OperandType<null> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields) {
    const w = s.word()
    if (w !== 'vlx2' && w !== 'vlx4') s.fail(L('这里应该是 vlx2 或 vlx4', 'Expected vlx2 or vlx4'))
    unify(s, f, 'vl', w === 'vlx4' ? 1 : 0)
    s.pos++
  },
  print: (f) => (f.vl ? 'vlx4' : 'vlx2'),
  fields: () => ['vl'],
  sample(f) {
    f.vl = 0
    return 'vlx2'
  },
  hint: () => 'vlx2 | vlx4',
  options: () => ['vlx2', 'vlx4'],
}

/** An index register w12–w15 held in a 2-bit field (PSEL; SME's ZA slices). */
const wv: OperandType<{ field: string }> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const text = ident(s)
    const r = text ? parseGpr(text) : null
    if (!r || r.x || r.sp || r.zr || r.n < 12 || r.n > 15) s.fail(L('这里只能用 w12 到 w15', 'Only w12 to w15 are allowed here'))
    unify(s, f, a.field, r.n - 12)
    s.pos++
  },
  print: (f, a) => `w${12 + (f[a.field] ?? 0)}`,
  fields: (a) => [a.field],
  sample(f, a) {
    f[a.field] ??= 1
    return `w${12 + f[a.field]!}`
  },
  hint: () => L('索引寄存器 w12 到 w15', 'an index register, w12 to w15'),
  options: () => ['w12', 'w13', 'w14', 'w15'],
}

/**
 * An immediate spread over several fields, most significant first (EXT's imm8h:imm8l); signed for LDR and
 * STR's imm9h:imm9l, where a zero can be left out.
 */
const split: OperandType<{ fields: string[]; signed: boolean }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const v = Number(s.expr())
    const w = idxWidth(a.fields, (x) => s.width(x))
    const [lo, hi] = a.signed ? [-(2 ** (w - 1)), 2 ** (w - 1) - 1] : [0, 2 ** w - 1]
    if (v < lo || v > hi) s.fail(L(`立即数应在 ${lo} 到 ${hi} 之间`, `The immediate must be ${lo} to ${hi}`), true, at)
    setIndex(s, f, a.fields, v & (2 ** w - 1))
  },
  print(f, a) {
    const v = getIndex(f, a.fields)
    const w = idxWidth(a.fields, width)
    return String(a.signed && v >= 2 ** (w - 1) ? v - 2 ** w : v)
  },
  fields: (a) => a.fields,
  isDefault: (f, a) => a.signed && getIndex(f, a.fields) === 0,
  sample(f, a) {
    setIndexRaw(f, a.fields, 1)
    return '1'
  },
  hint: (a) => (a.signed ? L('有符号立即数', 'a signed immediate') : L('无符号立即数', 'an unsigned immediate')),
}

/* ------------------------------------------------------------------ resolver */

export function resolveSve(name: string): OpSpec | null {
  let m = /^(Z\w*)(?:\.([\w+-]+))?$/.exec(name)
  if (m) return { type: zreg, arg: { field: m[1]!, es: m[2] ? parseEs(m[2]) : null }, name }
  m = /^(Z\w*)\.tszlo\[(\w+(?:\+\w+)*)\]$/.exec(name)
  if (m) return { type: zdup, arg: { field: m[1]!, idx: m[2]!.split('+') }, name }
  m = /^(Z\w*)\.([\w+-]+)\[(\w+(?:\+\w+)*)\]$/.exec(name)
  if (m) return { type: zidx, arg: { field: m[1]!, es: parseEs(m[2]!), idx: m[3]!.split('+') }, name }
  m = /^(PN\w*)\[(\w+)\]$/.exec(name)
  if (m) return { type: pnidx, arg: { field: m[1]!, idx: m[2]! }, name }
  m = /^(PN?)(\w*?)(?:\.([\w+-]+))?(?:\/([mzM]))?$/.exec(name)
  if (m && m[2]) return { type: preg, arg: { field: m[1] === 'PN' ? 'PN' + m[2] : 'P' + m[2], es: m[3] ? parseEs(m[3]) : null, qual: (m[4] ?? '') as PArg['qual'], counter: m[1] === 'PN' }, name }
  m = /^(V\w+)\.([\w+-]+)$/.exec(name)
  if (m) return { type: vscalar, arg: { field: m[1]!, es: parseEs(m[2]!) }, name }
  m = /^R(\w+?)(\|SP)?:([\w+-]+)$/.exec(name)
  if (m) return { type: rsized, arg: { field: 'R' + m[1], es: parseEs(m[3]!), sp: !!m[2] }, name }
  m = /^L(M)?:(Z\w*):(\d):([\w+-]+)$/.exec(name)
  if (m) return { type: zlist, arg: { field: m[2]!, count: Number(m[3]), es: parseEs(m[4]!), mult: !!m[1] }, name }
  m = /^PL(A)?:(P\w*):([\w+-]+)$/.exec(name)
  if (m) return { type: plist, arg: { field: m[2]!, es: parseEs(m[3]!), any: !!m[1] }, name }
  m = /^imm8sh:(s|u)(?::([\w+-]+))?$/.exec(name)
  if (m) return { type: imm8sh, arg: { signed: m[1] === 's', es: m[2] ? parseEs(m[2]) : null }, name }
  m = /^fimm1:([\d.]+):([\d.]+)(?::(\w+))?$/.exec(name)
  if (m) return { type: fimm1, arg: { field: m[3] ?? 'i1', values: [m[1]!, m[2]!] }, name }
  m = /^(s?)split:(\w+(?:\+\w+)+)$/.exec(name)
  if (m) return { type: split, arg: { fields: m[2]!.split('+'), signed: m[1] === 's' }, name }
  m = /^W(v\w*)$/.exec(name)
  if (m) return { type: wv, arg: { field: 'R' + m[1] }, name }
  m = /^xs(?::(\w+))?$/.exec(name)
  if (m) return { type: xs, arg: { field: m[1] ?? 'xs' }, name }
  switch (name) {
    case 'limm':
      return { type: limm, arg: null, name }
    case 'pattern':
      return { type: pattern, arg: null, name }
    case 'sveprf':
      return { type: sveprf, arg: null, name }
    case 'tsr':
      return { type: tshift, arg: { right: true }, name }
    case 'tsl':
      return { type: tshift, arg: { right: false }, name }
    case 'vlx':
      return { type: vlx, arg: null, name }
  }
  return null
}
