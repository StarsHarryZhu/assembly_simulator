/**
 * Operand types of the SME instructions, resolved from template placeholders (see resolveSme):
 *
 *   <tile:F:es>              za3.s: a ZA tile of element size es (b h s d q), its number in field F
 *   <slice:F:es:n>           za0h.s[w12, 3] / za1v.d[w13, 0:1]: n (1, 2 or 4) consecutive slices of a tile;
 *                            F holds the tile number in its high es bits and the offset / n in the rest
 *                            ('-' for none: a byte tile with no offset field), V the direction, Rv the
 *                            index register w12–w15
 *   <slice1:F:es>            the same in braces, {za0h.b[w12, 0]} (LD1, ST1)
 *   <za:es:n:vg:F>           za.s[w8, 0, vgx2] / za.s[w8, 0:1]: vg vector groups (1, 2 or 4; vgx2 and vgx4
 *                            may be left out when assembling) of n consecutive vectors each; the index
 *                            register w8–w11 in Rv, the first offset / n in field F ('-' for none)
 *   <zamask>                 {za0.d, za3.d}: ZERO's tile mask in imm8
 *   <zt0list>                { zt0 }
 *   <LS:T:Zt:n:es>           { z1.s, z9.s } / { z16.s, z20.s, z24.s, z28.s }: n registers 16 / n apart
 *                            (strided), the first T × 16 + Zt
 *   <word:F:a|b|c(=d)>       one of several words by the value of field F; `=d` makes the word optional,
 *                            standing for d when left out
 *   <W8v>                    an index register w8–w11 in the 2-bit field Rv
 *   <nshift:N:a+b>           a right shift of N minus the fields' value (1 to N), the first field highest
 */
import { L } from '../../../core/i18n'
import { parseGpr, parseSveReg } from '../registers'
import { printWidths } from './operands'
import { unify, type Fields, type OperandStream, type OperandType, type OpSpec } from './syntax'

const LETTERS = 'bhsdq'
const width = (f: string) => printWidths.current[f] ?? 0

function ident(s: OperandStream): string | null {
  const t = s.peek()
  return t && t.kind === 'ident' ? t.text : null
}

/** A name of ZA: `za`, `za.s`, `za3.s`, `za0h.b`, `za1v.d` (h and v only with an element size). */
export interface ZaRef {
  /** Tile number, or null for the whole array `za`. */
  n: number | null
  dir: 'h' | 'v' | null
  es: number | null
}

export function parseZa(name: string): ZaRef | null {
  const m = /^za(\d{1,2})?([hv])?(?:\.([bhsdq]))?$/.exec(name.toLowerCase())
  if (!m) return null
  if (m[2] && !m[3]) return null
  const n = m[1] === undefined ? null : Number(m[1])
  const es = m[3] ? LETTERS.indexOf(m[3]) : null
  if (n !== null && (es === null || n >= 1 << es || (m[1]!.length > 1 && m[1]![0] === '0'))) return null
  if (n === null && m[2]) return null
  return { n, dir: (m[2] as 'h' | 'v' | undefined) ?? null, es }
}

/** Every SME register name, for highlighting and completion. */
export const SME_WORDS = [
  'za',
  'zt0',
  ...[0, 1, 2, 3, 4].flatMap((es) => Array.from({ length: 1 << es }, (_, n) => [`za${n}`, `za${n}h`, `za${n}v`]).flat()),
].filter((w, i, a) => a.indexOf(w) === i)

/* ------------------------------------------------------------------ index registers and offsets */

/** w12–w15 (tile slices) or w8–w11 (array vectors) in field Rv. */
function readIndexReg(s: OperandStream, f: Fields, base: number): void {
  const text = ident(s)
  const r = text ? parseGpr(text) : null
  if (!r || r.x || r.sp || r.zr || r.n < base || r.n > base + 3) s.fail(L(`这里只能用 w${base} 到 w${base + 3}`, `Only w${base} to w${base + 3} are allowed here`))
  unify(s, f, 'Rv', r.n - base)
  s.pos++
}

/** An offset `o` or a range `o:o+n−1` (n > 1), with o a multiple of n below n × 2^bits. */
function readOffset(s: OperandStream, n: number, bits: number): number {
  s.eat('#')
  const at = s.pos
  if (!s.startsValue()) s.fail(L('这里应该是偏移', 'Expected an offset'))
  const first = Number(s.expr())
  const max = n * (2 ** bits - 1)
  if (n > 1) {
    if (!s.eat(':')) s.fail(L(`这里要写范围，例如 0:${n - 1}`, `Write a range here, e.g. 0:${n - 1}`), true)
    const last = Number(s.expr())
    if (last !== first + n - 1) s.fail(L(`范围应是 ${n} 个连续的数，例如 0:${n - 1}`, `The range must cover ${n} numbers, e.g. 0:${n - 1}`), true, at)
  }
  if (first < 0 || first > max || first % n) s.fail(n > 1 ? L(`偏移应是 0 到 ${max} 之间 ${n} 的倍数`, `The offset must be a multiple of ${n} from 0 to ${max}`) : L(`偏移应在 0 到 ${max} 之间`, `The offset must be 0 to ${max}`), true, at)
  return first / n
}

const range = (o: number, n: number) => (n > 1 ? `${o * n}:${o * n + n - 1}` : String(o))

/* ------------------------------------------------------------------ tiles */

interface TileArg {
  field: string
  es: number
}

const tile: OperandType<TileArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const text = ident(s)
    const r = text ? parseZa(text) : null
    const count = 1 << a.es
    if (!r || r.n === null || r.dir !== null || r.es !== a.es) s.fail(L(`这里应该是 ZA 的 ${LETTERS[a.es]} 型 tile，例如 za0.${LETTERS[a.es]}`, `Expected a ZA tile of .${LETTERS[a.es]} elements, e.g. za0.${LETTERS[a.es]}`))
    if (r.n >= count) s.fail(L(`.${LETTERS[a.es]} 的 tile 只有 za0 到 za${count - 1}`, `.${LETTERS[a.es]} tiles are za0 to za${count - 1}`), true)
    if (a.field !== '-') unify(s, f, a.field, r.n)
    else if (r.n) s.fail(L('这里只能是 za0', 'Only za0 is allowed here'), true)
    s.pos++
  },
  print: (f, a) => `za${a.field === '-' ? 0 : (f[a.field] ?? 0)}.${LETTERS[a.es]}`,
  fields: (a) => (a.field === '-' ? [] : [a.field]),
  sample(f, a) {
    if (a.field !== '-') f[a.field] ??= Math.min(1, (1 << a.es) - 1)
    return `za${a.field === '-' ? 0 : f[a.field]}.${LETTERS[a.es]}`
  },
  hint: (a) => L(`ZA 的 tile，例如 za0.${LETTERS[a.es]}`, `a ZA tile, e.g. za0.${LETTERS[a.es]}`),
  options: (_f, a) => Array.from({ length: 1 << a.es }, (_, i) => `za${i}.${LETTERS[a.es]}`),
}

/* ------------------------------------------------------------------ tile slices */

interface SliceArg {
  /** Field with the tile number (high es bits) and the offset / n (the rest); '-' for none. */
  field: string
  es: number
  n: number
  braces: boolean
}

/** Tile number and offset index from the combined field. */
function splitSlice(f: Fields, a: SliceArg): { t: number; o: number } {
  if (a.field === '-') return { t: 0, o: 0 }
  const v = f[a.field] ?? 0
  const ob = width(a.field) - a.es
  return { t: v >> ob, o: v & ((1 << ob) - 1) }
}

function printSlice(f: Fields, a: SliceArg): string {
  const { t, o } = splitSlice(f, a)
  const text = `za${t}${f.V ? 'v' : 'h'}.${LETTERS[a.es]}[w${12 + (f.Rv ?? 0)}, ${range(o, a.n)}]`
  return a.braces ? `{${text}}` : text
}

const slice: OperandType<SliceArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    if (a.braces && !s.eat('{')) s.fail(L('这里应该是 { za0h.b[w12, 0] } 这样的 tile 切片', 'Expected a tile slice in braces, e.g. { za0h.b[w12, 0] }'))
    const text = ident(s)
    const r = text ? parseZa(text) : null
    if (!r || r.n === null || r.dir === null) s.fail(L(`这里应该是 tile 的一行或一列，例如 za0h.${LETTERS[a.es]}[w12, 0]`, `Expected a tile slice, e.g. za0h.${LETTERS[a.es]}[w12, 0]`))
    if (r.es !== a.es) s.fail(L(`这里的元素大小应该是 .${LETTERS[a.es]}`, `The element size here must be .${LETTERS[a.es]}`), true)
    const ob = a.field === '-' ? 0 : s.width(a.field) - a.es
    s.pos++
    unify(s, f, 'V', r.dir === 'v' ? 1 : 0)
    if (!s.eat('[')) s.fail(L('切片要写 [索引寄存器, 偏移]', 'A slice takes [index register, offset]'))
    readIndexReg(s, f, 12)
    if (!s.eat(',')) s.fail(L('缺少偏移', 'Missing the offset'))
    const o = readOffset(s, a.n, ob)
    if (!s.eat(']')) s.fail(L('缺少 ]', 'Missing ]'))
    if (a.braces && !s.eat('}')) s.fail(L('缺少 }', 'Missing }'))
    if (a.field === '-') return
    unify(s, f, a.field, (r.n << ob) | o)
  },
  print: (f, a) => printSlice(f, a),
  fields: (a) => [...(a.field === '-' ? [] : [a.field]), 'V', 'Rv'],
  sample(f, a) {
    if (a.field !== '-') f[a.field] ??= 0
    f.V ??= 0
    f.Rv ??= 0
    return printSlice(f, a)
  },
  hint: (a) => L(`tile 的${a.n > 1 ? ` ${a.n} ` : '一'}行（h）或列（v），例如 za0h.${LETTERS[a.es]}[w12, ${range(0, a.n)}]`, `${a.n > 1 ? `${a.n} slices` : 'a slice'} of a tile, horizontal (h) or vertical (v), e.g. za0h.${LETTERS[a.es]}[w12, ${range(0, a.n)}]`),
}

/* ------------------------------------------------------------------ ZA array vectors */

interface ArrayArg {
  /** Element size, or -1 for any (MOVA's array forms print .d). */
  es: number
  n: number
  vg: number
  /** Offset field ('-' when the offset is always 0). */
  field: string
}

function printArray(f: Fields, a: ArrayArg): string {
  const o = a.field === '-' ? 0 : (f[a.field] ?? 0)
  const letter = a.es < 0 ? 'd' : LETTERS[a.es]
  return `za.${letter}[w${8 + (f.Rv ?? 0)}, ${range(o, a.n)}${a.vg > 1 ? `, vgx${a.vg}` : ''}]`
}

const zarray: OperandType<ArrayArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const text = ident(s)
    const r = text ? parseZa(text) : null
    if (!r || r.n !== null || r.es === null || r.es > 3) s.fail(L('这里应该是 ZA 的向量组，例如 za.s[w8, 0, vgx2]', 'Expected ZA array vectors, e.g. za.s[w8, 0, vgx2]'))
    if (a.es >= 0 && r.es !== a.es) s.fail(L(`这里的元素大小应该是 .${LETTERS[a.es]}`, `The element size here must be .${LETTERS[a.es]}`), true)
    s.pos++
    if (!s.eat('[')) s.fail(L('要写 [索引寄存器, 偏移]', 'Write [index register, offset]'))
    readIndexReg(s, f, 8)
    if (!s.eat(',')) s.fail(L('缺少偏移', 'Missing the offset'))
    const o = readOffset(s, a.n, a.field === '-' ? 0 : s.width(a.field))
    if (s.eat(',')) {
      const w = s.word()
      if (a.vg === 1 || w !== `vgx${a.vg}`) s.fail(a.vg === 1 ? L('这里不分组，不能写 vgx', 'This form has no vector groups: leave out vgx') : L(`这里应该是 vgx${a.vg}`, `Expected vgx${a.vg} here`), true)
      s.pos++
    }
    if (!s.eat(']')) s.fail(L('缺少 ]', 'Missing ]'))
    if (a.field !== '-') unify(s, f, a.field, o)
  },
  print: (f, a) => printArray(f, a),
  fields: (a) => [...(a.field === '-' ? [] : [a.field]), 'Rv'],
  sample(f, a) {
    if (a.field !== '-') f[a.field] ??= 0
    f.Rv ??= 0
    return printArray(f, a)
  },
  hint: (a) => L(`ZA 的向量，例如 ${printArray({}, a)}`, `ZA array vectors, e.g. ${printArray({}, a)}`),
}

/** w8–w11 in field Rv. */
const w8v: OperandType<null> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields) {
    readIndexReg(s, f, 8)
  },
  print: (f) => `w${8 + (f.Rv ?? 0)}`,
  fields: () => ['Rv'],
  sample(f) {
    f.Rv ??= 0
    return `w${8 + f.Rv}`
  },
  hint: () => L('索引寄存器 w8 到 w11', 'an index register, w8 to w11'),
  options: () => ['w8', 'w9', 'w10', 'w11'],
}

/* ------------------------------------------------------------------ ZERO's tile mask */

/**
 * The tiles a mask covers, as LLVM prints them: the whole array, one .h tile, or .s tiles when the mask is
 * exactly a set of them (its two halves equal); otherwise every .d tile (a .h tile is mask bits 0x55 << n,
 * a .s tile 0x11 << n, a .d tile 1 << n).
 */
export function maskTiles(mask: number): string[] {
  if (mask === 0xff) return ['za']
  if (mask === 0x55 || mask === 0xaa) return [`za${mask === 0x55 ? 0 : 1}.h`]
  if (mask && (mask & 15) === mask >> 4) return [0, 1, 2, 3].filter((n) => mask & (1 << n)).map((n) => `za${n}.s`)
  return [0, 1, 2, 3, 4, 5, 6, 7].filter((n) => mask & (1 << n)).map((n) => `za${n}.d`)
}

/** The mask bits of one tile name (null when it is not one ZERO takes). */
function tileMask(text: string): number | null {
  const r = parseZa(text)
  if (!r || r.dir !== null) return null
  if (r.n === null) return r.es === null ? 0xff : r.es === 0 ? 0xff : null
  if (r.es === 0) return 0xff
  if (r.es === 1) return 0x55 << r.n
  if (r.es === 2) return 0x11 << r.n
  if (r.es === 3) return 1 << r.n
  return null
}

const zamask: OperandType<null> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields) {
    if (!s.eat('{')) s.fail(L('这里应该是 tile 列表，例如 {za0.d, za1.d} 或 {za}', 'Expected a list of tiles, e.g. {za0.d, za1.d} or {za}'))
    let mask = 0
    if (!s.isPunct('}')) {
      do {
        const text = ident(s)
        const m = text ? tileMask(text) : null
        if (m === null) s.fail(L('列表里应该是 za 或 tile（za0.b、za1.h、za3.s、za7.d）', 'The list takes za or tiles (za0.b, za1.h, za3.s, za7.d)'), true)
        mask |= m
        s.pos++
      } while (s.eat(','))
    }
    if (!s.eat('}')) s.fail(L('缺少 }', 'Missing }'))
    unify(s, f, 'imm8', mask)
  },
  print: (f) => `{${maskTiles(f.imm8 ?? 0).join(', ')}}`,
  fields: () => ['imm8'],
  sample(f) {
    f.imm8 ??= 0xff
    return `{${maskTiles(f.imm8).join(', ')}}`
  },
  hint: () => L('要清零的 tile，例如 {za} 或 {za0.s, za1.s}', 'the tiles to zero, e.g. {za} or {za0.s, za1.s}'),
}

/* ------------------------------------------------------------------ ZT0 */

const zt0list: OperandType<null> = {
  kind: 'reg',
  parse(s: OperandStream) {
    if (!s.eat('{') || s.word() !== 'zt0') s.fail(L('这里应该是 { zt0 }', 'Expected { zt0 }'))
    s.pos++
    if (!s.eat('}')) s.fail(L('缺少 }', 'Missing }'))
  },
  print: () => '{ zt0 }',
  fields: () => [],
  sample: () => '{ zt0 }',
  hint: () => '{ zt0 }',
}

/* ------------------------------------------------------------------ strided lists */

interface StridedArg {
  t: string
  zt: string
  n: number
  es: number
}

function stridedRegs(f: Fields, a: StridedArg): number[] {
  const first = (f[a.t] ?? 0) * 16 + (f[a.zt] ?? 0)
  return Array.from({ length: a.n }, (_, i) => first + (i * 16) / a.n)
}

const strided: OperandType<StridedArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    if (!s.eat('{')) s.fail(L('这里应该是寄存器列表', 'Expected a register list'))
    const regs: number[] = []
    let es: number | null = null
    do {
      const text = ident(s)
      const r = text ? parseSveReg(text) : null
      if (!r || r.kind !== 'z' || r.es === null) s.fail(L('列表里应该是带元素大小的 z 寄存器', 'The list takes z registers with an element size'))
      if (es !== null && r.es !== es) s.fail(L('列表里的元素大小要一致', 'The list must use one element size'), true)
      es = r.es
      regs.push(r.n)
      s.pos++
    } while (s.eat(','))
    if (!s.eat('}')) s.fail(L('缺少 }', 'Missing }'))
    const step = 16 / a.n
    const first = regs[0]!
    const ok = regs.length === a.n && regs.every((r, i) => r === first + i * step) && first % 16 < step
    if (!ok) s.fail(L(`这里要 ${a.n} 个间隔 ${step} 的寄存器，第一个是 z0–z${step - 1} 或 z16–z${16 + step - 1}，例如 { ${Array.from({ length: a.n }, (_, i) => `z${i * step}.${LETTERS[a.es]}`).join(', ')} }`, `Expected ${a.n} registers ${step} apart, starting at z0–z${step - 1} or z16–z${16 + step - 1}, e.g. { ${Array.from({ length: a.n }, (_, i) => `z${i * step}.${LETTERS[a.es]}`).join(', ')} }`), true, at)
    if (es !== a.es) s.fail(L(`元素大小应该是 .${LETTERS[a.es]}`, `The element size must be .${LETTERS[a.es]}`), true, at)
    unify(s, f, a.t, first >> 4)
    unify(s, f, a.zt, first & 15)
  },
  print: (f, a) => `{ ${stridedRegs(f, a).map((r) => `z${r}.${LETTERS[a.es]}`).join(', ')} }`,
  fields: (a) => [a.t, a.zt],
  sample(f, a) {
    f[a.t] ??= 0
    f[a.zt] ??= 0
    return `{ ${stridedRegs(f, a).map((r) => `z${r}.${LETTERS[a.es]}`).join(', ')} }`
  },
  hint: (a) => L(`${a.n} 个间隔 ${16 / a.n} 的 z 寄存器`, `${a.n} z registers ${16 / a.n} apart`),
}

/* ------------------------------------------------------------------ words */

interface WordArg {
  field: string
  names: string[]
  dflt: number | null
}

const word: OperandType<WordArg> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields, a) {
    const w = s.word()
    const i = w === null ? -1 : a.names.indexOf(w)
    if (i < 0 || !w) s.fail(L(`这里应该是 ${a.names.filter(Boolean).join(' / ')}`, `Expected ${a.names.filter(Boolean).join(' / ')}`))
    unify(s, f, a.field, i)
    s.pos++
  },
  print: (f, a) => a.names[f[a.field] ?? 0] ?? '',
  fields: (a) => [a.field],
  isDefault: (f, a) => a.dflt !== null && (f[a.field] ?? a.dflt) === a.dflt,
  fillDefault(f, a) {
    if (a.dflt !== null) f[a.field] ??= a.dflt
  },
  sample(f, a) {
    const i = f[a.field] ?? a.names.findIndex(Boolean)
    f[a.field] = i
    return a.names[i] ?? ''
  },
  hint: (a) => a.names.filter(Boolean).join(' | '),
  options: (_f, a) => a.names.filter(Boolean),
}

/* ------------------------------------------------------------------ narrowing shift amounts */

interface NShiftArg {
  n: number
  fields: string[]
}

const nshiftValue = (f: Fields, a: NShiftArg) => a.fields.reduce((v, name) => (v << width(name)) | (f[name] ?? 0), 0)

const nshift: OperandType<NShiftArg> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    const at = s.pos
    if (!s.startsValue()) s.fail(L('这里应该是移位量', 'Expected a shift amount'))
    const v = Number(s.expr())
    if (!Number.isInteger(v) || v < 1 || v > a.n) s.fail(L(`移位量应在 1 到 ${a.n} 之间`, `The shift must be 1 to ${a.n}`), true, at)
    let rest = a.n - v
    for (const name of [...a.fields].reverse()) {
      const w = s.width(name)
      unify(s, f, name, rest & ((1 << w) - 1))
      rest >>= w
    }
  },
  print: (f, a) => String(a.n - nshiftValue(f, a)),
  fields: (a) => a.fields,
  sample(f, a) {
    for (const name of a.fields) f[name] ??= 0
    return String(a.n - nshiftValue(f, a))
  },
  hint: (a) => L(`右移位数：1 到 ${a.n}`, `right shift: 1 to ${a.n}`),
}

/* ------------------------------------------------------------------ resolver */

const esOf = (t: string) => LETTERS.indexOf(t)

export function resolveSme(name: string): OpSpec | null {
  let m = /^tile:([\w-]+):([bhsdq])$/.exec(name)
  if (m) return { type: tile, arg: { field: m[1]!, es: esOf(m[2]!) }, name }
  m = /^slice(1)?:([\w-]+):([bhsdq])(?::(\d))?$/.exec(name)
  if (m) return { type: slice, arg: { field: m[2]!, es: esOf(m[3]!), n: Number(m[4] ?? 1), braces: !!m[1] }, name }
  m = /^za:([bhsd*]):(\d):(\d):([\w-]+)$/.exec(name)
  if (m) return { type: zarray, arg: { es: m[1] === '*' ? -1 : esOf(m[1]!), n: Number(m[2]), vg: Number(m[3]), field: m[4]! }, name }
  m = /^LS:(\w+):(\w+):(\d):([bhsdq])$/.exec(name)
  if (m) return { type: strided, arg: { t: m[1]!, zt: m[2]!, n: Number(m[3]), es: esOf(m[4]!) }, name }
  m = /^nshift:(\d+):(\w+(?:\+\w+)*)$/.exec(name)
  if (m) return { type: nshift, arg: { n: Number(m[1]), fields: m[2]!.split('+') }, name }
  m = /^word:(\w+):([\w|]*?)(?:=(\d+))?$/.exec(name)
  if (m) return { type: word, arg: { field: m[1]!, names: m[2]!.split('|'), dflt: m[3] === undefined ? null : Number(m[3]) }, name }
  switch (name) {
    case 'zamask':
      return { type: zamask, arg: null, name }
    case 'zt0list':
      return { type: zt0list, arg: null, name }
    case 'W8v':
      return { type: w8v, arg: null, name }
  }
  return null
}
