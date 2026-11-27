/**
 * Loads and stores of general registers: every addressing mode (unsigned offset, unscaled, pre- and
 * post-index, register offset, literal), pairs, unprivileged forms, prefetch, the pointer-authenticating
 * LDRAA/LDRAB, and the memory copy and set instructions (MOPS). Exclusive, acquire/release and atomic
 * accesses are in atomic.ts.
 */
import { L, T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import { ACC, type Cpu, type Fields } from './types'
import { M64, sext } from './util'

const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')

/** What a (size, opc) pair does: a store, a load (zero- or sign-extended to W or X), or a prefetch. */
interface Kind {
  /** Mnemonic stem and suffix: str + b, ldrs + h, … */
  op: 'st' | 'ld' | 'lds' | 'prf'
  size: number
  /** Register width: 0 W, 1 X. */
  x: number
  suffix: string
}

function kindOf(size: number, opc: number): Kind | null {
  const suffix = ['b', 'h', '', ''][size]!
  if (opc === 0) return { op: 'st', size, x: size === 3 ? 1 : 0, suffix }
  if (opc === 1) return { op: 'ld', size, x: size === 3 ? 1 : 0, suffix }
  if (size === 3) return opc === 2 ? { op: 'prf', size, x: 1, suffix: '' } : null
  if (size === 2) return opc === 2 ? { op: 'lds', size, x: 1, suffix: 'w' } : null
  return { op: 'lds', size, x: opc === 2 ? 1 : 0, suffix }
}

const KINDS: [number, number][] = []
for (let size = 0; size < 4; size++) for (let opc = 0; opc < 4; opc++) if (kindOf(size, opc)) KINDS.push([size, opc])

/** The register operand for a kind's Rt. */
const rt = (k: Kind) => (k.x ? '<Xt>' : '<Wt>')

const SIZE_NAME = (k: Kind) => (k.size === 0 ? T('字节', 'byte') : k.size === 1 ? T('半字', 'halfword') : k.size === 2 ? T('字（32 位）', 'word (32 bits)') : T('双字（64 位）', 'doubleword (64 bits)'))

function kindDesc(k: Kind, how: Text): Text {
  const what = SIZE_NAME(k)
  switch (k.op) {
    case 'st':
      return T(`把寄存器的低${what.zh}存到内存（${how.zh}）`, `Store the low ${what.en} of a register (${how.en})`)
    case 'ld':
      return T(`从内存读一个${what.zh}，高位补 0（${how.zh}）`, `Load a ${what.en}, zero-extended (${how.en})`)
    case 'lds':
      return T(`从内存读一个${what.zh}，符号扩展到 ${k.x ? 64 : 32} 位（${how.zh}）`, `Load a ${what.en}, sign-extended to ${k.x ? 64 : 32} bits (${how.en})`)
    default:
      return T(`预取：提示处理器之后会访问这个地址（这里没有效果）（${how.zh}）`, `Prefetch: hint that the address will be accessed (no effect here) (${how.en})`)
  }
}

/** Do the access of a kind at an address. */
function access(c: Cpu, k: Kind, f: Fields, addr: bigint, acc: number = ACC.normal) {
  if (k.op === 'prf') return
  const bytes = 1 << k.size
  if (k.op === 'st') {
    c.store(addr, bytes, c.x(f.Rt!), acc)
    return
  }
  const v = c.load(addr, bytes, acc)
  if (k.op === 'ld') c.setR(k.x, f.Rt!, v)
  else c.setR(k.x, f.Rt!, BigInt.asUintN(64, BigInt.asIntN(8 * bytes, v)))
}

const mnemonic = (k: Kind, form: 'r' | 'ur' | 'tr') => {
  if (k.op === 'prf') return form === 'ur' ? 'prfum' : 'prfm'
  const stem = k.op === 'st' ? 'st' : k.op === 'ld' ? 'ld' : 'ld'
  const s = k.op === 'lds' ? 's' : ''
  return `${stem}${form}${s}${k.suffix}`
}

const sizeKey = (k: Kind) => `${k.x ? 'x' : 'w'}`

const INSTRS_: InstrSpec[] = []

/**
 * UNPREDICTABLE register choices of loads and stores, refused when assembling exactly where clang refuses
 * them: writeback to a register that is also loaded or stored (except LDPSW), and LDP/LDPSW loading one
 * register twice (LDP only without writeback, LDPSW except pre-index).
 */
const wbCheck = (load: boolean) => (f: Fields) => {
  if (f.Rn !== 31 && (f.Rt === f.Rn || (f.Rt2 !== undefined && f.Rt2 === f.Rn)))
    return load ? L('写回的基址寄存器不能同时是目标寄存器（结果不可预测）', 'The writeback base cannot also be a destination (UNPREDICTABLE)') : L('写回的基址寄存器不能同时是要存的寄存器（结果不可预测）', 'The writeback base cannot also be a source (UNPREDICTABLE)')
}
const pairCheck = (f: Fields) => {
  if (f.Rt === f.Rt2) return L('读两个寄存器时，两个目标不能相同（结果不可预测）', 'A load pair cannot use the same register twice (UNPREDICTABLE)')
}

/**
 * The same choices when the machine meets such a word (the assembler refuses most of them, but a word can
 * still come from data): the architecture lets each be UNDEFINED, and the CPU we check against makes every
 * one so, for loads and stores alike, so they raise SIGILL here too, before any memory is touched.
 */
function wbUndefined(c: Cpu, f: Fields) {
  if (f.Rn !== 31 && (f.Rt === f.Rn || (f.Rt2 !== undefined && f.Rt2 === f.Rn)))
    c.undefinedInstr(L('写回的基址寄存器同时也是要读写的寄存器', 'the writeback base is also a transferred register'))
}

for (const [size, opc] of KINDS) {
  const k = kindOf(size, opc)!
  const id = (form: string) => `${mnemonic(k, form === 'ur' ? 'ur' : form === 'tr' ? 'tr' : 'r')}-${form}-${sizeKey(k)}`
  const prf = k.op === 'prf'
  const first = prf ? '<prfop>' : rt(k)
  const scale = 1 << size
  // Unsigned offset.
  INSTRS_.push({
    id: id('uoff'),
    mnemonic: mnemonic(k, 'r'),
    group: 'load',
    bits: `${bin(size, 2)} 111 0 01 ${bin(opc, 2)} imm12:12 Rn:5 Rt:5`,
    syntax: `${first}, [<Xn|SP>{, #<u:imm12*${scale}>}]`,
    desc: kindDesc(k, T(`地址 = Xn + 偏移，偏移是 ${scale} 的倍数`, `address = Xn + an offset that is a multiple of ${scale}`)),
    exec: (c, f) => access(c, k, f, (c.base(f.Rn!) + BigInt(f.imm12! * scale)) & M64),
  })
  // Unscaled.
  INSTRS_.push({
    id: id('ur'),
    mnemonic: mnemonic(k, 'ur'),
    group: 'load',
    bits: `${bin(size, 2)} 111 0 00 ${bin(opc, 2)} 0 imm9:9 00 Rn:5 Rt:5`,
    syntax: `${first}, [<Xn|SP>{, #<s:imm9>}]`,
    desc: kindDesc(k, T('地址 = Xn + 偏移，偏移是 −256 到 255 的任意整数', 'address = Xn + any offset from −256 to 255')),
    exec: (c, f) => access(c, k, f, (c.base(f.Rn!) + BigInt(sext(f.imm9!, 9))) & M64),
  })
  // Register offset.
  INSTRS_.push({
    id: id('reg'),
    mnemonic: mnemonic(k, 'r'),
    group: 'load',
    bits: `${bin(size, 2)} 111 0 00 ${bin(opc, 2)} 1 Rm:5 option:3 S 10 Rn:5 Rt:5`,
    syntax: `${first}, [<Xn|SP>, <regoff:${size}>]`,
    // PRFM with Rt = 0b11xxx is RPRFM (range prefetch), which we leave out.
    valid: (f) => (f.option! & 2) !== 0 && !(prf && f.Rt! >> 3 === 3),
    desc: kindDesc(k, T('地址 = Xn + 偏移寄存器（可扩展、可左移）', 'address = Xn + an offset register (extended or shifted)')),
    exec: (c, f) => {
      const off = BigInt.asUintN(64, extend(c.x(f.Rm!), f.option!) << BigInt(f.S ? size : 0))
      access(c, k, f, (c.base(f.Rn!) + off) & M64)
    },
  })
  if (prf) continue
  // Post-index, pre-index, unprivileged.
  INSTRS_.push({
    id: id('post'),
    mnemonic: mnemonic(k, 'r'),
    group: 'load',
    bits: `${bin(size, 2)} 111 0 00 ${bin(opc, 2)} 0 imm9:9 01 Rn:5 Rt:5`,
    syntax: `${first}, [<Xn|SP>], #<s:imm9>`,
    check: wbCheck(k.op !== 'st'),
    desc: kindDesc(k, T('后变址：用 Xn 访问，然后 Xn += 偏移', 'post-index: access at Xn, then Xn += offset')),
    exec: (c, f) => {
      wbUndefined(c, f)
      const addr = c.base(f.Rn!)
      access(c, k, f, addr)
      c.setXsp(f.Rn!, (addr + BigInt(sext(f.imm9!, 9))) & M64)
    },
  })
  INSTRS_.push({
    id: id('pre'),
    mnemonic: mnemonic(k, 'r'),
    group: 'load',
    bits: `${bin(size, 2)} 111 0 00 ${bin(opc, 2)} 0 imm9:9 11 Rn:5 Rt:5`,
    syntax: `${first}, [<Xn|SP>, #<s:imm9>]!`,
    check: wbCheck(k.op !== 'st'),
    desc: kindDesc(k, T('前变址：先 Xn += 偏移，再用新的 Xn 访问', 'pre-index: Xn += offset, then access at the new Xn')),
    exec: (c, f) => {
      wbUndefined(c, f)
      const addr = (c.base(f.Rn!) + BigInt(sext(f.imm9!, 9))) & M64
      access(c, k, f, addr)
      c.setXsp(f.Rn!, addr)
    },
  })
  INSTRS_.push({
    id: id('tr'),
    mnemonic: mnemonic(k, 'tr'),
    group: 'load',
    bits: `${bin(size, 2)} 111 0 00 ${bin(opc, 2)} 0 imm9:9 10 Rn:5 Rt:5`,
    syntax: `${first}, [<Xn|SP>{, #<s:imm9>}]`,
    desc: kindDesc(k, T('非特权访问：在 EL1 也按 EL0 的权限检查', 'unprivileged: checked with EL0 permissions even at EL1')),
    exec: (c, f) => access(c, k, f, (c.base(f.Rn!) + BigInt(sext(f.imm9!, 9))) & M64, ACC.unprivileged),
  })
}

function extend(v: bigint, option: number): bigint {
  const len = 8 << (option & 3)
  return option & 4 ? BigInt.asIntN(len, v) : BigInt.asUintN(len, v)
}

/* ------------------------------------------------------------------ literal */

const LITERAL: [string, number, string, Text, (c: Cpu, f: Fields, addr: bigint) => void][] = [
  ['ldr', 0, '<Wt>', T('从 PC 附近（±1 MB）的标签处读一个字', 'Load a word from a label near the PC (±1 MB)'), (c, f, a) => c.setR(0, f.Rt!, c.load(a, 4))],
  ['ldr', 1, '<Xt>', T('从 PC 附近（±1 MB）的标签处读一个双字', 'Load a doubleword from a label near the PC (±1 MB)'), (c, f, a) => c.setX(f.Rt!, c.load(a, 8))],
  ['ldrsw', 2, '<Xt>', T('从 PC 附近的标签处读一个字，符号扩展到 64 位', 'Load a word from a label near the PC, sign-extended to 64 bits'), (c, f, a) => c.setX(f.Rt!, BigInt.asUintN(64, BigInt.asIntN(32, c.load(a, 4))))],
  ['prfm', 3, '<prfop>', T('预取 PC 附近标签处的数据（这里没有效果）', 'Prefetch from a label near the PC (no effect here)'), () => {}],
]

for (const [m, opc, first, desc, exec] of LITERAL) {
  INSTRS_.push({
    id: `${m}-lit-${opc}`,
    mnemonic: m,
    group: 'load',
    bits: `${bin(opc, 2)} 011 0 00 imm19:19 Rt:5`,
    syntax: `${first}, <label:imm19>`,
    desc,
    exec: (c, f) => exec(c, f, BigInt.asUintN(64, c.pcVa + BigInt(sext(f.imm19!, 19) * 4))),
  })
}

/* ------------------------------------------------------------------ pairs */

interface PairKind {
  m: string
  opc: number
  L: number
  x: number
  /** Load words, sign-extended to X (LDPSW). */
  sw?: boolean
}

const PAIRS: PairKind[] = [
  { m: 'stp', opc: 0, L: 0, x: 0 },
  { m: 'ldp', opc: 0, L: 1, x: 0 },
  { m: 'ldpsw', opc: 1, L: 1, x: 1, sw: true },
  { m: 'stp', opc: 2, L: 0, x: 1 },
  { m: 'ldp', opc: 2, L: 1, x: 1 },
]

function pairAccess(c: Cpu, p: PairKind, f: Fields, addr: bigint) {
  // Loading one register twice is UNPREDICTABLE; the CPU we check against makes it UNDEFINED.
  if (p.L && f.Rt === f.Rt2) c.undefinedInstr(L('两个目标寄存器相同', 'both destinations are the same register'))
  const bytes = p.x && !p.sw ? 8 : 4
  const a2 = (addr + BigInt(bytes)) & M64
  if (!p.L) {
    const v1 = c.x(f.Rt!)
    const v2 = c.x(f.Rt2!)
    c.store(addr, bytes, v1)
    c.store(a2, bytes, v2)
    return
  }
  const v1 = c.load(addr, bytes)
  const v2 = c.load(a2, bytes)
  const fix = (v: bigint) => (p.sw ? BigInt.asUintN(64, BigInt.asIntN(32, v)) : v)
  c.setR(p.x, f.Rt!, fix(v1))
  c.setR(p.x, f.Rt2!, fix(v2))
}

const pairDesc = (p: PairKind, how: Text): Text => {
  const w = p.x && !p.sw ? 64 : 32
  if (p.sw) return T(`从内存读两个字，各自符号扩展到 64 位（${how.zh}）`, `Load two words, each sign-extended to 64 bits (${how.en})`)
  return p.L ? T(`从连续内存读两个 ${w} 位寄存器（${how.zh}）`, `Load two ${w}-bit registers from consecutive memory (${how.en})`) : T(`把两个 ${w} 位寄存器存到连续内存（${how.zh}）`, `Store two ${w}-bit registers to consecutive memory (${how.en})`)
}

for (const p of PAIRS) {
  const scale = p.x && !p.sw ? 8 : 4
  const r = p.x ? 'X' : 'W'
  const regs = `<${r}t>, <${r}t2>`
  const base = `${bin(p.opc, 2)} 101 0`
  const key = `${p.m}-${p.x ? 'x' : 'w'}`
  INSTRS_.push({
    id: `${key}-post`,
    mnemonic: p.m,
    group: 'load',
    bits: `${base} 001 ${p.L} imm7:7 Rt2:5 Rn:5 Rt:5`,
    syntax: `${regs}, [<Xn|SP>], #<s:imm7*${scale}>`,
    check: p.sw ? pairCheck : wbCheck(!!p.L),
    desc: pairDesc(p, T('后变址', 'post-index')),
    exec: (c, f) => {
      wbUndefined(c, f)
      const addr = c.base(f.Rn!)
      pairAccess(c, p, f, addr)
      c.setXsp(f.Rn!, (addr + BigInt(sext(f.imm7!, 7) * scale)) & M64)
    },
  })
  INSTRS_.push({
    id: `${key}-off`,
    mnemonic: p.m,
    group: 'load',
    bits: `${base} 010 ${p.L} imm7:7 Rt2:5 Rn:5 Rt:5`,
    syntax: `${regs}, [<Xn|SP>{, #<s:imm7*${scale}>}]`,
    check: p.L ? pairCheck : undefined,
    desc: pairDesc(p, T('地址 = Xn + 偏移', 'address = Xn + offset')),
    exec: (c, f) => pairAccess(c, p, f, (c.base(f.Rn!) + BigInt(sext(f.imm7!, 7) * scale)) & M64),
  })
  INSTRS_.push({
    id: `${key}-pre`,
    mnemonic: p.m,
    group: 'load',
    bits: `${base} 011 ${p.L} imm7:7 Rt2:5 Rn:5 Rt:5`,
    syntax: `${regs}, [<Xn|SP>, #<s:imm7*${scale}>]!`,
    check: p.sw ? undefined : wbCheck(!!p.L),
    desc: pairDesc(p, T('前变址，函数开头常用 stp x29, x30, [sp, #-16]!', 'pre-index, as in stp x29, x30, [sp, #-16]! at function entry')),
    exec: (c, f) => {
      wbUndefined(c, f)
      const addr = (c.base(f.Rn!) + BigInt(sext(f.imm7!, 7) * scale)) & M64
      pairAccess(c, p, f, addr)
      c.setXsp(f.Rn!, addr)
    },
  })
  if (!p.sw) {
    INSTRS_.push({
      id: `${p.m === 'stp' ? 'stnp' : 'ldnp'}-${p.x ? 'x' : 'w'}`,
      mnemonic: p.m === 'stp' ? 'stnp' : 'ldnp',
      group: 'load',
      bits: `${base} 000 ${p.L} imm7:7 Rt2:5 Rn:5 Rt:5`,
      syntax: `${regs}, [<Xn|SP>{, #<s:imm7*${scale}>}]`,
      desc: pairDesc(p, T('提示不需要缓存', 'non-temporal hint')),
      exec: (c, f) => pairAccess(c, p, f, (c.base(f.Rn!) + BigInt(sext(f.imm7!, 7) * scale)) & M64),
    })
  }
}

/* ------------------------------------------------------------------ LDRAA, LDRAB */

for (const [m, M] of [
  ['ldraa', 0],
  ['ldrab', 1],
] as const) {
  for (const W of [0, 1]) {
    INSTRS_.push({
      id: `${m}${W ? '-pre' : ''}`,
      mnemonic: m,
      group: 'load',
      feature: 'pauth',
      bits: `11 111 0 00 ${M} S 1 imm9:9 ${W} 1 Rn:5 Rt:5`,
      syntax: W ? '<Xt>, [<Xn|SP>, #<pacoff>]!' : '<Xt>, [<Xn|SP>{, #<pacoff>}]',
      check: W ? wbCheck(true) : undefined,
      desc: T(`认证（${M ? 'B' : 'A'} 密钥）基址后读一个双字；偏移是 −4096 到 4088 之间 8 的倍数（密钥未开启：认证总是成功）`, `Authenticate the base (key ${M ? 'B' : 'A'}) and load a doubleword; the offset is a multiple of 8 from −4096 to 4088 (keys disabled: always succeeds)`),
      exec: (c, f) => {
        const addr = (c.base(f.Rn!) + BigInt(sext((f.S! << 9) | f.imm9!, 10) * 8)) & M64
        if (W) c.setXsp(f.Rn!, addr)
        c.setX(f.Rt!, c.load(addr, 8))
      },
    })
  }
}

/* ------------------------------------------------------------------ MOPS */

const UNPRIV = ['', 'wt', 'rt', 't']
const NONTEMPORAL = ['', 'wn', 'rn', 'n']

function mopsValid(f: Fields): boolean {
  return f.Rd !== f.Rs && f.Rd !== f.Rn && f.Rs !== f.Rn && f.Rd !== 31 && f.Rs !== 31 && f.Rn !== 31
}

/** One MOPS step does the whole operation (the architecture lets an implementation do so), leaving size 0. */
function copy(c: Cpu, f: Fields, forwardOnly: boolean) {
  const n = c.x(f.Rn!)
  const dst = c.x(f.Rd!)
  const src = c.x(f.Rs!)
  if (n === 0n || n >> 63n) return
  if (n > 1n << 26n) c.undefinedInstr()
  const count = Number(n)
  const bytes: bigint[] = []
  const backward = !forwardOnly && src < dst && dst < src + n
  for (let i = 0; i < count; i++) bytes.push(c.load((src + BigInt(i)) & M64, 1))
  for (let i = backward ? count - 1 : 0; backward ? i >= 0 : i < count; backward ? i-- : i++) c.store((dst + BigInt(i)) & M64, 1, bytes[i]!)
  c.setX(f.Rd!, (dst + n) & M64)
  c.setX(f.Rs!, (src + n) & M64)
  c.setX(f.Rn!, 0n)
}

function fill(c: Cpu, f: Fields) {
  const n = c.x(f.Rn!)
  const dst = c.x(f.Rd!)
  if (n === 0n || n >> 63n) return
  if (n > 1n << 26n) c.undefinedInstr()
  const v = c.x(f.Rs!) & 0xffn
  for (let i = 0n; i < n; i++) c.store((dst + i) & M64, 1, v)
  c.setX(f.Rd!, (dst + n) & M64)
  c.setX(f.Rn!, 0n)
}

const PHASES = [
  ['p', T('序言', 'prologue')],
  ['m', T('主体', 'main')],
  ['e', T('结尾', 'epilogue')],
] as const

for (const [o0, base] of [
  [0, 'cpyf'],
  [1, 'cpy'],
] as const) {
  PHASES.forEach(([ph, phase], op1) => {
    for (let op2 = 0; op2 < 16; op2++) {
      const m = `${base}${ph}${UNPRIV[op2 & 3]}${NONTEMPORAL[op2 >> 2]}`
      INSTRS_.push({
        id: m,
        mnemonic: m,
        group: 'mops',
        feature: 'mops',
        bits: `00 011 ${o0} 01 ${bin(op1, 2)} 0 Rs:5 ${bin(op2, 4)} 01 Rn:5 Rd:5`,
        syntax: '[<Xd>]!, [<Xs>]!, <Xn>!',
        valid: mopsValid,
        desc: T(
          `复制内存（${base === 'cpyf' ? '只向前复制' : '源和目标可以重叠'}）的${phase.zh}步：Xn 字节从 [Xs] 到 [Xd]；${base}p、${base}m、${base}e 三条连用（这里第一条就做完全部）`,
          `${phase.en} step of a memory copy (${base === 'cpyf' ? 'forward only' : 'source and destination may overlap'}): Xn bytes from [Xs] to [Xd]; use ${base}p, ${base}m and ${base}e together (here the first does it all)`,
        ),
        exec: (c, f) => copy(c, f, o0 === 0),
      })
    }
  })
}

PHASES.forEach(([ph, phase], p) => {
  for (let opt = 0; opt < 4; opt++) {
    const m = `set${ph}${['', 't', 'n', 'tn'][opt]}`
    INSTRS_.push({
      id: m,
      mnemonic: m,
      group: 'mops',
      feature: 'mops',
      bits: `00 011 0 01 11 0 Rs:5 ${bin(p, 2)}${bin(opt, 2)} 01 Rn:5 Rd:5`,
      syntax: '[<Xd>]!, <Xn>!, <Xs>',
      valid: (f) => f.Rd !== f.Rn && f.Rd !== f.Rs && f.Rn !== f.Rs && f.Rd !== 31 && f.Rn !== 31,
      desc: T(`填充内存的${phase.zh}步：把 Xn 字节的 [Xd] 都设成 Xs 的低字节；setp、setm、sete 三条连用（这里第一条就做完全部）`, `${phase.en} step of a memory set: fill Xn bytes at [Xd] with the low byte of Xs; use setp, setm and sete together (here the first does it all)`),
      exec: (c, f) => fill(c, f),
    })
  }
})

export const INSTRS = INSTRS_

/* ------------------------------------------------------------------ aliases */

/**
 * LDR with an offset that LDR (unsigned offset) cannot encode — negative or unaligned — is LDUR, as in
 * LLVM; likewise for STR, LDRB and the rest. Only assembly accepts these.
 */
export const ALIASES: AliasSpec[] = KINDS.flatMap(([size, opc]): AliasSpec[] => {
  const k = kindOf(size, opc)!
  if (k.op === 'prf') return []
  const ur = `${mnemonic(k, 'ur')}-ur-${sizeKey(k)}`
  return [{ id: `${mnemonic(k, 'r')}-as-ur-${sizeKey(k)}`, of: ur, mnemonic: mnemonic(k, 'r'), syntax: `${rt(k)}, [<Xn|SP>{, #<s:imm9>}]`, prefer: false }]
})

