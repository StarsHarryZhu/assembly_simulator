/**
 * Operand types of the SIMD&FP instructions, resolved from template placeholders (see resolveSimd):
 *
 *   <Sd> <Dn> <Qt> …            a scalar register of a fixed size (b h s d q)
 *   <Ed:size> <En:size+1>        a scalar register whose size is a field (+ an offset); `ftype` and `immh` too
 *   <Vd:size:Q> <Vn:sz+2:1>      a vector register: element size, then Q (a field or a fixed 0/1), or
 *                                Qh / h for the 32-bit arrangements (v1.2h) of FMLAL and FP16 pairwise adds
 *   <rot:rot> <crot:rot>         complex rotations: #0 #90 #180 #270 (FCMLA), #90 #270 (FCADD)
 *   <E@name>                     a vector element (v2.s[1]) with one of the index layouts below
 *   <X:n:s:idx+idx2>             a vector element of a fixed size whose index sits in the listed fields
 *   <L:Rt:2:size:Q>              a register list of 2 consecutive registers, { v0.4s, v1.4s }
 *   <LI:Rt:2:s>                  a list of elements for single-structure loads, { v0.s, v1.s }[1]
 *   <post:2:mult> …              the immediate post-increment of a structure load, which must be its size
 *   <fimm8> <fimmv> <fzero>      floating-point immediates (8-bit encoded, vector form, the literal 0.0)
 *   <vshr> <vshl>                vector and scalar shift amounts in immh:immb
 *   <rsh:8>                      a right shift of 1 to 8 (or fraction bits), kept as 8 − shift in `sh`
 *   <shll>                       SHLL's shift, which is always the element size
 *   <mimm8> <mimm64> <mlsl> <msl> the modified immediates of MOVI, MVNI, ORR and BIC
 *
 * Element sizes are numbered 0–4 for b, h, s, d, q. Where the element size sits in a field that also holds
 * something else (immh of the shifts, imm5 of the copies), parsing records it in the pseudo field `_es`,
 * which no pattern has, for the operands after it.
 */
import { L } from '../../../core/i18n'
import { parseVreg } from '../registers'
import { printWidths } from './operands'
import { fmtImm, unify, type Fields, type OperandStream, type OperandType, type OpSpec } from './syntax'

const LETTERS = 'bhsdq'
const ES_BITS = [8, 16, 32, 64, 128]

/* ------------------------------------------------------------------ element sizes */

type EsSpec = { kind: 'field'; field: string; add: number } | { kind: 'fixed'; es: number } | { kind: 'immh'; add: number } | { kind: 'imm5' } | { kind: 'ftype'; field: string }

function parseEsSpec(text: string): EsSpec {
  const m = /^([A-Za-z0-9_]+?)([+-]\d)?$/.exec(text)
  if (!m) throw new Error(`bad element size ${text}`)
  const word = m[1]!
  const add = m[2] ? Number(m[2]) : 0
  if (word.length === 1 && LETTERS.includes(word)) return { kind: 'fixed', es: LETTERS.indexOf(word) + add }
  if (word === 'immh') return { kind: 'immh', add }
  if (word === 'imm5') return { kind: 'imm5' }
  // The FP type encoding (0 s, 1 d, 3 h) in ftype, or in opc for FCVT's destination.
  if (word === 'ftype') return { kind: 'ftype', field: 'ftype' }
  if (word === 'fopc') return { kind: 'ftype', field: 'opc' }
  return { kind: 'field', field: word, add }
}

const FTYPE_ES: Record<number, number> = { 0: 2, 1: 3, 3: 1 }
const ES_FTYPE: Record<number, number> = { 2: 0, 3: 1, 1: 3 }

/** Index of the highest set bit (immh: 1 → b, 2–3 → h, 4–7 → s, 8–15 → d). */
export const highBit = (v: number) => 31 - Math.clz32(v)
/** Index of the lowest set bit. */
export const lowBit = (v: number) => 31 - Math.clz32(v & -v)

/** The element size an operand has with these fields, or undefined when not known yet. */
export function esOf(f: Fields, spec: EsSpec): number | undefined {
  switch (spec.kind) {
    case 'fixed':
      return spec.es
    case 'field':
      return f[spec.field] === undefined ? undefined : f[spec.field]! + spec.add
    case 'immh': {
      const base = f.immh ? highBit(f.immh) : f._es
      return base === undefined ? undefined : base + spec.add
    }
    case 'imm5':
      return f.imm5 && f.imm5 & 15 ? lowBit(f.imm5) : f._es
    case 'ftype':
      return f[spec.field] === undefined ? undefined : FTYPE_ES[f[spec.field]!]
  }
}

function setEs(s: OperandStream, f: Fields, spec: EsSpec, es: number): void {
  const bad = () => s.fail(L('元素大小不对', 'Wrong element size'))
  switch (spec.kind) {
    case 'fixed':
      if (es !== spec.es) bad()
      return
    case 'field': {
      const v = es - spec.add
      if (v < 0 || v >= 1 << s.width(spec.field)) bad()
      unify(s, f, spec.field, v, L('元素大小不一致', 'The element sizes do not match'))
      return
    }
    case 'immh':
      if (es - spec.add < 0 || es - spec.add > 3) bad()
      unify(s, f, '_es', es - spec.add, L('元素大小不一致', 'The element sizes do not match'))
      return
    case 'imm5':
      if (es > 3) bad()
      unify(s, f, '_es', es, L('元素大小不一致', 'The element sizes do not match'))
      return
    case 'ftype':
      if (ES_FTYPE[es] === undefined || ES_FTYPE[es]! >= 1 << s.width(spec.field)) bad()
      unify(s, f, spec.field, ES_FTYPE[es]!, L('浮点寄存器的大小不一致', 'The floating-point register sizes do not match'))
  }
}

/** A default element size for samples: s (32-bit) where the field allows it. */
function sampleEs(f: Fields, spec: EsSpec): number {
  const known = esOf(f, spec)
  if (known !== undefined) return known
  if (spec.kind === 'field') {
    const es = Math.max(spec.add, 2)
    f[spec.field] = es - spec.add
    return es
  }
  if (spec.kind === 'ftype') {
    f[spec.field] = spec.field === 'opc' ? 0 : 1
    return spec.field === 'opc' ? 2 : 3
  }
  f._es = 2
  return spec.kind === 'immh' ? 2 + spec.add : 2
}

/**
 * The width of a vector operand: Q (the field: 64 or 128 bits), fixed 0 or 1, or the narrow forms of
 * FMLAL and the FP16 pairwise adds: Qh (the field Q picks 32 or 64 bits) and h (32 bits, as in v1.2h).
 */
type QSpec = 'Q' | 'Qh' | 'h' | number
const bitsOf = (f: Fields, q: QSpec) => (q === 'h' ? 32 : q === 'Qh' ? ((f.Q ?? 1) ? 64 : 32) : (typeof q === 'number' ? q : (f.Q ?? 1)) ? 128 : 64)
const qField = (q: QSpec | null) => (q === 'Q' || q === 'Qh' ? ['Q'] : [])
const parseQ = (text: string): QSpec => (text === '0' || text === '1' ? Number(text) : (text as QSpec))
const arrName = (es: number, bits: number) => `${bits / ES_BITS[es]!}${LETTERS[es]}`

const SAMPLE_REG: Record<string, number> = { Rd: 0, Rn: 1, Rm: 2, Ra: 3, Rt: 0, Rt2: 1 }

function vtok(s: OperandStream) {
  const t = s.peek()
  return t && t.kind === 'ident' ? parseVreg(t.text) : null
}

/* ------------------------------------------------------------------ scalar registers */

interface SArg {
  field: string
  es: EsSpec
}

const scalarHint = (a: SArg) =>
  a.es.kind === 'fixed' ? L(`${LETTERS[a.es.es]} 寄存器 ${LETTERS[a.es.es]}0–${LETTERS[a.es.es]}31`, `${LETTERS[a.es.es]} register ${LETTERS[a.es.es]}0–${LETTERS[a.es.es]}31`) : L('标量寄存器，例如 s0、d1', 'scalar register, e.g. s0, d1')

const sreg: OperandType<SArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const r = vtok(s)
    if (!r || r.kind === 'v') s.fail(L(`这里应该是${scalarHint(a)}`, `Expected a ${scalarHint(a)}`))
    setEs(s, f, a.es, LETTERS.indexOf(r.kind))
    unify(s, f, a.field, r.n)
    s.pos++
  },
  print: (f, a) => `${LETTERS[esOf(f, a.es) ?? 2]}${f[a.field]}`,
  fields: (a) => (a.es.kind === 'field' || a.es.kind === 'ftype' ? [a.field, a.es.field] : a.es.kind === 'immh' ? [a.field, 'immh'] : [a.field]),
  sample(f, a) {
    const es = sampleEs(f, a.es)
    const n = f[a.field] ?? SAMPLE_REG[a.field] ?? 0
    f[a.field] = n
    return `${LETTERS[es]}${n}`
  },
  hint: (a) => scalarHint(a),
  options: (f, a) => Array.from({ length: 32 }, (_, i) => `${LETTERS[esOf(f, a.es) ?? 2]}${i}`),
}

/* ------------------------------------------------------------------ vector registers */

interface VArg {
  field: string
  es: EsSpec
  q: QSpec
}

const vecHint = () => L('向量寄存器，例如 v0.4s、v1.16b', 'vector register, e.g. v0.4s, v1.16b')

/** Read an arrangement such as 4s into element size and width in bits, or fail. */
function arrangement(s: OperandStream, arr: string): [number, number] {
  const m = /^(\d+)([bhsdq])$/.exec(arr)
  const es = m ? LETTERS.indexOf(m[2]!) : -1
  const bits = m ? Number(m[1]) * ES_BITS[es]! : 0
  if (bits !== 32 && bits !== 64 && bits !== 128) s.fail(L(`"${arr}" 不是向量的排列方式（应是 8b 16b 4h 8h 2s 4s 1d 2d 这样的）`, `"${arr}" is not an arrangement (expected 8b 16b 4h 8h 2s 4s 1d 2d and so on)`))
  return [es, bits]
}

function setQ(s: OperandStream, f: Fields, q: QSpec, bits: number): void {
  const want = (lo: number) => (lo === 32 ? L('这里要 32 或 64 位的排列（如 2h、4h）', 'A 32- or 64-bit arrangement is needed here (such as 2h, 4h)') : L('这里要 64 或 128 位的排列（如 2s、4s）', 'A 64- or 128-bit arrangement is needed here (such as 2s, 4s)'))
  if (q === 'h') {
    if (bits !== 32) s.fail(L('这里要 32 位的排列（如 2h）', 'A 32-bit arrangement is needed here (such as 2h)'))
  } else if (q === 'Qh') {
    if (bits !== 32 && bits !== 64) s.fail(want(32))
    unify(s, f, 'Q', bits === 64 ? 1 : 0, L('向量的宽度不一致', 'The vector widths do not match'))
  } else if (typeof q === 'number') {
    if ((q ? 128 : 64) !== bits) s.fail(q ? L('这里要 128 位的排列（如 4s、16b）', 'A 128-bit arrangement is needed here (such as 4s, 16b)') : L('这里要 64 位的排列（如 2s、8b）', 'A 64-bit arrangement is needed here (such as 2s, 8b)'))
  } else {
    if (bits !== 64 && bits !== 128) s.fail(want(64))
    unify(s, f, 'Q', bits === 128 ? 1 : 0, L('向量的宽度不一致', 'The vector widths do not match'))
  }
}

const vreg: OperandType<VArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const r = vtok(s)
    if (!r || r.kind !== 'v' || !/^\d/.test(r.arr)) s.fail(L(`这里应该是${vecHint()}`, `Expected a ${vecHint()}`))
    const [es, bits] = arrangement(s, r.arr)
    setEs(s, f, a.es, es)
    setQ(s, f, a.q, bits)
    unify(s, f, a.field, r.n)
    s.pos++
  },
  print: (f, a) => `v${f[a.field]}.${arrName(esOf(f, a.es) ?? 2, bitsOf(f, a.q))}`,
  fields: (a) => [a.field, ...(a.es.kind === 'field' ? [a.es.field] : a.es.kind === 'immh' ? ['immh'] : a.es.kind === 'imm5' ? ['imm5'] : []), ...qField(a.q)],
  sample(f, a) {
    const es = sampleEs(f, a.es)
    if (qField(a.q).length) f.Q ??= 1
    const n = f[a.field] ?? SAMPLE_REG[a.field] ?? 0
    f[a.field] = n
    return `v${n}.${arrName(es, bitsOf(f, a.q))}`
  },
  hint: () => vecHint(),
  options: (f, a) => Array.from({ length: 32 }, (_, i) => `v${i}.${arrName(esOf(f, a.es) ?? 2, bitsOf(f, a.q))}`),
}

/* ------------------------------------------------------------------ elements */

/** Where an element operand keeps its register number and index, by element size (MSB-first field lists). */
type Layout = (es: number) => { reg: string[]; idx: string[]; zero?: string[] } | null

interface EArg {
  es: EsSpec
  /** The element type as written when it is not just the size letter (dot products: 4b, 2h). */
  label: string | null
  layout: Layout
}

function putBits(s: OperandStream, f: Fields, names: string[], value: number, what: () => string): void {
  let rest = value
  for (let i = names.length - 1; i >= 0; i--) {
    const w = s.width(names[i]!)
    unify(s, f, names[i]!, rest & ((1 << w) - 1))
    rest >>>= w
  }
  if (rest) s.fail(what(), true)
}

function getBits(f: Fields, names: string[], widths: Record<string, number>): number {
  let v = 0
  for (const n of names) v = (v << (widths[n] ?? 1)) | (f[n] ?? 0)
  return v
}

function elementToken(s: OperandStream, label: string | null): { n: number; es: number; index: number } {
  const r = vtok(s)
  const want = label ?? null
  if (!r || r.kind !== 'v' || !(want ? r.arr === want : /^[bhsdq]$/.test(r.arr))) s.fail(L(`这里应该是向量元素，例如 v1.${want ?? 's'}[0]`, `Expected a vector element, e.g. v1.${want ?? 's'}[0]`))
  const es = LETTERS.indexOf(r.arr.slice(-1))
  s.pos++
  if (!s.eat('[')) s.fail(L('元素要写下标，例如 v1.s[0]', 'An element needs an index, e.g. v1.s[0]'))
  const t = s.peek()
  if (!t || t.kind !== 'num') s.fail(L('下标应该是数字', 'The index must be a number'))
  const index = Number(t.value)
  s.pos++
  if (!s.eat(']')) s.fail(L('缺少 "]"', 'Missing "]"'))
  return { n: r.n, es, index }
}

const elem: OperandType<EArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const { n, es, index } = elementToken(s, a.label)
    setEs(s, f, a.es, es)
    const lay = a.layout(es)
    if (!lay) s.fail(L('这种元素大小不能按下标取', 'Elements of this size cannot be indexed here'))
    putBits(s, f, lay.reg, n, () => L(`这里只能用 v0–v${(1 << lay.reg.reduce((w, x) => w + s.width(x), 0)) - 1}`, `Only v0–v${(1 << lay.reg.reduce((w, x) => w + s.width(x), 0)) - 1} are allowed here`))
    const max = (1 << lay.idx.reduce((w, x) => w + s.width(x), 0)) - 1
    if (index > max) s.fail(L(`下标超出范围：应在 0 到 ${max} 之间`, `Index out of range: expected 0 to ${max}`), true)
    putBits(s, f, lay.idx, index, () => '')
    for (const z of lay.zero ?? []) unify(s, f, z, 0)
  },
  print(f, a) {
    const es = esOf(f, a.es) ?? 2
    const lay = a.layout(es)!
    const w = printWidths.current
    return `v${getBits(f, lay.reg, w)}.${a.label ?? LETTERS[es]}[${getBits(f, lay.idx, w)}]`
  },
  fields: (a) => {
    const lay = [2, 1, 0, 3].map((es) => a.layout(es)).find((x) => x)!
    return [...lay.reg, ...lay.idx]
  },
  sample(f, a) {
    const es = sampleEs(f, a.es)
    const lay = a.layout(es) ?? { reg: ['Rm'], idx: [] }
    for (const n of [...lay.reg, ...lay.idx, ...(lay.zero ?? [])]) f[n] ??= 0
    f[lay.reg[lay.reg.length - 1]!] = 2
    return `v2.${a.label ?? LETTERS[es]}[0]`
  },
  hint: (a) => L(`向量元素，例如 v2.${a.label ?? 's'}[1]`, `vector element, e.g. v2.${a.label ?? 's'}[1]`),
}

/** DUP, INS, UMOV, SMOV: the element size and index together in imm5 (or the source index in imm4). */
interface E5Arg {
  field: string
  src: boolean
}
const elem5: OperandType<E5Arg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const { n, es, index } = elementToken(s, null)
    if (es > 3) s.fail(L('元素大小应是 b、h、s 或 d', 'The element size must be b, h, s or d'))
    unify(s, f, '_es', es, L('元素大小不一致', 'The element sizes do not match'))
    const max = (16 >> es) - 1
    if (index > max) s.fail(L(`下标超出范围：应在 0 到 ${max} 之间`, `Index out of range: expected 0 to ${max}`), true)
    if (a.src) unify(s, f, 'imm4', index << es)
    else unify(s, f, 'imm5', ((index << (es + 1)) | (1 << es)) & 31)
    unify(s, f, a.field, n)
  },
  print(f, a) {
    const es = lowBit(f.imm5!)
    const index = a.src ? f.imm4! >> es : f.imm5! >> (es + 1)
    return `v${f[a.field]}.${LETTERS[es]}[${index}]`
  },
  fields: (a) => [a.field, a.src ? 'imm4' : 'imm5'],
  sample(f, a) {
    f.imm5 ??= 0b00100
    if (a.src) f.imm4 ??= 0
    f[a.field] ??= SAMPLE_REG[a.field] ?? 1
    return elem5.print(f, a, { pc: 0 })
  },
  hint: () => L('向量元素，例如 v1.s[2]', 'vector element, e.g. v1.s[2]'),
}

/** An element of a fixed size (per-size encodings of the copies): register field and index fields. */
interface XArg {
  field: string
  es: number
  idx: string[]
}
const xelem: OperandType<XArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const { n, es, index } = elementToken(s, null)
    if (es !== a.es) s.fail(L(`这里的元素应是 .${LETTERS[a.es]}`, `The element here must be .${LETTERS[a.es]}`))
    const max = (1 << a.idx.reduce((w, x) => w + s.width(x), 0)) - 1
    if (index > max) s.fail(L(`下标超出范围：应在 0 到 ${max} 之间`, `Index out of range: expected 0 to ${max}`), true)
    putBits(s, f, a.idx, index, () => '')
    unify(s, f, a.field, n)
  },
  print: (f, a) => `v${f[a.field]}.${LETTERS[a.es]}[${getBits(f, a.idx, printWidths.current)}]`,
  fields: (a) => [a.field, ...a.idx],
  sample(f, a) {
    for (const n of a.idx) f[n] ??= 1
    f[a.field] ??= SAMPLE_REG[a.field] ?? 1
    return `v${f[a.field]}.${LETTERS[a.es]}[${getBits(f, a.idx, printWidths.current)}]`
  },
  hint: (a) => L(`向量元素，例如 v1.${LETTERS[a.es]}[1]`, `vector element, e.g. v1.${LETTERS[a.es]}[1]`),
}

/* ------------------------------------------------------------------ register lists */

interface ListArg {
  field: string
  count: number
  es: EsSpec
  /** Q for whole-vector lists; null for element lists of single-structure loads. */
  q: QSpec | null
}

function parseList(s: OperandStream, count: number): { first: number; arr: string } {
  if (!s.eat('{')) s.fail(L('这里应该是寄存器列表，例如 { v0.4s, v1.4s }', 'Expected a register list, e.g. { v0.4s, v1.4s }'))
  const regs: { n: number; arr: string }[] = []
  for (;;) {
    const r = vtok(s)
    if (!r || r.kind !== 'v' || !r.arr) s.fail(L('列表里应该是向量寄存器，例如 v0.4s', 'A list holds vector registers, e.g. v0.4s'))
    regs.push({ n: r.n, arr: r.arr })
    s.pos++
    if (s.eat('-')) {
      const e = vtok(s)
      if (!e || e.kind !== 'v' || e.arr !== r.arr) s.fail(L('范围两端的排列要一样，例如 { v0.4s-v3.4s }', 'Both ends of a range need the same arrangement, e.g. { v0.4s-v3.4s }'))
      s.pos++
      for (let n = (r.n + 1) % 32; regs.length < 5; n = (n + 1) % 32) {
        regs.push({ n, arr: r.arr })
        if (n === e.n) break
      }
    }
    if (s.eat('}')) break
    if (!s.eat(',')) s.fail(L('缺少 "}"', 'Missing "}"'))
  }
  if (regs.length !== count) s.fail(L(`这里的列表要有 ${count} 个寄存器`, `This list needs ${count} registers`))
  for (let i = 1; i < regs.length; i++) {
    if (regs[i]!.arr !== regs[0]!.arr) s.fail(L('列表里的排列要一样', 'All registers in a list need the same arrangement'), true)
    if (regs[i]!.n !== (regs[0]!.n + i) % 32) s.fail(L('列表里的寄存器要连续编号，例如 { v4.4s, v5.4s }', 'A list needs consecutive registers, e.g. { v4.4s, v5.4s }'), true)
  }
  return { first: regs[0]!.n, arr: regs[0]!.arr }
}

const printList = (first: number, count: number, suffix: string) =>
  `{ ${Array.from({ length: count }, (_, i) => `v${(first + i) % 32}.${suffix}`).join(', ')} }`

const vlist: OperandType<ListArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const { first, arr } = parseList(s, a.count)
    if (a.q === null) {
      if (!/^[bhsdq]$/.test(arr)) s.fail(L('这里列表里写元素大小，例如 { v0.s, v1.s }[1]', 'This list names element sizes, e.g. { v0.s, v1.s }[1]'))
      setEs(s, f, a.es, LETTERS.indexOf(arr))
    } else {
      const [es, bits] = arrangement(s, arr)
      setEs(s, f, a.es, es)
      setQ(s, f, a.q, bits)
    }
    unify(s, f, a.field, first)
  },
  print(f, a) {
    const es = esOf(f, a.es) ?? 2
    return printList(f[a.field]!, a.count, a.q === null ? LETTERS[es]! : arrName(es, bitsOf(f, a.q)))
  },
  fields: (a) => [a.field, ...(a.es.kind === 'field' ? [a.es.field] : []), ...qField(a.q)],
  sample(f, a) {
    const es = sampleEs(f, a.es)
    if (qField(a.q).length) f.Q ??= 1
    f[a.field] ??= 0
    return printList(f[a.field]!, a.count, a.q === null ? LETTERS[es]! : arrName(es, bitsOf(f, a.q)))
  },
  hint: (a) => L(`${a.count} 个连续的向量寄存器，例如 ${printList(0, a.count, a.q === null ? 's' : '4s')}`, `${a.count} consecutive vector registers, e.g. ${printList(0, a.count, a.q === null ? 's' : '4s')}`),
}

/** The lane index of a single-structure load or store, in Q:S:size by element size. */
const LANE_BITS: Record<number, string[]> = { 0: ['Q', 'S', 'size'], 1: ['Q', 'S', 'size1'], 2: ['Q', 'S'], 3: ['Q'] }

const laneIndex: OperandType<{ es: number }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    const t = s.peek()
    if (!t || t.kind !== 'num') s.fail(L('下标应该是数字', 'The index must be a number'))
    const max = (16 >> a.es) - 1
    const v = Number(t.value)
    if (v > max) s.fail(L(`下标超出范围：应在 0 到 ${max} 之间`, `Index out of range: expected 0 to ${max}`), true)
    putBits(s, f, LANE_BITS[a.es]!, v, () => '')
    s.pos++
  },
  print: (f, a) => String(getBits(f, LANE_BITS[a.es]!, printWidths.current)),
  fields: (a) => LANE_BITS[a.es]!,
  sample(f, a) {
    for (const n of LANE_BITS[a.es]!) f[n] ??= 0
    return '0'
  },
  hint: (a) => L(`下标 0 到 ${(16 >> a.es) - 1}`, `index 0 to ${(16 >> a.es) - 1}`),
}

/* ------------------------------------------------------------------ post-increment */

interface PostArg {
  count: number
  /** mult: whole registers (Q); one: one element of `es`; rep: one element of `size`. */
  mode: 'mult' | 'one' | 'rep'
  es: number
}
const postBytes = (f: Fields, a: PostArg) => a.count * (a.mode === 'mult' ? (f.Q ? 16 : 8) : a.mode === 'one' ? 1 << a.es : 1 << (f.size ?? 0))
const post: OperandType<PostArg> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    const v = s.expr()
    const want = postBytes(f, a)
    if (v !== BigInt(want)) s.fail(L(`后增量只能是传输的字节数 #${want}（或者写寄存器）`, `The post-increment can only be the transfer size #${want} (or a register)`), true, at)
  },
  print: (f, a) => String(postBytes(f, a)),
  fields: () => [],
  sample: (f, a) => String(postBytes(f, a)),
  hint: () => L('传输的字节数', 'the transfer size in bytes'),
}

/* ------------------------------------------------------------------ floating-point immediates */

/** VFPExpandImm: the value an 8-bit FP immediate stands for. */
export function fpImm8(imm8: number): number {
  const sign = imm8 & 0x80 ? -1 : 1
  const b = (imm8 >> 6) & 1
  const cd = (imm8 >> 4) & 3
  const frac = imm8 & 15
  return sign * ((16 + frac) / 16) * 2 ** ((b ? 0 : 4) + cd - 3)
}
const FP_IMM = Array.from({ length: 256 }, (_, i) => fpImm8(i))

/** A float as written: 1.0, 0.5, -2.0 (always with a decimal point). */
export const fpText = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v))

export function readFloat(s: OperandStream): number | null {
  let sign = 1
  let k = 0
  if (s.isPunct('-')) {
    sign = -1
    k = 1
  } else if (s.isPunct('+')) k = 1
  const t = s.peek(k)
  if (!t || (t.kind !== 'float' && t.kind !== 'num')) return null
  s.pos += k + 1
  return sign * (t.kind === 'float' ? t.fnum! : Number(t.value))
}

interface FimmArg {
  fields: string[]
}
const fimm: OperandType<FimmArg> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    const v = readFloat(s)
    if (v === null) s.fail(L('这里应该是浮点立即数，例如 #1.5', 'Expected a floating-point immediate, e.g. #1.5'))
    const imm8 = FP_IMM.indexOf(v)
    if (imm8 < 0) s.fail(L(`${v} 不能写成 8 位浮点立即数（只能是 ±(1 + n/16) × 2^e，n 为 0–15，e 为 −3–4；0 要用 fmov 寄存器的写法）`, `${v} cannot be an 8-bit FP immediate (only ±(1 + n/16) × 2^e with n 0–15 and e −3–4; for 0 move a zero register)`), true, at)
    if (a.fields.length === 1) unify(s, f, a.fields[0]!, imm8)
    else {
      unify(s, f, a.fields[0]!, imm8 >> 5)
      unify(s, f, a.fields[1]!, imm8 & 31)
    }
  },
  print: (f, a) => fpText(FP_IMM[a.fields.length === 1 ? f[a.fields[0]!]! : (f[a.fields[0]!]! << 5) | f[a.fields[1]!]!]!),
  fields: (a) => a.fields,
  sample(f, a) {
    if (a.fields.length === 1) f[a.fields[0]!] = 0x78
    else {
      f[a.fields[0]!] = 0x78 >> 5
      f[a.fields[1]!] = 0x78 & 31
    }
    return '1.5'
  },
  hint: () => L('浮点立即数，例如 1.5、-0.25、10.0', 'floating-point immediate, e.g. 1.5, -0.25, 10.0'),
}

const fzero: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream) {
    const at = s.pos
    const v = readFloat(s)
    if (v !== 0) s.fail(L('这里只能是 #0.0', 'Only #0.0 is allowed here'), v !== null, at)
  },
  print: () => '0.0',
  fields: () => [],
  sample: () => '0.0',
  hint: () => '0.0',
}

/* ------------------------------------------------------------------ vector shifts */

interface ShArg {
  right: boolean
}
const vshift: OperandType<ShArg> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是移位量', 'Expected a shift amount'))
    const at = s.pos
    const es = f.immh ? highBit(f.immh) : f._es
    if (es === undefined) s.fail(L('先写寄存器才能确定移位量的范围', 'The registers come first, to set the shift range'))
    const esize = 8 << es
    const v = Number(s.expr())
    const [lo, hi] = a.right ? [1, esize] : [0, esize - 1]
    if (v < lo || v > hi) s.fail(L(`移位量 ${v} 超出范围：应在 ${lo} 到 ${hi} 之间`, `Shift ${v} out of range: expected ${lo} to ${hi}`), true, at)
    const code = a.right ? 2 * esize - v : esize + v
    unify(s, f, 'immh', code >> 3)
    unify(s, f, 'immb', code & 7)
  },
  print(f, a) {
    const esize = 8 << highBit(f.immh!)
    const code = (f.immh! << 3) | f.immb!
    return String(a.right ? 2 * esize - code : code - esize)
  },
  fields: () => ['immh', 'immb'],
  isDefault: (f, a) => !a.right && f.immh !== undefined && ((f.immh << 3) | (f.immb ?? 0)) === 8 << highBit(f.immh),
  sample(f, a) {
    const es = f.immh ? highBit(f.immh) : f._es ?? 2
    const esize = 8 << es
    const code = a.right ? 2 * esize - 3 : esize + 3
    f.immh = code >> 3
    f.immb = code & 7
    return '3'
  },
  hint: (a) => (a.right ? L('右移量：1 到元素位数', 'right shift: 1 to the element size') : L('左移量：0 到元素位数减 1', 'left shift: 0 to the element size minus 1')),
}

/** A right shift (or fraction bits) of 1 to `max`, kept as max − value in the field `sh`. */
const rsh: OperandType<{ max: number }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是移位量', 'Expected a shift amount'))
    const at = s.pos
    const v = Number(s.expr())
    if (v < 1 || v > a.max) s.fail(L(`移位量 ${v} 超出范围：应在 1 到 ${a.max} 之间`, `Shift ${v} out of range: expected 1 to ${a.max}`), true, at)
    unify(s, f, 'sh', a.max - v)
  },
  print: (f, a) => String(a.max - f.sh!),
  fields: () => ['sh'],
  sample(f, a) {
    f.sh = a.max - 3
    return '3'
  },
  hint: (a) => L(`1 到 ${a.max}`, `1 to ${a.max}`),
}

/** A complex rotation in degrees: `base` + field × `step` (FCMLA 0–270 by 90, FCADD 90 or 270). */
interface RotArg {
  field: string
  base: number
  step: number
}
const rot: OperandType<RotArg> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是旋转角度', 'Expected a rotation'))
    const at = s.pos
    const v = Number(s.expr())
    const max = (1 << s.width(a.field)) - 1
    const k = (v - a.base) / a.step
    if (!Number.isInteger(k) || k < 0 || k > max) s.fail(L(`旋转角度只能是 ${Array.from({ length: max + 1 }, (_, i) => a.base + i * a.step).join('、')}`, `The rotation must be ${Array.from({ length: max + 1 }, (_, i) => a.base + i * a.step).join(', ')}`), true, at)
    unify(s, f, a.field, k)
  },
  print: (f, a) => String(a.base + f[a.field]! * a.step),
  fields: (a) => [a.field],
  sample(f, a) {
    f[a.field] = 0
    return String(a.base)
  },
  hint: (a) => (a.step === 90 ? '0 / 90 / 180 / 270' : '90 / 270'),
}

/** SHLL's shift: the element size of the source, 8, 16 or 32. */
const shll: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    if (!s.startsValue()) s.fail(L('这里应该是移位量', 'Expected a shift amount'))
    const at = s.pos
    const v = Number(s.expr())
    const want = 8 << (f.size ?? 0)
    if (v !== want) s.fail(L(`shll 的移位量只能是元素位数 ${want}`, `The shift of shll can only be the element size, ${want}`), true, at)
  },
  print: (f) => String(8 << f.size!),
  fields: () => [],
  sample: (f) => String(8 << (f.size ?? 0)),
  hint: () => L('元素位数（8、16 或 32）', 'the element size (8, 16 or 32)'),
}

/* ------------------------------------------------------------------ modified immediates */

const mimm8: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    const v = s.expr()
    if (v < 0n || v > 255n) s.fail(L(`立即数 ${v} 超出范围：应在 0 到 255 之间（可以再加 lsl）`, `Immediate ${v} out of range: expected 0 to 255 (optionally with lsl)`), true, at)
    unify(s, f, 'abc', Number(v) >> 5)
    unify(s, f, 'defgh', Number(v) & 31)
  },
  print: (f) => fmtImm((f.abc! << 5) | f.defgh!),
  fields: () => ['abc', 'defgh'],
  sample(f) {
    f.abc = 0
    f.defgh = 16
    return '16'
  },
  hint: () => L('0 到 255 的整数', 'integer from 0 to 255'),
}

/** MOVI's 64-bit immediate: every byte 0x00 or 0xff. */
const mimm64: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    const v = BigInt.asUintN(64, s.expr())
    let imm8 = 0
    for (let i = 0; i < 8; i++) {
      const byte = Number((v >> BigInt(8 * i)) & 0xffn)
      if (byte !== 0 && byte !== 0xff) s.fail(L('这个 64 位立即数的每个字节只能是 0x00 或 0xff', 'Every byte of this 64-bit immediate must be 0x00 or 0xff'), true, at)
      if (byte) imm8 |= 1 << i
    }
    unify(s, f, 'abc', imm8 >> 5)
    unify(s, f, 'defgh', imm8 & 31)
  },
  print(f) {
    const imm8 = (f.abc! << 5) | f.defgh!
    let v = 0n
    for (let i = 0; i < 8; i++) if (imm8 & (1 << i)) v |= 0xffn << BigInt(8 * i)
    // As C's "%#016llx", like LLVM: zero has no 0x prefix.
    return v ? '0x' + v.toString(16).padStart(14, '0') : '0'.repeat(16)
  },
  fields: () => ['abc', 'defgh'],
  sample(f) {
    f.abc = 0
    f.defgh = 0b01111
    return '0x00000000ffffffff'
  },
  hint: () => L('64 位立即数，每个字节是 0x00 或 0xff', '64-bit immediate whose bytes are each 0x00 or 0xff'),
}

/** The lsl #n of a shifted modified immediate: n / 8 in the field `cm`. `max`: the largest shift. */
const mlsl: OperandType<{ max: number }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是移位量', 'Expected a shift amount'))
    const at = s.pos
    const v = Number(s.expr())
    if (v % 8 !== 0 || v < 0 || v > a.max) s.fail(L(`移位量只能是 0 到 ${a.max} 之间 8 的倍数`, `The shift must be a multiple of 8 from 0 to ${a.max}`), true, at)
    unify(s, f, 'cm', v / 8)
  },
  print: (f) => String((f.cm ?? 0) * 8),
  fields: () => ['cm'],
  isDefault: (f) => (f.cm ?? 0) === 0,
  fillDefault(f) {
    f.cm ??= 0
  },
  sample: () => '0',
  hint: (a) => L(`0 到 ${a.max} 之间 8 的倍数`, `multiple of 8 from 0 to ${a.max}`),
}

/** MSL #8 or #16 (shifting ones in): the field `cm` is 0 or 1. */
const msl: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    if (!s.startsValue()) s.fail(L('这里应该是移位量', 'Expected a shift amount'))
    const at = s.pos
    const v = Number(s.expr())
    if (v !== 8 && v !== 16) s.fail(L('msl 只能移 8 或 16 位', 'msl shifts by 8 or 16 only'), true, at)
    unify(s, f, 'cm', v === 16 ? 1 : 0)
  },
  print: (f) => (f.cm ? '16' : '8'),
  fields: () => ['cm'],
  sample: () => '8',
  hint: () => '8 / 16',
}

/* ------------------------------------------------------------------ odds and ends */

/** FMOV's upper doubleword, v0.d[1]. */
const vd1: OperandType<{ field: string }> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const r = vtok(s)
    if (!r || r.kind !== 'v' || r.arr !== 'd' || !s.isPunct('[', 1) || s.peek(2)?.text !== '1' || !s.isPunct(']', 3)) s.fail(L('这里应该是 v0.d[1] 这样的高 64 位', 'Expected the upper doubleword, as in v0.d[1]'))
    unify(s, f, a.field, r.n)
    s.pos += 4
  },
  print: (f, a) => `v${f[a.field]}.d[1]`,
  fields: (a) => [a.field],
  sample(f, a) {
    f[a.field] ??= SAMPLE_REG[a.field] ?? 0
    return `v${f[a.field]}.d[1]`
  },
  hint: () => L('向量寄存器的高 64 位，例如 v0.d[1]', 'the upper doubleword of a vector register, e.g. v0.d[1]'),
}

/** The fraction bits of a fixed-point conversion: #1 to #64 (#32 for W registers), kept as 64 − fbits in scale. */
const fbits: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    if (!s.startsValue()) s.fail(L('这里应该是小数位数', 'Expected the number of fraction bits'))
    const at = s.pos
    const v = Number(s.expr())
    const max = f.sf === 0 ? 32 : 64
    if (v < 1 || v > max) s.fail(L(`小数位数 ${v} 超出范围：应在 1 到 ${max} 之间`, `Fraction bits ${v} out of range: expected 1 to ${max}`), true, at)
    unify(s, f, 'scale', 64 - v)
  },
  print: (f) => String(64 - f.scale!),
  fields: () => ['scale'],
  sample(f) {
    f.scale = 60
    return '4'
  },
  hint: () => L('小数位数（定点数）', 'fraction bits (fixed point)'),
}

/* ------------------------------------------------------------------ resolving */

const REG_FIELD: Record<string, string> = { d: 'Rd', n: 'Rn', m: 'Rm', t: 'Rt', t2: 'Rt2', a: 'Ra' }

/** Named element layouts for `<E@name>` (see the instruction tables). */
export const ELEMENT_LAYOUTS: Record<string, { es: string; label?: string; layout: Layout }> = {
  // Integer multiplies by element: h uses H:L:M and a 4-bit Rm, s uses H:L and M:Rm.
  mul: { es: 'size', layout: (es) => (es === 1 ? { reg: ['Rm'], idx: ['H', 'L', 'M'] } : es === 2 ? { reg: ['M', 'Rm'], idx: ['H', 'L'] } : null) },
  // Widening multiplies by element: the element size is that of the narrow source.
  mull: { es: 'size', layout: (es) => (es === 1 ? { reg: ['Rm'], idx: ['H', 'L', 'M'] } : es === 2 ? { reg: ['M', 'Rm'], idx: ['H', 'L'] } : null) },
  // FP by element: s uses H:L, d uses H (L zero), both with M:Rm.
  fmul: { es: 'sz+2', layout: (es) => (es === 2 ? { reg: ['M', 'Rm'], idx: ['H', 'L'] } : es === 3 ? { reg: ['M', 'Rm'], idx: ['H'], zero: ['L'] } : null) },
  fmulh: { es: 'h', layout: () => ({ reg: ['Rm'], idx: ['H', 'L', 'M'] }) },
  dot4b: { es: 'b', label: '4b', layout: () => ({ reg: ['M', 'Rm'], idx: ['H', 'L'] }) },
  dot2h: { es: 'h', label: '2h', layout: () => ({ reg: ['M', 'Rm'], idx: ['H', 'L'] }) },
  fhm: { es: 'h', layout: () => ({ reg: ['Rm'], idx: ['H', 'L', 'M'] }) },
  fcmla: { es: 'size', layout: (es) => (es === 1 ? { reg: ['M', 'Rm'], idx: ['H', 'L'] } : es === 2 ? { reg: ['M', 'Rm'], idx: ['H'], zero: ['L'] } : null) },
}

/** Resolve a SIMD&FP placeholder, or null when the name is not one. */
export function resolveSimd(name: string): OpSpec | null {
  let m = /^([BHSDQ])(d|n|m|a|t|t2)$/.exec(name)
  if (m) return { type: sreg, arg: { field: REG_FIELD[m[2]!]!, es: { kind: 'fixed', es: LETTERS.indexOf(m[1]!.toLowerCase()) } }, name }
  m = /^E(d|n|m|a|t|t2):([\w+-]+)$/.exec(name)
  if (m) return { type: sreg, arg: { field: REG_FIELD[m[1]!]!, es: parseEsSpec(m[2]!) }, name }
  m = /^V(d|n|m|a|t|t2):([\w+-]+):(Q|Qh|h|0|1)$/.exec(name)
  if (m) return { type: vreg, arg: { field: REG_FIELD[m[1]!]!, es: parseEsSpec(m[2]!), q: parseQ(m[3]!) }, name }
  m = /^E@(\w+)$/.exec(name)
  if (m) {
    const l = ELEMENT_LAYOUTS[m[1]!]
    if (!l) throw new Error(`unknown element layout ${m[1]}`)
    return { type: elem, arg: { es: parseEsSpec(l.es), label: l.label ?? null, layout: l.layout }, name }
  }
  m = /^E5(s)?:(d|n)$/.exec(name)
  if (m) return { type: elem5, arg: { field: REG_FIELD[m[2]!]!, src: !!m[1] }, name }
  m = /^L:(Rt|Rn):(\d):([\w+-]+):(Q|0|1)$/.exec(name)
  if (m) return { type: vlist, arg: { field: m[1]!, count: Number(m[2]), es: parseEsSpec(m[3]!), q: parseQ(m[4]!) }, name }
  m = /^LI:(\d):([bhsd])$/.exec(name)
  if (m) return { type: vlist, arg: { field: 'Rt', count: Number(m[1]), es: { kind: 'fixed', es: LETTERS.indexOf(m[2]!) }, q: null }, name }
  m = /^lane:([bhsd])$/.exec(name)
  if (m) return { type: laneIndex, arg: { es: LETTERS.indexOf(m[1]!) }, name }
  m = /^post:(\d):(mult|one|rep)(?::([bhsd]))?$/.exec(name)
  if (m) return { type: post, arg: { count: Number(m[1]), mode: m[2] as PostArg['mode'], es: m[3] ? LETTERS.indexOf(m[3]) : 0 }, name }
  m = /^X:(d|n|m|t):([bhsd]):([\w+]+)$/.exec(name)
  if (m) return { type: xelem, arg: { field: REG_FIELD[m[1]!]!, es: LETTERS.indexOf(m[2]!), idx: m[3]!.split('+') }, name }
  m = /^(c?)rot:(\w+)$/.exec(name)
  if (m) return { type: rot, arg: { field: m[2]!, base: m[1] ? 90 : 0, step: m[1] ? 180 : 90 }, name }
  m = /^rsh:(\d+)$/.exec(name)
  if (m) return { type: rsh, arg: { max: Number(m[1]) }, name }
  m = /^VD1:(d|n)$/.exec(name)
  if (m) return { type: vd1, arg: { field: REG_FIELD[m[1]!]! }, name }
  switch (name) {
    case 'fbits':
      return { type: fbits, arg: null, name }
    case 'fimm8':
      return { type: fimm, arg: { fields: ['imm8'] }, name }
    case 'fimmv':
      return { type: fimm, arg: { fields: ['abc', 'defgh'] }, name }
    case 'fzero':
      return { type: fzero, arg: null, name }
    case 'shll':
      return { type: shll, arg: null, name }
    case 'vshr':
      return { type: vshift, arg: { right: true }, name }
    case 'vshl':
      return { type: vshift, arg: { right: false }, name }
    case 'mimm8':
      return { type: mimm8, arg: null, name }
    case 'mimm64':
      return { type: mimm64, arg: null, name }
    case 'mlsl8':
      return { type: mlsl, arg: { max: 8 }, name }
    case 'mlsl24':
      return { type: mlsl, arg: { max: 24 }, name }
    case 'msl':
      return { type: msl, arg: null, name }
  }
  return null
}
