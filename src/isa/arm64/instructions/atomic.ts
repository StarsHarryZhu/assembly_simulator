/**
 * Synchronization: exclusive loads and stores (LDXR/STXR and pairs), load-acquire and store-release
 * (LDAR, STLR, LDAPR, LDLAR, STLLR, LDAPUR, STLUR), and the LSE atomics (CAS, CASP, SWP, LDADD and the
 * other read-modify-write operations, with their ST* aliases).
 *
 * The machine runs one core in order, so ordering is automatic; what remains is the value semantics, the
 * exclusive monitor and the alignment rules. Fields the architecture says should be all ones (Rs, Rt2 of
 * forms that do not use them) are decoded whatever they hold, as LLVM does, and assembled as 31.
 */
import { L, T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import { ACC, type Cpu, type Fields } from './types'
import { M64, sext } from './util'

const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')
const SUFFIX = ['b', 'h', '', '']
const ORDER = ['', 'a', 'l', 'al']
const rt = (size: number) => (size === 3 ? 'X' : 'W')
const mask = (size: number) => (1n << BigInt(8 << size)) - 1n
const sbo = (...names: string[]) => (f: Fields) => {
  for (const n of names) f[n] ??= 31
}

/** STXR's status register must differ from the registers it stores and from the base (UNPREDICTABLE otherwise). */
function statusCheck(f: Fields): string | void {
  if (f.Rs === f.Rt || (f.Rt2 !== undefined && f.Rs === f.Rt2 && f.Rt2 !== 31) || (f.Rs === f.Rn && f.Rn !== 31))
    return L('状态寄存器 Ws 不能和要存的寄存器或基址相同（结果不可预测）', 'The status register Ws cannot be a source or the base (UNPREDICTABLE)')
}

/** Why LDXP with Rt = Rt2 does not run (inside the loop below, `L` is a field). */
const samePair = () => L('两个目标寄存器相同', 'both destinations are the same register')

const SIZE_TEXT = (size: number): Text => [T('字节', 'byte'), T('半字', 'halfword'), T('字', 'word'), T('双字', 'doubleword')][size]!

const INSTRS_: InstrSpec[] = []

/* ------------------------------------------------------------------ exclusive */

for (let size = 0; size < 4; size++) {
  const r = rt(size)
  const bytes = 1 << size
  for (const [L, o0] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    const m = `${L ? (o0 ? 'ldaxr' : 'ldxr') : o0 ? 'stlxr' : 'stxr'}${SUFFIX[size]}`
    INSTRS_.push({
      id: `${m}-${size}`,
      mnemonic: m,
      group: 'atomic',
      bits: `${bin(size, 2)} 001000 0 ${L} 0 Rs:5 ${o0} Rt2:5 Rn:5 Rt:5`,
      syntax: L ? `<${r}t>, [<Xn|SP>{, #0}]` : `<Ws>, <${r}t>, [<Xn|SP>{, #0}]`,
      encode: sbo(...(L ? ['Rs', 'Rt2'] : ['Rt2'])),
      check: L ? undefined : statusCheck,
      desc: L
        ? T(`独占读一个${SIZE_TEXT(size).zh}${o0 ? '（带获取语义）' : ''}，并开始监视这个地址`, `Load-exclusive a ${SIZE_TEXT(size).en}${o0 ? ' with acquire' : ''}, and start monitoring the address`)
        : T(`独占写${o0 ? '（带释放语义）' : ''}：地址仍被监视才写入，Ws = 0 表示成功、1 表示失败`, `Store-exclusive${o0 ? ' with release' : ''}: writes only if the address is still monitored; Ws = 0 on success, 1 on failure`),
      exec: (c, f) => {
        const addr = c.base(f.Rn!)
        if (L) {
          const v = c.load(addr, bytes, ACC.aligned)
          c.markExclusive(addr, bytes)
          c.setR(size === 3 ? 1 : 0, f.Rt!, v)
        } else {
          const ok = c.checkExclusive(addr, bytes)
          if (ok) c.store(addr, bytes, c.x(f.Rt!), ACC.aligned)
          c.setR(0, f.Rs!, ok ? 0n : 1n)
        }
      },
    })
  }
}

for (let sz = 0; sz < 2; sz++) {
  const r = sz ? 'X' : 'W'
  const bytes = sz ? 8 : 4
  for (const [L, o0] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    const m = L ? (o0 ? 'ldaxp' : 'ldxp') : o0 ? 'stlxp' : 'stxp'
    INSTRS_.push({
      id: `${m}-${sz}`,
      mnemonic: m,
      group: 'atomic',
      bits: `1 ${sz} 001000 0 ${L} 1 Rs:5 ${o0} Rt2:5 Rn:5 Rt:5`,
      syntax: L ? `<${r}t>, <${r}t2>, [<Xn|SP>{, #0}]` : `<Ws>, <${r}t>, <${r}t2>, [<Xn|SP>{, #0}]`,
      encode: L ? sbo('Rs') : undefined,
      check: L ? undefined : statusCheck,
      desc: L ? T(`独占读两个寄存器${o0 ? '（带获取语义）' : ''}`, `Load-exclusive a pair${o0 ? ' with acquire' : ''}`) : T(`独占写两个寄存器${o0 ? '（带释放语义）' : ''}：Ws = 0 表示成功`, `Store-exclusive a pair${o0 ? ' with release' : ''}: Ws = 0 on success`),
      exec: (c, f) => {
        // Loading one register twice is CONSTRAINED UNPREDICTABLE; clang accepts it, and Apple's CPUs make it undefined, as we do.
        if (L && f.Rt === f.Rt2) c.undefinedInstr(samePair())
        const addr = c.base(f.Rn!)
        if (L) {
          // The pair is one access of twice the size: aligned to that.
          c.load(addr, 2 * bytes, ACC.aligned)
          const a = c.load(addr, bytes)
          const b = c.load((addr + BigInt(bytes)) & M64, bytes)
          c.markExclusive(addr, 2 * bytes)
          c.setR(sz, f.Rt!, a)
          c.setR(sz, f.Rt2!, b)
        } else {
          const ok = c.checkExclusive(addr, 2 * bytes)
          if (ok) {
            const v1 = c.x(f.Rt!)
            const v2 = c.x(f.Rt2!)
            c.load(addr, 2 * bytes, ACC.aligned)
            c.store(addr, bytes, v1)
            c.store((addr + BigInt(bytes)) & M64, bytes, v2)
          }
          c.setR(0, f.Rs!, ok ? 0n : 1n)
        }
      },
    })
  }
}

/* ------------------------------------------------------------------ acquire / release */

for (let size = 0; size < 4; size++) {
  const r = rt(size)
  const bytes = 1 << size
  for (const [L, o0, m, desc] of [
    [0, 0, 'stllr', T('有限区域内的释放写（这里等同 stlr）', 'Store LORelease (here the same as stlr)')],
    [0, 1, 'stlr', T('释放写：之前的内存访问都完成后才写入', 'Store-release: written after all earlier memory accesses')],
    [1, 0, 'ldlar', T('有限区域内的获取读（这里等同 ldar）', 'Load LOAcquire (here the same as ldar)')],
    [1, 1, 'ldar', T('获取读：之后的内存访问不会提前到它前面', 'Load-acquire: later memory accesses are not moved before it')],
  ] as const) {
    INSTRS_.push({
      id: `${m}${SUFFIX[size]}-${size}`,
      mnemonic: `${m}${SUFFIX[size]}`,
      group: 'atomic',
      bits: `${bin(size, 2)} 001000 1 ${L} 0 Rs:5 ${o0} Rt2:5 Rn:5 Rt:5`,
      syntax: `<${r}t>, [<Xn|SP>{, #0}]`,
      encode: sbo('Rs', 'Rt2'),
      desc,
      exec: (c, f) => {
        const addr = c.base(f.Rn!)
        if (L) c.setR(size === 3 ? 1 : 0, f.Rt!, c.load(addr, bytes, ACC.lse2))
        else c.store(addr, bytes, c.x(f.Rt!), ACC.lse2)
      },
    })
  }
  INSTRS_.push({
    id: `ldapr${SUFFIX[size]}-${size}`,
    mnemonic: `ldapr${SUFFIX[size]}`,
    group: 'atomic',
    feature: 'rcpc',
    bits: `${bin(size, 2)} 111 0 00 1 0 1 11111 1 100 00 Rn:5 Rt:5`,
    syntax: `<${r}t>, [<Xn|SP>{, #0}]`,
    desc: T('获取读（处理器一致性版本，比 ldar 约束少）', 'Load-acquire RCpc (weaker than ldar)'),
    exec: (c, f) => c.setR(size === 3 ? 1 : 0, f.Rt!, c.load(c.base(f.Rn!), bytes, ACC.lse2)),
  })
}

/** RCPC2: unscaled acquire/release, with signed loads. */
const RCPC2: [number, number, string, number, boolean][] = [
  [0, 0, 'stlurb', 0, false],
  [0, 1, 'ldapurb', 0, false],
  [0, 2, 'ldapursb', 1, true],
  [0, 3, 'ldapursb', 0, true],
  [1, 0, 'stlurh', 0, false],
  [1, 1, 'ldapurh', 0, false],
  [1, 2, 'ldapursh', 1, true],
  [1, 3, 'ldapursh', 0, true],
  [2, 0, 'stlur', 0, false],
  [2, 1, 'ldapur', 0, false],
  [2, 2, 'ldapursw', 1, true],
  [3, 0, 'stlur', 1, false],
  [3, 1, 'ldapur', 1, false],
]
for (const [size, opc, m, x, isSigned] of RCPC2) {
  const bytes = 1 << size
  INSTRS_.push({
    id: `${m}-${size}-${opc}`,
    mnemonic: m,
    group: 'atomic',
    feature: 'rcpc2',
    bits: `${bin(size, 2)} 011001 ${bin(opc, 2)} 0 imm9:9 00 Rn:5 Rt:5`,
    syntax: `<${x ? 'X' : 'W'}t>, [<Xn|SP>{, #<s:imm9>}]`,
    desc: opc === 0 ? T('释放写，地址 = Xn + 偏移（−256 到 255）', 'Store-release at Xn + an offset (−256 to 255)') : T(`获取读，地址 = Xn + 偏移${isSigned ? '，符号扩展' : ''}`, `Load-acquire at Xn + an offset${isSigned ? ', sign-extended' : ''}`),
    exec: (c, f) => {
      const addr = (c.base(f.Rn!) + BigInt(sext(f.imm9!, 9))) & M64
      if (opc === 0) c.store(addr, bytes, c.x(f.Rt!), ACC.lse2)
      else {
        const v = c.load(addr, bytes, ACC.lse2)
        c.setR(x, f.Rt!, isSigned ? BigInt.asUintN(64, BigInt.asIntN(8 * bytes, v)) : v)
      }
    },
  })
}

/* ------------------------------------------------------------------ CAS, CASP */

for (let size = 0; size < 4; size++) {
  const r = rt(size)
  const bytes = 1 << size
  for (const [L, o0] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const m = `cas${ORDER[L + 2 * o0]}${SUFFIX[size]}`
    INSTRS_.push({
      id: `${m}-${size}`,
      mnemonic: m,
      group: 'atomic',
      feature: 'lse',
      // LLVM decodes CAS only with Rt2 = 31.
      bits: `${bin(size, 2)} 001000 1 ${L} 1 Rs:5 ${o0} 11111 Rn:5 Rt:5`,
      syntax: `<${r}s>, <${r}t>, [<Xn|SP>{, #0}]`,
      desc: T(`比较并交换：内存里的值等于 Rs 时写入 Rt；Rs 总是得到原来的值${L || o0 ? '（带' + (L ? '获取' : '') + (L && o0 ? '和' : '') + (o0 ? '释放' : '') + '语义）' : ''}`, `Compare and swap: if memory equals Rs, write Rt; Rs always gets the old value${L || o0 ? ` (${[L ? 'acquire' : '', o0 ? 'release' : ''].filter(Boolean).join(' and ')})` : ''}`),
      exec: (c, f) => {
        const addr = c.base(f.Rn!)
        const cmp = c.x(f.Rs!) & mask(size)
        const nv = c.x(f.Rt!)
        const old = c.load(addr, bytes, ACC.lse2)
        if (old === cmp) c.store(addr, bytes, nv, ACC.lse2)
        c.setR(size === 3 ? 1 : 0, f.Rs!, old)
      },
    })
  }
}

for (let sz = 0; sz < 2; sz++) {
  const r = sz ? 'X' : 'W'
  const bytes = sz ? 8 : 4
  for (const [L, o0] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const m = `casp${ORDER[L + 2 * o0]}`
    INSTRS_.push({
      id: `${m}-${sz}`,
      mnemonic: m,
      group: 'atomic',
      feature: 'lse',
      bits: `0 ${sz} 001000 0 ${L} 1 Rs:5 ${o0} 11111 Rn:5 Rt:5`,
      syntax: `<${r}s>, <${r}s+1>, <${r}t>, <${r}t+1>, [<Xn|SP>{, #0}]`,
      valid: (f) => f.Rs! % 2 === 0 && f.Rt! % 2 === 0,
      desc: T('成对比较并交换：内存里的两个值等于 Rs、Rs+1 时写入 Rt、Rt+1', 'Compare and swap a pair: if memory equals Rs, Rs+1, write Rt, Rt+1'),
      exec: (c, f) => {
        const addr = c.base(f.Rn!)
        const a2 = (addr + BigInt(bytes)) & M64
        const m = mask(sz ? 3 : 2)
        const s0 = c.x(f.Rs!) & m
        const s1 = c.x((f.Rs! + 1) & 31) & m
        const t0 = c.x(f.Rt!)
        const t1 = c.x((f.Rt! + 1) & 31)
        c.load(addr, 2 * bytes, ACC.aligned)
        const o0v = c.load(addr, bytes)
        const o1v = c.load(a2, bytes)
        if (o0v === s0 && o1v === s1) {
          c.store(addr, bytes, t0)
          c.store(a2, bytes, t1)
        }
        c.setR(sz, f.Rs!, o0v)
        c.setR(sz, (f.Rs! + 1) & 31, o1v)
      },
    })
  }
}

/* ------------------------------------------------------------------ LSE read-modify-write */

const OPS: [string, (a: bigint, b: bigint, size: number) => bigint, Text][] = [
  ['add', (a, b, s) => (a + b) & mask(s), T('加', 'add')],
  ['clr', (a, b) => a & ~b, T('清除位（与非）', 'bit clear')],
  ['eor', (a, b) => a ^ b, T('异或', 'exclusive OR')],
  ['set', (a, b) => a | b, T('置位（或）', 'bit set (OR)')],
  ['smax', (a, b, s) => (BigInt.asIntN(8 << s, a) > BigInt.asIntN(8 << s, b) ? a : b), T('有符号最大值', 'signed maximum')],
  ['smin', (a, b, s) => (BigInt.asIntN(8 << s, a) < BigInt.asIntN(8 << s, b) ? a : b), T('有符号最小值', 'signed minimum')],
  ['umax', (a, b) => (a > b ? a : b), T('无符号最大值', 'unsigned maximum')],
  ['umin', (a, b) => (a < b ? a : b), T('无符号最小值', 'unsigned minimum')],
]

function rmw(c: Cpu, f: Fields, size: number, op: (old: bigint, v: bigint, size: number) => bigint) {
  const addr = c.base(f.Rn!)
  const bytes = 1 << size
  const v = c.x(f.Rs!) & mask(size)
  const old = c.load(addr, bytes, ACC.lse2)
  c.store(addr, bytes, op(old, v, size) & mask(size), ACC.lse2)
  c.setR(size === 3 ? 1 : 0, f.Rt!, old)
}

for (let size = 0; size < 4; size++) {
  const r = rt(size)
  for (let ar = 0; ar < 4; ar++) {
    const A = ar & 1
    const R = ar >> 1
    OPS.forEach(([name, op, what], opc) => {
      const m = `ld${name}${ORDER[ar]}${SUFFIX[size]}`
      INSTRS_.push({
        id: `${m}-${size}`,
        mnemonic: m,
        group: 'atomic',
        feature: 'lse',
        bits: `${bin(size, 2)} 111 0 00 ${A} ${R} 1 Rs:5 0 ${bin(opc, 3)} 00 Rn:5 Rt:5`,
        syntax: `<${r}s>, <${r}t>, [<Xn|SP>]`,
        desc: T(`原子操作：内存 = 内存 ${what.zh} Rs，Rt 得到原来的值`, `Atomic ${what.en}: memory = memory ${what.en} Rs; Rt gets the old value`),
        exec: (c, f) => rmw(c, f, size, op),
      })
    })
    const m = `swp${ORDER[ar]}${SUFFIX[size]}`
    INSTRS_.push({
      id: `${m}-${size}`,
      mnemonic: m,
      group: 'atomic',
      feature: 'lse',
      bits: `${bin(size, 2)} 111 0 00 ${A} ${R} 1 Rs:5 1 000 00 Rn:5 Rt:5`,
      syntax: `<${r}s>, <${r}t>, [<Xn|SP>]`,
      desc: T('原子交换：内存 = Rs，Rt 得到原来的值', 'Atomic swap: memory = Rs; Rt gets the old value'),
      exec: (c, f) => rmw(c, f, size, (_old, v) => v),
    })
  }
}

export const INSTRS = INSTRS_

/** STADD and friends: the atomic operations without a result (Rt = zero register), no acquire. */
export const ALIASES: AliasSpec[] = []
for (let size = 0; size < 4; size++) {
  for (const R of [0, 1]) {
    for (const [name, , what] of OPS) {
      const of = `ld${name}${ORDER[2 * R]}${SUFFIX[size]}-${size}`
      const m = `st${name}${R ? 'l' : ''}${SUFFIX[size]}`
      ALIASES.push({ id: m + `-${size}`, of, mnemonic: m, syntax: `<${rt(size)}s>, [<Xn|SP>]`, fixed: { Rt: 31 }, desc: T(`原子操作，不要结果：内存 = 内存 ${what.zh} Rs`, `Atomic ${what.en} without a result: memory = memory ${what.en} Rs`) })
    }
  }
}
