/**
 * SVE loads and stores: contiguous LD1/ST1 (scalar plus immediate in multiples of the vector, scalar plus
 * scalar), first-fault LDFF1 and non-fault LDNF1 (which clear FFR from the first element they could not
 * load instead of faulting), non-temporal LDNT1/STNT1, broadcasts (LD1R, LD1RQ, LD1RO), structures
 * (LD2–LD4, ST2–ST4), gathers and scatters (vector of addresses plus an immediate, scalar plus a vector of
 * 32-bit or 64-bit offsets, optionally scaled), prefetches (PRFB…PRFD, no effect here), LDR/STR of whole Z
 * and P registers, and the SVE2.1 128-bit element forms (LD1W/LD1D/ST1W/ST1D .q, LD2Q–LD4Q, LD1Q/ST1Q).
 */
import { L, T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { ESIZE, lanesAt, storeLanes, sx, ux } from './vec'
import { count, pget, zget, zset } from './zvec'

export const INSTRS: InstrSpec[] = []
export const ALIASES: AliasSpec[] = []
const G = 'sveload'
const M64 = (1n << 64n) - 1n
const LET = 'bhsdq'
const BYTES_TEXT = ['字节', '半字', '字', '双字', '四字']
const BYTES_EN = ['bytes', 'halfwords', 'words', 'doublewords', 'quadwords']

const addr = (a: bigint, b: bigint) => (a + b) & M64

/* ------------------------------------------------------------------ element access */

type Kind = 'normal' | 'ff' | 'nf'

/**
 * Load elements of size es (memory size mb bytes, sign- or zero-extended) into Zt: active elements from
 * addrOf(e), inactive ones zero. First-fault loads take a fault only on the first active element; there
 * and in non-fault loads, an element that cannot be loaded clears FFR from that element on, and the
 * elements from there are zero.
 */
function loadElems(c: Cpu, t: number, es: number, mb: number, signed: boolean, pg: boolean[], addrOf: (e: number) => bigint, kind: Kind = 'normal'): void {
  const out: bigint[] = []
  let first = kind === 'ff'
  let faultAt = -1
  pg.forEach((on, e) => {
    if (faultAt >= 0 || !on) return void out.push(0n)
    let v: bigint | null
    if (kind === 'normal' || first) {
      v = c.load(addrOf(e), mb)
      first = false
    } else v = c.tryLoad(addrOf(e), mb)
    if (v === null) {
      faultAt = e
      return void out.push(0n)
    }
    out.push(signed ? ux(BigInt.asIntN(mb * 8, v), es) : v)
  })
  zset(c, t, out, es)
  if (faultAt >= 0) {
    const ffr = c.pread(16)
    ffr.fill(0, faultAt * (ESIZE[es]! / 8))
    c.pwrite(16, ffr)
  }
}

/** Store the low mb bytes of Zt's active elements of size es to addrOf(e). */
function storeElems(c: Cpu, t: number, es: number, mb: number, pg: boolean[], addrOf: (e: number) => bigint): void {
  const vals = zget(c, t, es)
  const mask = (1n << BigInt(mb * 8)) - 1n
  pg.forEach((on, e) => {
    if (on) c.store(addrOf(e), mb, vals[e]! & mask)
  })
}

/**
 * loadElems and storeElems for consecutive elements from `base`. When the whole block can be read (or, for
 * a store with every element active, written), no element can fault, so it moves at once; otherwise the
 * elements go one at a time as above.
 */
function loadContig(c: Cpu, t: number, es: number, mb: number, signed: boolean, pg: boolean[], base: bigint, kind: Kind = 'normal'): void {
  const block = c.loadBlock(base, pg.length * mb)
  if (!block) return loadElems(c, t, es, mb, signed, pg, (e) => addr(base, BigInt(e * mb)), kind)
  const vals = lanesAt(block, 0, pg.length, 31 - Math.clz32(mb))
  for (let e = 0; e < vals.length; e++) vals[e] = !pg[e] ? 0n : signed ? ux(BigInt.asIntN(mb * 8, vals[e]!), es) : vals[e]!
  zset(c, t, vals, es)
}
function storeContig(c: Cpu, t: number, es: number, mb: number, pg: boolean[], base: bigint): void {
  if (pg.every(Boolean)) {
    const block = new Uint8Array(pg.length * mb)
    storeLanes(zget(c, t, es), 31 - Math.clz32(mb), block, 0)
    if (c.storeBlock(base, block)) return
  }
  storeElems(c, t, es, mb, pg, (e) => addr(base, BigInt(e * mb)))
}

/** Elements of es in one vector. */
const elemsOf = (c: Cpu, es: number) => count(c, es)
/** The byte size of what one register of a contiguous access transfers: elements × memory size. */
const span = (c: Cpu, es: number, mb: number) => BigInt(elemsOf(c, es) * mb)
/** A signed immediate field's value. */
const simm = (v: number, bits: number) => BigInt.asIntN(bits, BigInt(v))

/* ------------------------------------------------------------------ contiguous LD1, LDFF1, LDNF1, ST1 */

interface Dt {
  /** Mnemonic suffix: b, sb, h, sh, w, sw, d. */
  name: string
  msz: number
  es: number
  signed: boolean
}
/** The dtype field of the contiguous loads and LD1R: memory size, element size and extension. */
const DTYPE: Dt[] = [
  [0, 0, false],
  [0, 1, false],
  [0, 2, false],
  [0, 3, false],
  [2, 3, true],
  [1, 1, false],
  [1, 2, false],
  [1, 3, false],
  [1, 3, true],
  [1, 2, true],
  [2, 2, false],
  [2, 3, false],
  [0, 3, true],
  [0, 2, true],
  [0, 1, true],
  [3, 3, false],
].map(([msz, es, signed]) => ({ name: `${signed ? 's' : ''}${'bhwd'[msz as number]}`, msz: msz as number, es: es as number, signed: signed as boolean }))

const list = (n: number, es: number, field = 'Zt') => `<L:${field}:${n}:${LET[es]}>`
const lslOf = (k: number) => (k ? `, lsl #${k}` : '')
const loadDesc = (d: Dt, how: Text, extra?: Text) =>
  T(
    `把内存里连续的${d.signed ? '有符号' : '无符号'}${BYTES_TEXT[d.msz]}${d.es > d.msz ? `（${d.signed ? '符号' : '零'}扩展成 ${ESIZE[d.es]} 位）` : ''}读进 Zt 的活跃元素，其余元素清零；地址是 ${how.zh}${extra ? '。' + extra.zh : ''}`,
    `Load consecutive ${d.signed ? 'signed' : 'unsigned'} ${BYTES_EN[d.msz]}${d.es > d.msz ? ` (${d.signed ? 'sign' : 'zero'}-extended to ${ESIZE[d.es]} bits)` : ''} into the active elements of Zt, zeroing the others; the address is ${how.en}${extra ? '. ' + extra.en : ''}`,
  )
const HOW_IMM = T('Xn + imm × 一个向量传输的字节数', 'Xn + imm × the bytes one vector transfers')
const HOW_REG = (k: number) => T(`Xn + Xm${k ? ` × ${1 << k}` : ''}`, `Xn + Xm${k ? ` × ${1 << k}` : ''}`)
const FF_TEXT = T('首次故障：只有第一个活跃元素出错时才触发异常，后面的元素读不到时从那里起清除 FFR 并停下', 'First-fault: only the first active element takes a fault; when a later element cannot be read, FFR is cleared from there on and loading stops')
const NF_TEXT = T('不触发异常：读不到的元素从那里起清除 FFR 并停下', 'Non-fault: no element takes a fault; from the first one that cannot be read, FFR is cleared and loading stops')

DTYPE.forEach((d, dtype) => {
  const dt = dtype.toString(2).padStart(4, '0')
  const mb = 1 << d.msz
  const contig = (c: Cpu, f: Fields, base: bigint, kind: Kind) => loadContig(c, f.Zt!, d.es, mb, d.signed, pget(c, f.Pg!, d.es), base, kind)
  const immBase = (c: Cpu, f: Fields) => addr(c.base(f.Rn!), simm(f.imm4!, 4) * span(c, d.es, mb))
  const regBase = (c: Cpu, f: Fields) => addr(c.base(f.Rn!), c.x(f.Rm!) << BigInt(d.msz))
  INSTRS.push(
    {
      id: `sve-ld1${d.name}-${LET[d.es]}-imm`,
      mnemonic: `ld1${d.name}`,
      group: G,
      feature: 'sve',
      bits: `1010010 ${dt} 0 imm4:4 101 Pg:3 Rn:5 Zt:5`,
      syntax: `${list(1, d.es)}, <Pg/z>, [<Xn|SP>{, #<s:imm4>, mul vl}]`,
      desc: loadDesc(d, HOW_IMM),
      exec: (c, f) => contig(c, f, immBase(c, f), 'normal'),
    },
    {
      id: `sve-ld1${d.name}-${LET[d.es]}-reg`,
      mnemonic: `ld1${d.name}`,
      group: G,
      feature: 'sve',
      bits: `1010010 ${dt} Rm:5 010 Pg:3 Rn:5 Zt:5`,
      syntax: `${list(1, d.es)}, <Pg/z>, [<Xn|SP>, <Xm>${lslOf(d.msz)}]`,
      valid: (f) => f.Rm !== 31,
      desc: loadDesc(d, HOW_REG(d.msz)),
      exec: (c, f) => contig(c, f, regBase(c, f), 'normal'),
    },
    {
      id: `sve-ldff1${d.name}-${LET[d.es]}`,
      mnemonic: `ldff1${d.name}`,
      group: G,
      feature: 'sve',
      bits: `1010010 ${dt} Rm:5 011 Pg:3 Rn:5 Zt:5`,
      syntax: `${list(1, d.es)}, <Pg/z>, [<Xn|SP>{, <Xm=31>${lslOf(d.msz)}}]`,
      desc: loadDesc(d, HOW_REG(d.msz), FF_TEXT),
      exec: (c, f) => contig(c, f, regBase(c, f), 'ff'),
    },
    {
      id: `sve-ldnf1${d.name}-${LET[d.es]}`,
      mnemonic: `ldnf1${d.name}`,
      group: G,
      feature: 'sve',
      bits: `1010010 ${dt} 1 imm4:4 101 Pg:3 Rn:5 Zt:5`,
      syntax: `${list(1, d.es)}, <Pg/z>, [<Xn|SP>{, #<s:imm4>, mul vl}]`,
      desc: loadDesc(d, HOW_IMM, NF_TEXT),
      exec: (c, f) => contig(c, f, immBase(c, f), 'nf'),
    },
  )
})

// ST1: memory size msz, element size `size` (at least msz); st1w/st1d of 128-bit elements use the size
// slots that would be narrower than the memory size.
for (let msz = 0; msz < 4; msz++) {
  for (let size = 0; size < 4; size++) {
    let es = size
    let feature = 'sve'
    if (size < msz) {
      if ((msz === 2 && size === 0) || (msz === 3 && size === 2)) {
        es = 4
        feature = 'sve2p1'
      } else continue
    }
    const mb = 1 << msz
    const m = `st1${'bhwd'[msz]}`
    const desc = (how: Text) => T(`把 Zt 活跃元素的低 ${mb * 8} 位存到内存里连续的${BYTES_TEXT[msz]}；地址是 ${how.zh}`, `Store the low ${mb * 8} bits of Zt's active elements to consecutive ${BYTES_EN[msz]}; the address is ${how.en}`)
    const run = (c: Cpu, f: Fields, base: bigint) => storeContig(c, f.Zt!, es, mb, pget(c, f.Pg!, es), base)
    INSTRS.push(
      {
        id: `sve-${m}-${LET[es]}-imm`,
        mnemonic: m,
        group: G,
        feature,
        bits: `1110010 ${msz.toString(2).padStart(2, '0')} ${size.toString(2).padStart(2, '0')} 0 imm4:4 111 Pg:3 Rn:5 Zt:5`,
        syntax: `${list(1, es)}, <Pg>, [<Xn|SP>{, #<s:imm4>, mul vl}]`,
        desc: desc(HOW_IMM),
        exec: (c, f) => run(c, f, addr(c.base(f.Rn!), simm(f.imm4!, 4) * span(c, es, mb))),
      },
      {
        id: `sve-${m}-${LET[es]}-reg`,
        mnemonic: m,
        group: G,
        feature,
        bits: `1110010 ${msz.toString(2).padStart(2, '0')} ${size.toString(2).padStart(2, '0')} Rm:5 010 Pg:3 Rn:5 Zt:5`,
        syntax: `${list(1, es)}, <Pg>, [<Xn|SP>, <Xm>${lslOf(msz)}]`,
        valid: (f) => f.Rm !== 31,
        desc: desc(HOW_REG(msz)),
        exec: (c, f) => run(c, f, addr(c.base(f.Rn!), c.x(f.Rm!) << BigInt(msz))),
      },
    )
  }
}

// LD1W/LD1D into 128-bit elements (SVE2.1): each word or doubleword zero-extended.
for (const [sz, msz] of [
  [0, 2],
  [1, 3],
] as const) {
  const mb = 1 << msz
  const m = `ld1${'wd'[sz]}`
  const d: Dt = { name: 'wd'[sz]!, msz, es: 4, signed: false }
  const run = (c: Cpu, f: Fields, base: bigint) => loadContig(c, f.Zt!, 4, mb, false, pget(c, f.Pg!, 4), base)
  INSTRS.push(
    {
      id: `sve-${m}-q-imm`,
      mnemonic: m,
      group: G,
      feature: 'sve2p1',
      bits: `1010010 1 ${sz} 00 1 imm4:4 001 Pg:3 Rn:5 Zt:5`,
      syntax: `${list(1, 4)}, <Pg/z>, [<Xn|SP>{, #<s:imm4>, mul vl}]`,
      desc: loadDesc(d, HOW_IMM),
      exec: (c, f) => run(c, f, addr(c.base(f.Rn!), simm(f.imm4!, 4) * span(c, 4, mb))),
    },
    {
      id: `sve-${m}-q-reg`,
      mnemonic: m,
      group: G,
      feature: 'sve2p1',
      bits: `1010010 1 ${sz} 00 Rm:5 100 Pg:3 Rn:5 Zt:5`,
      syntax: `${list(1, 4)}, <Pg/z>, [<Xn|SP>, <Xm>${lslOf(msz)}]`,
      valid: (f) => f.Rm !== 31,
      desc: loadDesc(d, HOW_REG(msz)),
      exec: (c, f) => run(c, f, addr(c.base(f.Rn!), c.x(f.Rm!) << BigInt(msz))),
    },
  )
}

/* ------------------------------------------------------------------ non-temporal contiguous */

for (let msz = 0; msz < 4; msz++) {
  const mb = 1 << msz
  const b2 = msz.toString(2).padStart(2, '0')
  const L_ = LET[msz]!
  const hint = T('（不常用的数据：提示缓存不必保留）', ' (non-temporal: a hint that the data need not stay in the caches)')
  const ld = (c: Cpu, f: Fields, base: bigint) => loadContig(c, f.Zt!, msz, mb, false, pget(c, f.Pg!, msz), base)
  const st = (c: Cpu, f: Fields, base: bigint) => storeContig(c, f.Zt!, msz, mb, pget(c, f.Pg!, msz), base)
  INSTRS.push(
    {
      id: `sve-ldnt1${'bhwd'[msz]}-imm`,
      mnemonic: `ldnt1${'bhwd'[msz]}`,
      group: G,
      feature: 'sve',
      bits: `1010010 ${b2} 000 imm4:4 111 Pg:3 Rn:5 Zt:5`,
      syntax: `<L:Zt:1:${L_}>, <Pg/z>, [<Xn|SP>{, #<s:imm4>, mul vl}]`,
      desc: T(loadDesc(DTYPE.find((x) => x.msz === msz && x.es === msz && !x.signed)!, HOW_IMM).zh + hint.zh, loadDesc(DTYPE.find((x) => x.msz === msz && x.es === msz && !x.signed)!, HOW_IMM).en + hint.en),
      exec: (c, f) => ld(c, f, addr(c.base(f.Rn!), simm(f.imm4!, 4) * span(c, msz, mb))),
    },
    {
      id: `sve-ldnt1${'bhwd'[msz]}-reg`,
      mnemonic: `ldnt1${'bhwd'[msz]}`,
      group: G,
      feature: 'sve',
      bits: `1010010 ${b2} 00 Rm:5 110 Pg:3 Rn:5 Zt:5`,
      syntax: `<L:Zt:1:${L_}>, <Pg/z>, [<Xn|SP>, <Xm>${lslOf(msz)}]`,
      valid: (f) => f.Rm !== 31,
      desc: T(loadDesc(DTYPE.find((x) => x.msz === msz && x.es === msz && !x.signed)!, HOW_REG(msz)).zh + hint.zh, loadDesc(DTYPE.find((x) => x.msz === msz && x.es === msz && !x.signed)!, HOW_REG(msz)).en + hint.en),
      exec: (c, f) => ld(c, f, addr(c.base(f.Rn!), c.x(f.Rm!) << BigInt(msz))),
    },
    {
      id: `sve-stnt1${'bhwd'[msz]}-imm`,
      mnemonic: `stnt1${'bhwd'[msz]}`,
      group: G,
      feature: 'sve',
      bits: `1110010 ${b2} 00 1 imm4:4 111 Pg:3 Rn:5 Zt:5`,
      syntax: `<L:Zt:1:${L_}>, <Pg>, [<Xn|SP>{, #<s:imm4>, mul vl}]`,
      desc: T(`把 Zt 的活跃元素存到内存里连续的${BYTES_TEXT[msz]}；地址是 ${HOW_IMM.zh}${hint.zh}`, `Store the active elements of Zt to consecutive ${BYTES_EN[msz]}; the address is ${HOW_IMM.en}${hint.en}`),
      exec: (c, f) => st(c, f, addr(c.base(f.Rn!), simm(f.imm4!, 4) * span(c, msz, mb))),
    },
    {
      id: `sve-stnt1${'bhwd'[msz]}-reg`,
      mnemonic: `stnt1${'bhwd'[msz]}`,
      group: G,
      feature: 'sve',
      bits: `1110010 ${b2} 00 Rm:5 011 Pg:3 Rn:5 Zt:5`,
      syntax: `<L:Zt:1:${L_}>, <Pg>, [<Xn|SP>, <Xm>${lslOf(msz)}]`,
      valid: (f) => f.Rm !== 31,
      desc: T(`把 Zt 的活跃元素存到内存里连续的${BYTES_TEXT[msz]}；地址是 ${HOW_REG(msz).zh}${hint.zh}`, `Store the active elements of Zt to consecutive ${BYTES_EN[msz]}; the address is ${HOW_REG(msz).en}${hint.en}`),
      exec: (c, f) => st(c, f, addr(c.base(f.Rn!), c.x(f.Rm!) << BigInt(msz))),
    },
  )
}

/* ------------------------------------------------------------------ broadcasts */

DTYPE.forEach((d, dtype) => {
  const mb = 1 << d.msz
  INSTRS.push({
    id: `sve-ld1r${d.name}-${LET[d.es]}`,
    mnemonic: `ld1r${d.name}`,
    group: G,
    feature: 'sve',
    bits: `1000010 ${(dtype >> 2).toString(2).padStart(2, '0')} 1 imm6:6 1 ${(dtype & 3).toString(2).padStart(2, '0')} Pg:3 Rn:5 Zt:5`,
    syntax: `${list(1, d.es)}, <Pg/z>, [<Xn|SP>{, #<u:imm6*${mb}>}]`,
    desc: T(`从 Xn + imm 读一个${d.signed ? '有符号' : '无符号'}${BYTES_TEXT[d.msz].replace('字节', '字节')}，复制到 Zt 的每个活跃元素，其余元素清零（没有活跃元素时不访问内存）`, `Load one ${d.signed ? 'signed' : 'unsigned'} ${BYTES_EN[d.msz].slice(0, -1)} from Xn + imm and copy it to every active element of Zt, zeroing the others (no access when no element is active)`),
    exec(c, f) {
      const pg = pget(c, f.Pg!, d.es)
      let v = 0n
      if (pg.includes(true)) {
        v = c.load(addr(c.base(f.Rn!), BigInt(f.imm6! * mb)), mb)
        if (d.signed) v = ux(BigInt.asIntN(mb * 8, v), d.es)
      }
      zset(c, f.Zt!, pg.map((on) => (on ? v : 0n)), d.es)
    },
  })
})

// LD1RQ (16 bytes) and LD1RO (32 bytes): one block loaded under the predicate's first block, then repeated.
for (const [ssz, bytes, m0, feature] of [
  [0, 16, 'ld1rq', 'sve'],
  [1, 32, 'ld1ro', 'f64mm'],
] as const) {
  for (let msz = 0; msz < 4; msz++) {
    const mb = 1 << msz
    const m = `${m0}${'bhwd'[msz]}`
    const b = `1010010 ${msz.toString(2).padStart(2, '0')} ${ssz.toString(2).padStart(2, '0')}`
    const run = (c: Cpu, f: Fields, base: bigint) => {
      if (bytes === 32 && c.vl < 32) c.undefinedInstr(L('LD1RO 要求向量至少 256 位', 'LD1RO needs a vector of at least 256 bits'))
      const per = bytes / mb
      const pg = pget(c, f.Pg!, msz).slice(0, per)
      const block = pg.map((on, e) => (on ? c.load(addr(base, BigInt(e * mb)), mb) : 0n))
      zset(c, f.Zt!, Array.from({ length: elemsOf(c, msz) }, (_, e) => block[e % per]!), msz)
    }
    const desc = (how: Text) => T(`读 ${bytes} 字节（前 ${bytes / mb} 个元素由 Pg 的前 ${bytes / mb} 个元素控制，不活跃的为 0），在 Zt 里每 ${bytes * 8} 位重复一次；地址是 ${how.zh}`, `Load ${bytes} bytes (the first ${bytes / mb} elements, under the first ${bytes / mb} elements of Pg, zero where inactive) and repeat them in every ${bytes * 8}-bit block of Zt; the address is ${how.en}`)
    INSTRS.push(
      {
        id: `sve-${m}-imm`,
        mnemonic: m,
        group: G,
        feature,
        bits: `${b} 0 imm4:4 001 Pg:3 Rn:5 Zt:5`,
        syntax: `${list(1, msz)}, <Pg/z>, [<Xn|SP>{, #<s:imm4*${bytes}>}]`,
        desc: desc(T(`Xn + imm（${bytes} 的倍数）`, `Xn + imm (a multiple of ${bytes})`)),
        exec: (c, f) => run(c, f, addr(c.base(f.Rn!), simm(f.imm4!, 4) * BigInt(bytes))),
      },
      {
        id: `sve-${m}-reg`,
        mnemonic: m,
        group: G,
        feature,
        bits: `${b} Rm:5 000 Pg:3 Rn:5 Zt:5`,
        syntax: `${list(1, msz)}, <Pg/z>, [<Xn|SP>, <Xm>${lslOf(msz)}]`,
        valid: (f) => f.Rm !== 31,
        desc: desc(HOW_REG(msz)),
        exec: (c, f) => run(c, f, addr(c.base(f.Rn!), c.x(f.Rm!) << BigInt(msz))),
      },
    )
  }
}

/* ------------------------------------------------------------------ structures */

/** LDn/STn: element e of register r is at base + (e × n + r) × mb. */
function structs(c: Cpu, f: Fields, n: number, es: number, mb: number, base: bigint, load: boolean): void {
  const pg = pget(c, f.Pg!, es)
  const regs = Array.from({ length: n }, (_, r) => (f.Zt! + r) % 32)
  const at = (e: number, r: number) => addr(base, BigInt((e * n + r) * mb))
  if (load) {
    const vals = regs.map((_, r) => pg.map((on, e) => (on ? c.load(at(e, r), mb) : 0n)))
    regs.forEach((z, r) => zset(c, z, vals[r]!, es))
  } else {
    const vals = regs.map((z) => zget(c, z, es))
    pg.forEach((on, e) => {
      if (on) regs.forEach((_, r) => c.store(at(e, r), mb, vals[r]![e]!))
    })
  }
}
const structDesc = (n: number, load: boolean, es: number, how: Text) =>
  load
    ? T(`读 ${n} 个一组交错存放的${BYTES_TEXT[es]}：每组的第 r 个放进第 r 个寄存器的同一元素（不活跃的元素清零）；地址是 ${how.zh}`, `Load ${n}-element structures of ${BYTES_EN[es]}: member r of each structure goes to the same element of register r (zero where inactive); the address is ${how.en}`)
    : T(`把 ${n} 个寄存器同一位置的活跃元素交错存成一组组${BYTES_TEXT[es]}；地址是 ${how.zh}`, `Store the active elements at each position of ${n} registers as interleaved structures of ${BYTES_EN[es]}; the address is ${how.en}`)
for (let n = 2; n <= 4; n++) {
  const nreg = (n - 1).toString(2).padStart(2, '0')
  for (let msz = 0; msz < 5; msz++) {
    const q = msz === 4
    const mb = 1 << msz
    const L_ = list(n, msz)
    const lsl = lslOf(msz)
    const immHow = T(`Xn + imm × 一个向量的字节数（imm 是 ${n} 的倍数）`, `Xn + imm × the bytes of one vector (imm a multiple of ${n})`)
    for (const load of [true, false]) {
      const m = `${load ? 'ld' : 'st'}${n}${'bhwdq'[msz]}`
      const feature = q ? 'sve2p1' : 'sve'
      const immBits = q ? (load ? `1010010 ${nreg} 00 1 imm4:4 111` : `1110010 0 ${nreg} 0 0 imm4:4 000`) : `${load ? '1010010' : '1110010'} ${msz.toString(2).padStart(2, '0')} ${nreg} ${load ? 0 : 1} imm4:4 111`
      const regBits = q ? (load ? `1010010 ${nreg} 01 Rm:5 100` : `1110010 0 ${nreg} 1 Rm:5 000`) : `${load ? '1010010' : '1110010'} ${msz.toString(2).padStart(2, '0')} ${nreg} Rm:5 ${load ? '110' : '011'}`
      const pg = load ? '<Pg/z>' : '<Pg>'
      INSTRS.push(
        {
          id: `sve-${m}-imm`,
          mnemonic: m,
          group: G,
          feature,
          bits: `${immBits} Pg:3 Rn:5 Zt:5`,
          syntax: `${L_}, ${pg}, [<Xn|SP>{, #<s:imm4*${n}>, mul vl}]`,
          desc: structDesc(n, load, msz, immHow),
          exec: (c, f) => structs(c, f, n, msz, mb, addr(c.base(f.Rn!), simm(f.imm4!, 4) * BigInt(n * c.vl)), load),
        },
        {
          id: `sve-${m}-reg`,
          mnemonic: m,
          group: G,
          feature,
          bits: `${regBits} Pg:3 Rn:5 Zt:5`,
          syntax: `${L_}, ${pg}, [<Xn|SP>, <Xm>${lsl}]`,
          valid: (f) => f.Rm !== 31,
          desc: structDesc(n, load, msz, HOW_REG(msz)),
          exec: (c, f) => structs(c, f, n, msz, mb, addr(c.base(f.Rn!), c.x(f.Rm!) << BigInt(msz)), load),
        },
      )
    }
  }
}

/* ------------------------------------------------------------------ gathers and scatters */

/** Offsets for gathers and scatters: a vector of 32-bit (extended by xs) or 64-bit offsets, scaled. */
type Off = { k: 'vec32'; scaled: boolean } | { k: 'vec64'; scaled: boolean } | { k: 'unpacked'; scaled: boolean } | { k: 'imm' } | { k: 'vecx' }
function gatherAddr(c: Cpu, f: Fields, off: Off, es: number, msz: number): (e: number) => bigint {
  const mb = 1 << msz
  if (off.k === 'imm' || off.k === 'vecx') {
    // A vector of addresses (32-bit ones zero-extended) plus an immediate or Xm.
    const Z = zget(c, f.Zn!, es)
    const plus = off.k === 'imm' ? BigInt(f.imm5! * mb) : c.x(f.Rm!)
    return (e) => addr(Z[e]!, plus)
  }
  const base = c.base(f.Rn!)
  const Z = zget(c, f.Zm!, es)
  const sh = BigInt(off.scaled ? msz : 0)
  if (off.k === 'vec64') return (e) => addr(base, (Z[e]! << sh) & M64)
  // 32-bit offsets, in .s elements or in the low half of .d elements: extended by xs.
  return (e) => {
    const v = Z[e]! & 0xffff_ffffn
    return addr(base, ((f.xs ? BigInt.asUintN(64, BigInt.asIntN(32, v)) : v) << sh) & M64)
  }
}
const offSyntax = (off: Off, es: number, msz: number) => {
  const z = es === 2 ? 's' : 'd'
  switch (off.k) {
    case 'imm':
      return `[<Zn.${z}>{, #<u:imm5*${1 << msz}>}]`
    case 'vecx':
      return `[<Zn.${z}>{, <Xm=31>}]`
    case 'vec64':
      return `[<Xn|SP>, <Zm.d>${off.scaled ? `, lsl #${msz}` : ''}]`
    default:
      return `[<Xn|SP>, <Zm.${z}>, <xs>${off.scaled ? ` #${msz}` : ''}]`
  }
}
const offText = (off: Off, es: number, msz: number): Text => {
  const sc = (k: boolean) => (k ? ` × ${1 << msz}` : '')
  switch (off.k) {
    case 'imm':
      return T(`Zn 的每个元素${es === 2 ? '（32 位地址）' : ''} + imm`, `each element of Zn${es === 2 ? ' (a 32-bit address)' : ''} + imm`)
    case 'vecx':
      return T('Zn 的每个元素 + Xm', 'each element of Zn + Xm')
    case 'vec64':
      return T(`Xn + Zm 的每个 64 位元素${sc(off.scaled)}`, `Xn + each 64-bit element of Zm${sc(off.scaled)}`)
    default:
      return T(`Xn + Zm 每个元素的低 32 位（按 uxtw/sxtw 扩展）${sc(off.scaled)}`, `Xn + the low 32 bits of each element of Zm (extended by uxtw/sxtw)${sc(off.scaled)}`)
  }
}

interface GForm {
  off: Off
  /** Bits 31:21 with msz as `MM`, and bits 15:13. */
  load: (msz: string, U: number, ff: number) => string
  store?: (msz: string) => string
}
// 32-bit elements.
const G32: GForm[] = [
  { off: { k: 'vec32', scaled: false }, load: (m, U, ff) => `1000010 ${m} xs 0 Zm:5 0 ${U} ${ff} Pg:3 Rn:5`, store: (m) => `1110010 ${m} 10 Zm:5 1 xs 0 Pg:3 Rn:5` },
  { off: { k: 'vec32', scaled: true }, load: (m, U, ff) => `1000010 ${m} xs 1 Zm:5 0 ${U} ${ff} Pg:3 Rn:5`, store: (m) => `1110010 ${m} 11 Zm:5 1 xs 0 Pg:3 Rn:5` },
  { off: { k: 'imm' }, load: (m, U, ff) => `1000010 ${m} 01 imm5:5 1 ${U} ${ff} Pg:3 Zn:5`, store: (m) => `1110010 ${m} 11 imm5:5 101 Pg:3 Zn:5` },
]
// 64-bit elements.
const G64: GForm[] = [
  { off: { k: 'unpacked', scaled: false }, load: (m, U, ff) => `1100010 ${m} xs 0 Zm:5 0 ${U} ${ff} Pg:3 Rn:5`, store: (m) => `1110010 ${m} 00 Zm:5 1 xs 0 Pg:3 Rn:5` },
  { off: { k: 'unpacked', scaled: true }, load: (m, U, ff) => `1100010 ${m} xs 1 Zm:5 0 ${U} ${ff} Pg:3 Rn:5`, store: (m) => `1110010 ${m} 01 Zm:5 1 xs 0 Pg:3 Rn:5` },
  { off: { k: 'vec64', scaled: false }, load: (m, U, ff) => `1100010 ${m} 10 Zm:5 1 ${U} ${ff} Pg:3 Rn:5`, store: (m) => `1110010 ${m} 00 Zm:5 101 Pg:3 Rn:5` },
  { off: { k: 'vec64', scaled: true }, load: (m, U, ff) => `1100010 ${m} 11 Zm:5 1 ${U} ${ff} Pg:3 Rn:5`, store: (m) => `1110010 ${m} 01 Zm:5 101 Pg:3 Rn:5` },
  { off: { k: 'imm' }, load: (m, U, ff) => `1100010 ${m} 01 imm5:5 1 ${U} ${ff} Pg:3 Zn:5`, store: (m) => `1110010 ${m} 10 imm5:5 101 Pg:3 Zn:5` },
]
for (const [es, forms] of [
  [2, G32],
  [3, G64],
] as const) {
  for (const form of forms) {
    const scaled = 'scaled' in form.off && form.off.scaled
    for (let msz = 0; msz <= es; msz++) {
      if (scaled && msz === 0) continue
      const mb = 1 << msz
      const mm = msz.toString(2).padStart(2, '0')
      const how = offText(form.off, es, msz)
      const syntax = offSyntax(form.off, es, msz)
      for (const U of [1, 0]) {
        if (!U && msz === es) continue
        for (const ff of [0, 1]) {
          const name = `${U ? '' : 's'}${'bhwd'[msz]}`
          const m = `ld${ff ? 'ff' : ''}1${name}`
          const d: Dt = { name, msz, es, signed: !U }
          INSTRS.push({
            id: `sve-${m}-${LET[es]}-g${form.off.k}${scaled ? "-sc" : ""}`,
            mnemonic: m,
            group: G,
            feature: 'sve',
            bits: `${form.load(mm, U, ff)} Zt:5`,
            syntax: `${list(1, es)}, <Pg/z>, ${syntax}`,
            desc: T(loadDesc(d, how, ff ? FF_TEXT : undefined).zh.replace('内存里连续的', '分散在各处的'), loadDesc(d, how, ff ? FF_TEXT : undefined).en.replace('consecutive ', 'scattered ')),
            exec: (c, f) => loadElems(c, f.Zt!, es, mb, !U, pget(c, f.Pg!, es), gatherAddr(c, f, form.off, es, msz), ff ? 'ff' : 'normal'),
          })
        }
      }
      if (form.store)
        INSTRS.push({
          id: `sve-st1${"bhwd"[msz]}-${LET[es]}-g${form.off.k}${scaled ? "-sc" : ""}`,
          mnemonic: `st1${'bhwd'[msz]}`,
          group: G,
          feature: 'sve',
          bits: `${form.store(mm)} Zt:5`,
          syntax: `${list(1, es)}, <Pg>, ${syntax}`,
          desc: T(`把 Zt 活跃元素的低 ${mb * 8} 位分别存到各自的地址：${how.zh}`, `Store the low ${mb * 8} bits of each active element of Zt to its own address: ${how.en}`),
          exec: (c, f) => storeElems(c, f.Zt!, es, mb, pget(c, f.Pg!, es), gatherAddr(c, f, form.off, es, msz)),
        })
    }
  }
}

// Non-temporal gathers and scatters (SVE2): a vector of addresses plus Xm.
for (const es of [2, 3]) {
  for (let msz = 0; msz <= es; msz++) {
    const mb = 1 << msz
    const mm = msz.toString(2).padStart(2, '0')
    const off: Off = { k: 'vecx' }
    const syntax = offSyntax(off, es, msz)
    for (const U of [1, 0]) {
      if (!U && msz === es) continue
      const name = `${U ? '' : 's'}${'bhwd'[msz]}`
      const d: Dt = { name, msz, es, signed: !U }
      INSTRS.push({
        id: `sve-ldnt1${name}-${LET[es]}-vec`,
        mnemonic: `ldnt1${name}`,
        group: G,
        feature: 'sve2',
        bits: `${es === 2 ? `1000010 ${mm} 00 Rm:5 1 0 ${U}` : `1100010 ${mm} 00 Rm:5 1 ${U} 0`} Pg:3 Zn:5 Zt:5`,
        syntax: `${list(1, es)}, <Pg/z>, ${syntax}`,
        desc: T(loadDesc(d, offText(off, es, msz)).zh.replace('内存里连续的', '分散在各处的'), loadDesc(d, offText(off, es, msz)).en.replace('consecutive ', 'scattered ')),
        exec: (c, f) => loadElems(c, f.Zt!, es, mb, !U, pget(c, f.Pg!, es), gatherAddr(c, f, off, es, msz)),
      })
    }
    INSTRS.push({
      id: `sve-stnt1${'bhwd'[msz]}-${LET[es]}-vec`,
      mnemonic: `stnt1${'bhwd'[msz]}`,
      group: G,
      feature: 'sve2',
      bits: `1110010 ${mm} ${es === 2 ? '10' : '00'} Rm:5 001 Pg:3 Zn:5 Zt:5`,
      syntax: `${list(1, es)}, <Pg>, ${syntax}`,
      desc: T(`把 Zt 活跃元素的低 ${mb * 8} 位分别存到 Zn 的元素 + Xm 处（不常用的数据）`, `Store the low ${mb * 8} bits of each active element of Zt at an element of Zn + Xm (non-temporal)`),
      exec: (c, f) => storeElems(c, f.Zt!, es, mb, pget(c, f.Pg!, es), gatherAddr(c, f, off, es, msz)),
    })
  }
}

// LD1Q/ST1Q (SVE2.1): 128-bit elements, each at the even 64-bit element of Zn plus Xm.
INSTRS.push(
  {
    id: 'sve-ld1q',
    mnemonic: 'ld1q',
    group: G,
    feature: 'sve2p1',
    bits: '11000100 000 Rm:5 101 Pg:3 Zn:5 Zt:5',
    syntax: `${list(1, 4)}, <Pg/z>, [<Zn.d>{, <Xm=31>}]`,
    desc: T('读 128 位元素：第 e 个从 Zn 的第 2e 个 64 位元素 + Xm 处读（不活跃的清零）', 'Gather 128-bit elements: element e from the 64-bit element 2e of Zn plus Xm (zero where inactive)'),
    exec(c, f) {
      const Z = zget(c, f.Zn!, 3)
      const plus = c.x(f.Rm!)
      loadElems(c, f.Zt!, 4, 16, false, pget(c, f.Pg!, 4), (e) => addr(Z[2 * e]!, plus))
    },
  },
  {
    id: 'sve-st1q',
    mnemonic: 'st1q',
    group: G,
    feature: 'sve2p1',
    bits: '1110010 00 01 Rm:5 001 Pg:3 Zn:5 Zt:5',
    syntax: `${list(1, 4)}, <Pg>, [<Zn.d>{, <Xm=31>}]`,
    desc: T('存 128 位元素：第 e 个存到 Zn 的第 2e 个 64 位元素 + Xm 处', 'Scatter 128-bit elements: element e to the 64-bit element 2e of Zn plus Xm'),
    exec(c, f) {
      const Z = zget(c, f.Zn!, 3)
      const plus = c.x(f.Rm!)
      storeElems(c, f.Zt!, 4, 16, pget(c, f.Pg!, 4), (e) => addr(Z[2 * e]!, plus))
    },
  },
)

/* ------------------------------------------------------------------ prefetch */

const PRF_DESC = (msz: number, how: Text) => T(`预取：提示 CPU 把活跃元素对应的${BYTES_TEXT[msz]}地址（${how.zh}）调进缓存；这里没有缓存，不起作用`, `Prefetch: a hint to bring the ${BYTES_EN[msz]} at the active elements' addresses (${how.en}) into the caches; with no caches here it does nothing`)
for (let msz = 0; msz < 4; msz++) {
  const m = `prf${'bhwd'[msz]}`
  const mm = msz.toString(2).padStart(2, '0')
  const forms: [string, string, string, Text][] = [
    ['imm', `1000010 111 imm6:6 0 ${mm} Pg:3 Rn:5 0 prfop:4`, '[<Xn|SP>{, #<s:imm6>, mul vl}]', HOW_IMM],
    ['reg', `1000010 ${mm} 00 Rm:5 110 Pg:3 Rn:5 0 prfop:4`, `[<Xn|SP>, <Xm>${lslOf(msz)}]`, HOW_REG(msz)],
    ['s-vec32', `1000010 00 xs 1 Zm:5 0 ${mm} Pg:3 Rn:5 0 prfop:4`, offSyntax({ k: 'vec32', scaled: true }, 2, msz).replace(' #0]', ']'), offText({ k: 'vec32', scaled: msz > 0 }, 2, msz)],
    ['s-imm', `1000010 ${mm} 00 imm5:5 111 Pg:3 Zn:5 0 prfop:4`, offSyntax({ k: 'imm' }, 2, msz), offText({ k: 'imm' }, 2, msz)],
    ['d-unpacked', `1100010 00 xs 1 Zm:5 0 ${mm} Pg:3 Rn:5 0 prfop:4`, offSyntax({ k: 'unpacked', scaled: true }, 3, msz).replace(' #0]', ']'), offText({ k: 'unpacked', scaled: msz > 0 }, 3, msz)],
    ['d-vec64', `1100010 00 11 Zm:5 1 ${mm} Pg:3 Rn:5 0 prfop:4`, offSyntax({ k: 'vec64', scaled: true }, 3, msz).replace(', lsl #0]', ']'), offText({ k: 'vec64', scaled: msz > 0 }, 3, msz)],
    ['d-imm', `1100010 ${mm} 00 imm5:5 111 Pg:3 Zn:5 0 prfop:4`, offSyntax({ k: 'imm' }, 3, msz), offText({ k: 'imm' }, 3, msz)],
  ]
  for (const [k, bits, mem, how] of forms)
    INSTRS.push({
      id: `sve-${m}-${k}`,
      mnemonic: m,
      group: G,
      feature: 'sve',
      bits,
      syntax: `<sveprf>, <Pg>, ${mem}`,
      valid: k === 'reg' ? (f) => f.Rm !== 31 : undefined,
      desc: PRF_DESC(msz, how),
      exec: () => {},
    })
}

/* ------------------------------------------------------------------ LDR and STR of whole registers */

/** Bytes of a predicate register: one bit per vector byte, packed eight to a byte. */
function packP(bits: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let k = 0; k < 8; k++) v |= (bits[i + k]! & 1) << k
    out.push(v)
  }
  return out
}
for (const [P, op] of [
  [false, '010'],
  [true, '000'],
] as const) {
  const reg = P ? '<Pt>' : '<Zt>'
  const tail = P ? 'Rn:5 0 Pt:4' : 'Rn:5 Zt:5'
  const what = P ? T('谓词寄存器（向量长度 / 8 字节）', 'a predicate register (vector length / 8 bytes)') : T('Z 寄存器（一个向量长度）', 'a Z register (one vector length)')
  const size = (c: Cpu) => (P ? c.vl / 8 : c.vl)
  const at = (c: Cpu, f: Fields) => addr(c.base(f.Rn!), simm((f.imm9h! << 3) | f.imm9l!, 9) * BigInt(size(c)))
  INSTRS.push(
    {
      id: `sve-ldr-${P ? 'p' : 'z'}`,
      mnemonic: 'ldr',
      group: G,
      feature: 'sve',
      bits: `1000010 110 imm9h:6 ${op} imm9l:3 ${tail}`,
      syntax: `${reg}, [<Xn|SP>{, #<ssplit:imm9h+imm9l>, mul vl}]`,
      desc: T(`从 Xn + imm × 寄存器大小处读出整个${what.zh}（不要求对齐）`, `Load ${what.en} from Xn + imm × its size (no alignment needed)`),
      exec(c, f) {
        const a = at(c, f)
        const bytes = Array.from({ length: size(c) }, (_, i) => Number(c.load(addr(a, BigInt(i)), 1)))
        if (P) c.pwrite(f.Pt!, Uint8Array.from({ length: c.vl }, (_, i) => (bytes[i >> 3]! >> (i & 7)) & 1))
        else c.vwrite(f.Zt!, Uint8Array.from(bytes))
      },
    },
    {
      id: `sve-str-${P ? 'p' : 'z'}`,
      mnemonic: 'str',
      group: G,
      feature: 'sve',
      bits: `1110010 110 imm9h:6 ${op} imm9l:3 ${tail}`,
      syntax: `${reg}, [<Xn|SP>{, #<ssplit:imm9h+imm9l>, mul vl}]`,
      desc: T(`把整个${what.zh}存到 Xn + imm × 寄存器大小处（不要求对齐）`, `Store ${what.en} at Xn + imm × its size (no alignment needed)`),
      exec(c, f) {
        const a = at(c, f)
        const bytes = P ? packP(c.pread(f.Pt!)) : Array.from(c.vread(f.Zt!, c.vl))
        bytes.forEach((b, i) => c.store(addr(a, BigInt(i)), 1, BigInt(b)))
      },
    },
  )
}
