/**
 * SVE permutes: extract, broadcast (DUP), table lookups, insert, unpack, reverse, interleave (ZIP, UZP,
 * TRN) of vectors and predicates, the predicated copies and extractions (CPY, COMPACT, LASTA/LASTB,
 * CLASTA/CLASTB, SPLICE), SEL, and the SVE2.1 permutes within each 128-bit segment (DUPQ, EXTQ, TBLQ,
 * TBXQ, ZIPQ, UZPQ).
 */
import { L, T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { ESIZE, rbit, sx, ux } from './vec'
import { bin, sizes } from './sve-int'
import { count, pget, predicated, zget, zset } from './zvec'

export const INSTRS: InstrSpec[] = []
export const ALIASES: AliasSpec[] = []

const G = 'sveperm'
/** A general register read at an element's width (W for b, h, s; X for d), with 31 as SP when asked. */
const rget = (c: Cpu, n: number, es: number, sp: boolean) => ux(sp ? c.xsp(n) : c.x(n), es)

/* ------------------------------------------------------------------ extract */

function extract(c: Cpu, lo: Uint8Array, hi: Uint8Array, pos: number): Uint8Array {
  const vl = c.vl
  const start = pos >= vl ? 0 : pos
  const out = new Uint8Array(vl)
  for (let i = 0; i < vl; i++) out[i] = start + i < vl ? lo[start + i]! : hi[start + i - vl]!
  return out
}

INSTRS.push(
  {
    id: 'sve-ext',
    mnemonic: 'ext',
    group: G,
    feature: 'sve',
    bits: '00000101 001 imm8h:5 000 imm8l:3 Zm:5 Zdn:5',
    syntax: '<Zdn.b>, <Zdn.b>, <Zm.b>, #<split:imm8h+imm8l>',
    desc: T('从 Zdn:Zm 拼接成的字节序列里，从第 imm 个字节起取一个向量（imm 超出向量长度时从 0 起）', 'Take a vector of bytes starting at byte imm of Zdn:Zm (from 0 when imm is past the vector length)'),
    exec: (c, f) => c.vwrite(f.Zdn!, extract(c, c.vread(f.Zdn!, c.vl), c.vread(f.Zm!, c.vl), (f.imm8h! << 3) | f.imm8l!)),
  },
  {
    id: 'sve-ext-con',
    mnemonic: 'ext',
    group: G,
    feature: 'sve2',
    bits: '00000101 011 imm8h:5 000 imm8l:3 Zn:5 Zd:5',
    syntax: '<Zd.b>, <L:Zn:2:b>, #<split:imm8h+imm8l>',
    desc: T('从 Zn:Zn+1 拼接成的字节序列里，从第 imm 个字节起取一个向量', 'Take a vector of bytes starting at byte imm of Zn:Zn+1'),
    exec: (c, f) => c.vwrite(f.Zd!, extract(c, c.vread(f.Zn!, c.vl), c.vread((f.Zn! + 1) % 32, c.vl), (f.imm8h! << 3) | f.imm8l!)),
  },
)

/* ------------------------------------------------------------------ broadcast and table lookup */

INSTRS.push({
  id: 'sve-dup-idx',
  mnemonic: 'dup',
  group: G,
  feature: 'sve',
  bits: '00000101 imm2:2 1 tsz:5 001000 Zn:5 Zd:5',
  syntax: '<Zd.tszlo>, <Zn.tszlo[imm2+tsz]>',
  valid: (f) => f.tsz !== 0,
  desc: T('把 Zn 的一个元素复制到 Zd 的每个元素（编号超出向量长度时得 0）', 'Broadcast one element of Zn to every element of Zd (zero when the index is past the vector length)'),
  exec(c, f) {
    const all = (f.imm2! << 5) | f.tsz!
    const es = 31 - Math.clz32(f.tsz! & -f.tsz!)
    const idx = all >> (es + 1)
    const z = zget(c, f.Zn!, es)
    zset(c, f.Zd!, new Array(z.length).fill(idx < z.length ? z[idx]! : 0n), es)
  },
})
ALIASES.push(
  {
    id: 'sve-mov-dup-scalar',
    of: 'sve-dup-idx',
    mnemonic: 'mov',
    syntax: '<Zd.tszlo>, <Vn.tszlo>',
    encode(f) {
      f.Zn = f.Vn!
      f.tsz = 1 << f._es!
      f.imm2 = 0
    },
    decode(f) {
      f.Vn = f.Zn!
    },
    prefer: (f) => ((f.imm2! << 5) | f.tsz!) >> (31 - Math.clz32(f.tsz! & -f.tsz!) + 1) === 0,
  },
  { id: 'sve-mov-dup-idx', of: 'sve-dup-idx', mnemonic: 'mov', syntax: '<Zd.tszlo>, <Zn.tszlo[imm2+tsz]>' },
)

function lookup(c: Cpu, f: Fields, regs: number, keep: boolean): void {
  const es = f.size!
  const table: bigint[] = []
  for (let r = 0; r < regs; r++) table.push(...zget(c, (f.Zn! + r) % 32, es))
  const idx = zget(c, f.Zm!, es)
  const old = keep ? zget(c, f.Zd!, es) : null
  zset(c, f.Zd!, idx.map((k, i) => (k < BigInt(table.length) ? table[Number(k)]! : old ? old[i]! : 0n)), es)
}
INSTRS.push(
  {
    id: 'sve-tbl',
    mnemonic: 'tbl',
    group: G,
    feature: 'sve',
    bits: '00000101 size:2 1 Zm:5 001100 Zn:5 Zd:5',
    syntax: '<Zd.size>, <L:Zn:1:size>, <Zm.size>',
    desc: T('查表：Zd 的元素 i = Zn 的第 Zm[i] 个元素（超出范围得 0）', 'Table lookup: element i of Zd = element Zm[i] of Zn (zero when out of range)'),
    exec: (c, f) => lookup(c, f, 1, false),
  },
  {
    id: 'sve-tbl2',
    mnemonic: 'tbl',
    group: G,
    feature: 'sve2',
    bits: '00000101 size:2 1 Zm:5 001010 Zn:5 Zd:5',
    syntax: '<Zd.size>, <L:Zn:2:size>, <Zm.size>',
    desc: T('两个寄存器的查表：表是 Zn、Zn+1 连起来', 'Table lookup in two registers: the table is Zn followed by Zn+1'),
    exec: (c, f) => lookup(c, f, 2, false),
  },
  {
    id: 'sve-tbx',
    mnemonic: 'tbx',
    group: G,
    feature: 'sve2',
    bits: '00000101 size:2 1 Zm:5 001011 Zn:5 Zd:5',
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc: T('查表，超出范围的元素保持 Zd 原值', 'Table lookup; out-of-range elements keep Zd'),
    exec: (c, f) => lookup(c, f, 1, true),
  },
)

INSTRS.push({
  id: 'sve-dup-scalar',
  mnemonic: 'dup',
  group: G,
  feature: 'sve',
  bits: '00000101 size:2 100000 001110 Rn:5 Zd:5',
  syntax: '<Zd.size>, <Rn|SP:size>',
  desc: T('把通用寄存器复制到每个元素', 'Broadcast a general register to every element'),
  exec(c, f) {
    const es = f.size!
    zset(c, f.Zd!, new Array(count(c, es)).fill(rget(c, f.Rn!, es, true)), es)
  },
})
ALIASES.push({ id: 'sve-mov-dup-r', of: 'sve-dup-scalar', mnemonic: 'mov', syntax: '<Zd.size>, <Rn|SP:size>' })

const insert = (c: Cpu, d: number, es: number, v: bigint) => {
  const z = zget(c, d, es)
  zset(c, d, [v, ...z.slice(0, -1)], es)
}
INSTRS.push(
  {
    id: 'sve-insr-r',
    mnemonic: 'insr',
    group: G,
    feature: 'sve',
    bits: '00000101 size:2 100100 001110 Rm:5 Zdn:5',
    syntax: '<Zdn.size>, <Rm:size>',
    desc: T('元素整体上移一位，通用寄存器放进元素 0', 'Shift the elements up by one and put a general register in element 0'),
    exec: (c, f) => insert(c, f.Zdn!, f.size!, rget(c, f.Rm!, f.size!, false)),
  },
  {
    id: 'sve-insr-v',
    mnemonic: 'insr',
    group: G,
    feature: 'sve',
    bits: '00000101 size:2 110100 001110 Vm:5 Zdn:5',
    syntax: '<Zdn.size>, <Vm.size>',
    desc: T('元素整体上移一位，标量 SIMD&FP 寄存器放进元素 0', 'Shift the elements up by one and put a scalar SIMD&FP register in element 0'),
    exec: (c, f) => insert(c, f.Zdn!, f.size!, c.vget(f.Vm!, ESIZE[f.size!]! / 8)),
  },
)

for (const [U, H] of [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
] as const) {
  const m = `${U ? 'u' : 's'}unpk${H ? 'hi' : 'lo'}`
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `00000101 size:2 1100${U}${H} 001110 Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size-1>',
    valid: sizes('hsd'),
    desc: T(`把 Zn ${H ? '高' : '低'}半部分的元素${U ? '零' : '符号'}扩展成两倍宽`, `${U ? 'Zero' : 'Sign'}-extend the elements of the ${H ? 'high' : 'low'} half of Zn to twice their width`),
    exec(c, f) {
      const es = f.size!
      const src = zget(c, f.Zn!, es - 1)
      const half = src.length / 2
      const part = H ? src.slice(half) : src.slice(0, half)
      zset(c, f.Zd!, part.map((v) => ux(U ? v : sx(v, es - 1), es)), es)
    },
  })
}

INSTRS.push({
  id: 'sve-rev',
  mnemonic: 'rev',
  group: G,
  feature: 'sve',
  bits: '00000101 size:2 111000 001110 Zn:5 Zd:5',
  syntax: '<Zd.size>, <Zn.size>',
  desc: T('元素倒序', 'Reverse the order of the elements'),
  exec: (c, f) => zset(c, f.Zd!, zget(c, f.Zn!, f.size!).reverse(), f.size!),
})

/* ------------------------------------------------------------------ interleaving */

/** ZIP1/ZIP2, UZP1/UZP2, TRN1/TRN2 of two arrays of elements. */
function permute(op: number, a: bigint[], b: bigint[]): bigint[] {
  const n = a.length
  const out: bigint[] = new Array(n)
  const half = n / 2
  for (let i = 0; i < n; i++) {
    const k = i >> 1
    switch (op) {
      case 0: // zip1
        out[i] = i & 1 ? b[k]! : a[k]!
        break
      case 1: // zip2
        out[i] = i & 1 ? b[half + k]! : a[half + k]!
        break
      case 2: // uzp1
      case 3: {
        const j = 2 * i + (op - 2)
        out[i] = j < n ? a[j]! : b[j - n]!
        break
      }
      case 4: // trn1
      case 5: {
        const o = op - 4
        out[i] = i & 1 ? b[(i & ~1) + o]! : a[(i & ~1) + o]!
        break
      }
    }
  }
  return out
}
const PERM_NAMES = ['zip1', 'zip2', 'uzp1', 'uzp2', 'trn1', 'trn2']
const PERM_DESC = [
  T('交错两个向量的低半部分：Zn[0], Zm[0], Zn[1], Zm[1], …', 'Interleave the low halves: Zn[0], Zm[0], Zn[1], Zm[1], …'),
  T('交错两个向量的高半部分', 'Interleave the high halves'),
  T('取 Zn:Zm 的偶数号元素', 'The even-numbered elements of Zn:Zm'),
  T('取 Zn:Zm 的奇数号元素', 'The odd-numbered elements of Zn:Zm'),
  T('交错两个向量的偶数号元素：Zn[0], Zm[0], Zn[2], Zm[2], …', 'Interleave the even elements: Zn[0], Zm[0], Zn[2], Zm[2], …'),
  T('交错两个向量的奇数号元素', 'Interleave the odd elements'),
]

PERM_NAMES.forEach((m, op) => {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `00000101 size:2 1 Zm:5 011 ${bin(op, 3)} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc: PERM_DESC[op]!,
    exec: (c, f) => zset(c, f.Zd!, permute(op, zget(c, f.Zn!, f.size!), zget(c, f.Zm!, f.size!)), f.size!),
  })
  INSTRS.push({
    id: `sve-${m}-q`,
    mnemonic: m,
    group: G,
    feature: 'f64mm',
    bits: `00000101 101 Zm:5 000 ${bin(op < 4 ? op : op + 2, 3)} Zn:5 Zd:5`,
    syntax: '<Zd.q>, <Zn.q>, <Zm.q>',
    desc: T(`${PERM_DESC[op]!.zh}（128 位元素；向量至少要 256 位）`, `${PERM_DESC[op]!.en} (128-bit elements; needs a vector of at least 256 bits)`),
    exec(c, f) {
      if (c.vl < 32) c.undefinedInstr(L('128 位元素的交错要求向量至少 256 位', 'Interleaving 128-bit elements needs a vector of at least 256 bits'))
      zset(c, f.Zd!, permute(op, zget(c, f.Zn!, 4), zget(c, f.Zm!, 4)), 4)
    },
  })
  INSTRS.push({
    id: `sve-${m}-p`,
    mnemonic: m,
    group: 'svepred',
    feature: 'sve',
    bits: `00000101 size:2 10 Pm:4 010 ${bin(op >> 1, 2)} ${op & 1} 0 Pn:4 0 Pd:4`,
    syntax: '<Pd.size>, <Pn.size>, <Pm.size>',
    desc: PERM_DESC[op]!,
    exec(c, f) {
      // Predicate elements move as groups of bits (one bit per byte of the element).
      const g = ESIZE[f.size!]! / 8
      const groups = (bits: Uint8Array) => Array.from({ length: bits.length / g }, (_, i) => BigInt(bits.slice(i * g, i * g + g).reduce((v, b, k) => v | (b << k), 0)))
      const res = permute(op, groups(c.pread(f.Pn!)), groups(c.pread(f.Pm!)))
      const out = new Uint8Array(c.vl)
      res.forEach((v, i) => {
        for (let k = 0; k < g; k++) out[i * g + k] = Number((v >> BigInt(k)) & 1n)
      })
      c.pwrite(f.Pd!, out)
    },
  })
})

INSTRS.push(
  {
    id: 'sve-rev-p',
    mnemonic: 'rev',
    group: 'svepred',
    feature: 'sve',
    bits: '00000101 size:2 110100 010000 0 Pn:4 0 Pd:4',
    syntax: '<Pd.size>, <Pn.size>',
    desc: T('谓词的元素倒序', 'Reverse the order of the predicate elements'),
    exec(c, f) {
      const g = ESIZE[f.size!]! / 8
      const bits = c.pread(f.Pn!)
      const n = bits.length / g
      const out = new Uint8Array(c.vl)
      for (let i = 0; i < n; i++) for (let k = 0; k < g; k++) out[i * g + k] = bits[(n - 1 - i) * g + k]!
      c.pwrite(f.Pd!, out)
    },
  },
  ...[0, 1].map(
    (H): InstrSpec => ({
      id: `sve-punpk${H ? 'hi' : 'lo'}`,
      mnemonic: `punpk${H ? 'hi' : 'lo'}`,
      group: 'svepred',
      feature: 'sve',
      bits: `00000101 001 1000 ${H} 0100000 Pn:4 0 Pd:4`,
      syntax: '<Pd.h>, <Pn.b>',
      desc: T(`把谓词${H ? '高' : '低'}半部分的字节元素展开成半字元素`, `Unpack the byte elements of the ${H ? 'high' : 'low'} half of a predicate to halfword elements`),
      exec(c, f) {
        const bits = c.pread(f.Pn!)
        const half = c.vl / 2
        const out = new Uint8Array(c.vl)
        for (let i = 0; i < half; i++) out[2 * i] = bits[(H ? half : 0) + i]!
        c.pwrite(f.Pd!, out)
      },
    }),
  ),
)

/* ------------------------------------------------------------------ predicated copies and extraction */

INSTRS.push(
  {
    id: 'sve-cpy-v',
    mnemonic: 'cpy',
    group: G,
    feature: 'sve',
    bits: '00000101 size:2 100000 100 Pg:3 Vn:5 Zd:5',
    syntax: '<Zd.size>, <Pg/m>, <Vn.size>',
    desc: T('把标量 SIMD&FP 寄存器复制到活跃元素', 'Copy a scalar SIMD&FP register into the active elements'),
    exec(c, f) {
      const es = f.size!
      const v = c.vget(f.Vn!, ESIZE[es]! / 8)
      predicated(c, f.Zd!, es, pget(c, f.Pg!, es), true, () => v)
    },
  },
  {
    id: 'sve-cpy-r',
    mnemonic: 'cpy',
    group: G,
    feature: 'sve',
    bits: '00000101 size:2 101000 101 Pg:3 Rn:5 Zd:5',
    syntax: '<Zd.size>, <Pg/m>, <Rn|SP:size>',
    desc: T('把通用寄存器复制到活跃元素', 'Copy a general register into the active elements'),
    exec(c, f) {
      const es = f.size!
      const v = rget(c, f.Rn!, es, true)
      predicated(c, f.Zd!, es, pget(c, f.Pg!, es), true, () => v)
    },
  },
)
ALIASES.push(
  { id: 'sve-mov-cpy-v', of: 'sve-cpy-v', mnemonic: 'mov', syntax: '<Zd.size>, <Pg/m>, <Vn.size>' },
  { id: 'sve-mov-cpy-r', of: 'sve-cpy-r', mnemonic: 'mov', syntax: '<Zd.size>, <Pg/m>, <Rn|SP:size>' },
)

INSTRS.push({
  id: 'sve-compact',
  mnemonic: 'compact',
  group: G,
  feature: 'sve',
  bits: '00000101 1 sz 100001 100 Pg:3 Zn:5 Zd:5',
  syntax: '<Zd.sz+2>, <Pg>, <Zn.sz+2>',
  desc: T('把活跃元素依次放到最低的位置，其余元素清零', 'Pack the active elements into the lowest positions, zeroing the rest'),
  exec(c, f) {
    const es = f.sz! + 2
    const pg = pget(c, f.Pg!, es)
    const z = zget(c, f.Zn!, es)
    const out = z.filter((_, i) => pg[i])
    while (out.length < z.length) out.push(0n)
    zset(c, f.Zd!, out, es)
  },
})

/** The element LASTA (after the last active one, wrapping) or LASTB (the last active one) picks. */
function lastIndex(pg: boolean[], after: boolean): number {
  const last = pg.lastIndexOf(true)
  if (after) return last + 1 >= pg.length ? 0 : last + 1
  return last < 0 ? pg.length - 1 : last
}

for (const B of [0, 1]) {
  const m = B ? 'lastb' : 'lasta'
  const what = B ? T('最后一个活跃元素', 'the last active element') : T('最后一个活跃元素之后的那个元素（没有活跃元素时取元素 0）', 'the element after the last active one (element 0 when none is active)')
  INSTRS.push(
    {
      id: `sve-${m}-v`,
      mnemonic: m,
      group: G,
      feature: 'sve',
      bits: `00000101 size:2 1 0001 ${B} 100 Pg:3 Zn:5 Vd:5`,
      syntax: '<Vd.size>, <Pg>, <Zn.size>',
      desc: T(`取出${what.zh}放进标量寄存器`, `Extract ${what.en} into a scalar register`),
      exec(c, f) {
        const es = f.size!
        const z = zget(c, f.Zn!, es)
        c.vset(f.Vd!, ESIZE[es]! / 8, z[lastIndex(pget(c, f.Pg!, es), !B)]!)
      },
    },
    {
      id: `sve-${m}-r`,
      mnemonic: m,
      group: G,
      feature: 'sve',
      bits: `00000101 size:2 1 0000 ${B} 101 Pg:3 Zn:5 Rd:5`,
      syntax: '<Rd:size>, <Pg>, <Zn.size>',
      desc: T(`取出${what.zh}放进通用寄存器`, `Extract ${what.en} into a general register`),
      exec(c, f) {
        const es = f.size!
        const z = zget(c, f.Zn!, es)
        c.setX(f.Rd!, z[lastIndex(pget(c, f.Pg!, es), !B)]!)
      },
    },
  )
  const cm = B ? 'clastb' : 'clasta'
  const cwhat = B ? T('最后一个活跃元素', 'the last active element') : T('最后一个活跃元素之后的元素', 'the element after the last active one')
  INSTRS.push(
    {
      id: `sve-${cm}-z`,
      mnemonic: cm,
      group: G,
      feature: 'sve',
      bits: `00000101 size:2 1 0100 ${B} 100 Pg:3 Zm:5 Zdn:5`,
      syntax: '<Zdn.size>, <Pg>, <Zdn.size>, <Zm.size>',
      desc: T(`有活跃元素时，把 Zm 中${cwhat.zh}复制到 Zdn 的每个元素；没有时 Zdn 不变`, `When some element is active, broadcast ${cwhat.en} of Zm to Zdn; otherwise Zdn is unchanged`),
      exec(c, f) {
        const es = f.size!
        const pg = pget(c, f.Pg!, es)
        const old = zget(c, f.Zdn!, es)
        const z = zget(c, f.Zm!, es)
        if (!pg.includes(true)) return zset(c, f.Zdn!, old, es)
        zset(c, f.Zdn!, new Array(z.length).fill(z[lastIndex(pg, !B)]!), es)
      },
    },
    {
      id: `sve-${cm}-v`,
      mnemonic: cm,
      group: G,
      feature: 'sve',
      bits: `00000101 size:2 1 0101 ${B} 100 Pg:3 Zm:5 Vdn:5`,
      syntax: '<Vdn.size>, <Pg>, <Vdn.size>, <Zm.size>',
      desc: T(`有活跃元素时取出 Zm 中${cwhat.zh}，没有时保留 Vdn 的原值`, `Extract ${cwhat.en} of Zm, or keep Vdn when no element is active`),
      exec(c, f) {
        const es = f.size!
        const pg = pget(c, f.Pg!, es)
        const z = zget(c, f.Zm!, es)
        const bytes = ESIZE[es]! / 8
        c.vset(f.Vdn!, bytes, pg.includes(true) ? z[lastIndex(pg, !B)]! : c.vget(f.Vdn!, bytes))
      },
    },
    {
      id: `sve-${cm}-r`,
      mnemonic: cm,
      group: G,
      feature: 'sve',
      bits: `00000101 size:2 1 1000 ${B} 101 Pg:3 Zm:5 Rdn:5`,
      syntax: '<Rdn:size>, <Pg>, <Rdn:size>, <Zm.size>',
      desc: T(`有活跃元素时取出 Zm 中${cwhat.zh}，没有时保留 Rdn 的低位（零扩展）`, `Extract ${cwhat.en} of Zm, or keep the low bits of Rdn (zero-extended) when no element is active`),
      exec(c, f) {
        const es = f.size!
        const pg = pget(c, f.Pg!, es)
        const z = zget(c, f.Zm!, es)
        c.setX(f.Rdn!, pg.includes(true) ? z[lastIndex(pg, !B)]! : ux(c.x(f.Rdn!), es))
      },
    },
  )
}

/** SPLICE: the active segment of the first vector (first to last active element), then the second from element 0. */
function splice(c: Cpu, f: Fields, first: number, second: number, d: number): void {
  const es = f.size!
  const pg = pget(c, f.Pg!, es)
  const a = zget(c, first, es)
  const b = zget(c, second, es)
  const lo = pg.indexOf(true)
  const out = lo < 0 ? [] : a.slice(lo, pg.lastIndexOf(true) + 1)
  for (let i = 0; out.length < a.length; i++) out.push(b[i]!)
  zset(c, d, out, es)
}
INSTRS.push(
  {
    id: 'sve-splice',
    mnemonic: 'splice',
    group: G,
    feature: 'sve',
    bits: '00000101 size:2 1 01100 100 Pg:3 Zm:5 Zdn:5',
    syntax: '<Zdn.size>, <Pg>, <Zdn.size>, <Zm.size>',
    desc: T('拼接：Zdn 从第一个到最后一个活跃元素的那一段，后面接 Zm 的开头', 'Splice: the segment of Zdn from its first to its last active element, followed by the start of Zm'),
    exec: (c, f) => splice(c, f, f.Zdn!, f.Zm!, f.Zdn!),
  },
  {
    id: 'sve-splice-con',
    mnemonic: 'splice',
    group: G,
    feature: 'sve2',
    bits: '00000101 size:2 1 01101 100 Pg:3 Zn:5 Zd:5',
    syntax: '<Zd.size>, <Pg>, <L:Zn:2:size>',
    desc: T('拼接：Zn 从第一个到最后一个活跃元素的那一段，后面接 Zn+1 的开头', 'Splice: the segment of Zn from its first to its last active element, followed by the start of Zn+1'),
    exec: (c, f) => splice(c, f, f.Zn!, (f.Zn! + 1) % 32, f.Zd!),
  },
)

/** Reverse the units of `bits` within each element. */
function revWithin(v: bigint, es: number, bits: number): bigint {
  const n = ESIZE[es]! / bits
  const m = (1n << BigInt(bits)) - 1n
  let r = 0n
  for (let i = 0; i < n; i++) r |= ((v >> BigInt(i * bits)) & m) << BigInt((n - 1 - i) * bits)
  return r
}
const REVS: [number, string, number, string, Text][] = [
  [0b00, 'revb', 8, 'hsd', T('把每个活跃元素里的字节倒序', 'Reverse the bytes within each active element')],
  [0b01, 'revh', 16, 'sd', T('把每个活跃元素里的半字倒序', 'Reverse the halfwords within each active element')],
  [0b10, 'revw', 32, 'd', T('把每个活跃元素里的字倒序', 'Reverse the words within each active element')],
]
for (const [opc, m, bits, sz, desc] of REVS) {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `00000101 size:2 1001 ${bin(opc, 2)} 100 Pg:3 Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Pg/m>, <Zn.size>',
    valid: sizes(sz),
    desc,
    exec(c, f) {
      const es = f.size!
      const z = zget(c, f.Zn!, es)
      predicated(c, f.Zd!, es, pget(c, f.Pg!, es), true, (i) => revWithin(z[i]!, es, bits))
    },
  })
}
INSTRS.push(
  {
    id: 'sve-rbit',
    mnemonic: 'rbit',
    group: G,
    feature: 'sve',
    bits: '00000101 size:2 100111 100 Pg:3 Zn:5 Zd:5',
    syntax: '<Zd.size>, <Pg/m>, <Zn.size>',
    desc: T('把每个活跃元素的位倒序', 'Reverse the bits of each active element'),
    exec(c, f) {
      const es = f.size!
      const z = zget(c, f.Zn!, es)
      predicated(c, f.Zd!, es, pget(c, f.Pg!, es), true, (i) => rbit(z[i]!, es))
    },
  },
  {
    id: 'sve-revd',
    mnemonic: 'revd',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '00000101 00 101110 100 Pg:3 Zn:5 Zd:5',
    syntax: '<Zd.q>, <Pg/m>, <Zn.q>',
    desc: T('交换每个活跃 128 位元素里的两个 64 位半部分', 'Swap the two 64-bit halves of each active 128-bit element'),
    exec(c, f) {
      const z = zget(c, f.Zn!, 4)
      predicated(c, f.Zd!, 4, pget(c, f.Pg!, 4), true, (i) => revWithin(z[i]!, 4, 64))
    },
  },
)

INSTRS.push({
  id: 'sve-sel',
  mnemonic: 'sel',
  group: G,
  feature: 'sve',
  bits: '00000101 size:2 1 Zm:5 11 Pg:4 Zn:5 Zd:5',
  syntax: '<Zd.size>, <Pg>, <Zn.size>, <Zm.size>',
  desc: T('按谓词选择：活跃元素取 Zn，其余取 Zm', 'Select by predicate: Zn in active elements, Zm elsewhere'),
  exec(c, f) {
    const es = f.size!
    const pg = pget(c, f.Pg!, es)
    const a = zget(c, f.Zn!, es)
    const b = zget(c, f.Zm!, es)
    zset(c, f.Zd!, a.map((x, i) => (pg[i] ? x : b[i]!)), es)
  },
})
ALIASES.push({
  id: 'sve-mov-sel',
  of: 'sve-sel',
  mnemonic: 'mov',
  syntax: '<Zd.size>, <Pg/m>, <Zn.size>',
  encode: (f) => void (f.Zm = f.Zd),
  prefer: (f) => f.Zd === f.Zm,
})

/* ------------------------------------------------------------------ SVE2.1 permutes within 128-bit segments */

/** Apply fn to each 128-bit segment's elements. */
function bySegment(c: Cpu, es: number, n: number[], fn: (segs: bigint[][], seg: number) => bigint[]): bigint[] {
  const per = 128 / ESIZE[es]!
  const regs = n.map((r) => zget(c, r, es))
  const out: bigint[] = []
  for (let s = 0; s < c.vl / 16; s++) out.push(...fn(regs.map((z) => z.slice(s * per, (s + 1) * per)), s))
  return out
}

INSTRS.push(
  {
    id: 'sve-dupq',
    mnemonic: 'dupq',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '00000101 001 tsz:5 001001 Zn:5 Zd:5',
    syntax: '<Zd.tszlo>, <Zn.tszlo[tsz]>',
    valid: (f) => (f.tsz! & 15) !== 0,
    desc: T('在每个 128 位段里，把段内第 imm 个元素复制到整段', 'In each 128-bit segment, broadcast element imm of the segment'),
    exec(c, f) {
      const es = 31 - Math.clz32(f.tsz! & -f.tsz!)
      const idx = f.tsz! >> (es + 1)
      zset(c, f.Zd!, bySegment(c, es, [f.Zn!], ([seg]) => seg!.map(() => seg![idx]!)), es)
    },
  },
  {
    id: 'sve-extq',
    mnemonic: 'extq',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '00000101 011 0 imm4:4 001001 Zm:5 Zdn:5',
    syntax: '<Zdn.b>, <Zdn.b>, <Zm.b>, #<u:imm4>',
    desc: T('在每个 128 位段里，从 Zdn:Zm 这一段拼接的字节里第 imm 个起取 16 个字节', 'In each 128-bit segment, take 16 bytes starting at byte imm of the segments of Zdn:Zm'),
    exec(c, f) {
      const k = f.imm4!
      zset(c, f.Zdn!, bySegment(c, 0, [f.Zdn!, f.Zm!], ([a, b]) => Array.from({ length: 16 }, (_, i) => (k + i < 16 ? a![k + i]! : b![k + i - 16]!))), 0)
    },
  },
  {
    id: 'sve-tblq',
    mnemonic: 'tblq',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '01000100 size:2 0 Zm:5 111110 Zn:5 Zd:5',
    syntax: '<Zd.size>, <L:Zn:1:size>, <Zm.size>',
    desc: T('在每个 128 位段里查表：表是 Zn 的同一段，超出范围得 0', 'Table lookup within each 128-bit segment of Zn; out of range gives zero'),
    exec(c, f) {
      const es = f.size!
      const table = zget(c, f.Zn!, es)
      const per = 128 / ESIZE[es]!
      // Each index selects from the same segment as the index (the table is the matching segment of Zn).
      zset(c, f.Zd!, bySegment(c, es, [f.Zm!], ([idx], s) => idx!.map((k) => (k < BigInt(per) ? table[s * per + Number(k)]! : 0n))), es)
    },
  },
  {
    id: 'sve-tbxq',
    mnemonic: 'tbxq',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '00000101 size:2 1 Zm:5 001101 Zn:5 Zd:5',
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc: T('在每个 128 位段里查表，超出范围的元素保持 Zd 原值', 'Table lookup within each 128-bit segment; out of range keeps Zd'),
    exec(c, f) {
      const es = f.size!
      const table = zget(c, f.Zn!, es)
      const per = 128 / ESIZE[es]!
      zset(c, f.Zd!, bySegment(c, es, [f.Zm!, f.Zd!], ([idx, old], s) => idx!.map((k, i) => (k < BigInt(per) ? table[s * per + Number(k)]! : old![i]!))), es)
    },
  },
)
;['zipq1', 'zipq2', 'uzpq1', 'uzpq2'].forEach((m, op) => {
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: 'sve2',
    feature: 'sve2p1',
    bits: `01000100 size:2 0 Zm:5 1110 ${bin(op, 2)} Zn:5 Zd:5`,
    syntax: '<Zd.size>, <Zn.size>, <Zm.size>',
    desc: T(`在每个 128 位段里做 ${PERM_NAMES[op]}`, `${PERM_NAMES[op]} within each 128-bit segment`),
    exec(c, f) {
      const es = f.size!
      zset(c, f.Zd!, bySegment(c, es, [f.Zn!, f.Zm!], ([a, b]) => permute(op, a!, b!)), es)
    },
  })
})

