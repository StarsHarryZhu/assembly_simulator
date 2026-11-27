/**
 * Loads and stores of the SIMD&FP registers: single registers B, H, S, D and Q in every addressing mode
 * (unsigned offset, unscaled, pre- and post-index, register offset, literal), pairs of S, D and Q, and the
 * structure loads and stores LD1–LD4 and ST1–ST4 (multiple structures, one lane, and LD1R–LD4R which
 * replicate), with their post-index forms.
 */
import { L, T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { M64, sext } from './util'
import { elems, lanesAt, storeLanes, toBytes } from './vec'

const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')
const INSTRS_: InstrSpec[] = []
const ALIASES_: AliasSpec[] = []

/* ------------------------------------------------------------------ single registers */

/** B H S D Q: (size, opc of the store), the load's opc is one more. */
const REGS: [string, number, number][] = [
  ['b', 0, 0],
  ['h', 1, 0],
  ['s', 2, 0],
  ['d', 3, 0],
  ['q', 0, 2],
]
const BYTES: Record<string, number> = { b: 1, h: 2, s: 4, d: 8, q: 16 }

function vaccess(c: Cpu, load: boolean, bytes: number, f: Fields, addr: bigint): void {
  if (load) c.vset(f.Rt!, bytes, c.load(addr, bytes))
  else c.store(addr, bytes, c.vget(f.Rt!, bytes))
}

const regDesc = (load: boolean, r: string, how: Text) =>
  load ? T(`从内存读 ${BYTES[r]} 字节到 ${r.toUpperCase()} 寄存器，向量寄存器的其余部分清零（${how.zh}）`, `Load ${BYTES[r]} bytes into a ${r.toUpperCase()} register, clearing the rest of the vector register (${how.en})`) : T(`把 ${r.toUpperCase()} 寄存器（${BYTES[r]} 字节）存到内存（${how.zh}）`, `Store a ${r.toUpperCase()} register (${BYTES[r]} bytes) (${how.en})`)

for (const [r, size, opc0] of REGS)
  for (const load of [false, true]) {
    const opc = bin(opc0 + (load ? 1 : 0), 2)
    const bytes = BYTES[r]!
    const reg = `<${r.toUpperCase()}t>`
    const m = load ? 'ldr' : 'str'
    const id = (form: string) => `${m}-${r}-${form}`
    INSTRS_.push({
      id: id('uoff'),
      mnemonic: m,
      group: 'vload',
      bits: `${bin(size, 2)} 111 1 01 ${opc} imm12:12 Rn:5 Rt:5`,
      syntax: `${reg}, [<Xn|SP>{, #<u:imm12*${bytes}>}]`,
      desc: regDesc(load, r, T(`地址 = Xn + 偏移，偏移是 ${bytes} 的倍数`, `address = Xn + an offset that is a multiple of ${bytes}`)),
      exec: (c, f) => vaccess(c, load, bytes, f, (c.base(f.Rn!) + BigInt(f.imm12! * bytes)) & M64),
    })
    INSTRS_.push({
      id: id('ur'),
      mnemonic: load ? 'ldur' : 'stur',
      group: 'vload',
      bits: `${bin(size, 2)} 111 1 00 ${opc} 0 imm9:9 00 Rn:5 Rt:5`,
      syntax: `${reg}, [<Xn|SP>{, #<s:imm9>}]`,
      desc: regDesc(load, r, T('地址 = Xn + 偏移，偏移是 −256 到 255 的任意整数', 'address = Xn + any offset from −256 to 255')),
      exec: (c, f) => vaccess(c, load, bytes, f, (c.base(f.Rn!) + BigInt(sext(f.imm9!, 9))) & M64),
    })
    INSTRS_.push({
      id: id('post'),
      mnemonic: m,
      group: 'vload',
      bits: `${bin(size, 2)} 111 1 00 ${opc} 0 imm9:9 01 Rn:5 Rt:5`,
      syntax: `${reg}, [<Xn|SP>], #<s:imm9>`,
      desc: regDesc(load, r, T('后变址：用 Xn 访问，然后 Xn += 偏移', 'post-index: access at Xn, then Xn += offset')),
      exec: (c, f) => {
        const addr = c.base(f.Rn!)
        vaccess(c, load, bytes, f, addr)
        c.setXsp(f.Rn!, (addr + BigInt(sext(f.imm9!, 9))) & M64)
      },
    })
    INSTRS_.push({
      id: id('pre'),
      mnemonic: m,
      group: 'vload',
      bits: `${bin(size, 2)} 111 1 00 ${opc} 0 imm9:9 11 Rn:5 Rt:5`,
      syntax: `${reg}, [<Xn|SP>, #<s:imm9>]!`,
      desc: regDesc(load, r, T('前变址：先 Xn += 偏移，再用新的 Xn 访问', 'pre-index: Xn += offset, then access at the new Xn')),
      exec: (c, f) => {
        const addr = (c.base(f.Rn!) + BigInt(sext(f.imm9!, 9))) & M64
        vaccess(c, load, bytes, f, addr)
        c.setXsp(f.Rn!, addr)
      },
    })
    const lg = Math.log2(bytes)
    INSTRS_.push({
      id: id('reg'),
      mnemonic: m,
      group: 'vload',
      bits: `${bin(size, 2)} 111 1 00 ${opc} 1 Rm:5 option:3 S 10 Rn:5 Rt:5`,
      syntax: `${reg}, [<Xn|SP>, <regoff:${lg}>]`,
      valid: (f) => (f.option! & 2) !== 0,
      desc: regDesc(load, r, T('地址 = Xn + 偏移寄存器（可扩展、可左移）', 'address = Xn + an offset register (extended or shifted)')),
      exec: (c, f) => {
        const len = 8 << (f.option! & 3)
        const v = c.x(f.Rm!)
        const off = BigInt.asUintN(64, (f.option! & 4 ? BigInt.asIntN(len, v) : BigInt.asUintN(len, v)) << BigInt(f.S ? lg : 0))
        vaccess(c, load, bytes, f, (c.base(f.Rn!) + off) & M64)
      },
    })
  }

for (const [opc, r] of [
  [0, 's'],
  [1, 'd'],
  [2, 'q'],
] as const)
  INSTRS_.push({
    id: `ldr-${r}-lit`,
    mnemonic: 'ldr',
    group: 'vload',
    bits: `${bin(opc, 2)} 011 1 00 imm19:19 Rt:5`,
    syntax: `<${r.toUpperCase()}t>, <label:imm19>`,
    desc: T(`从 PC 附近（±1 MB）的标签处读 ${BYTES[r]} 字节到 ${r.toUpperCase()} 寄存器`, `Load ${BYTES[r]} bytes from a label near the PC (±1 MB) into a ${r.toUpperCase()} register`),
    exec: (c, f) => c.vset(f.Rt!, BYTES[r]!, c.load(BigInt.asUintN(64, c.pcVa + BigInt(sext(f.imm19!, 19) * 4)), BYTES[r]!)),
  })

/* ------------------------------------------------------------------ pairs */

const pairCheck = (f: Fields) => {
  if (f.Rt === f.Rt2) return L('读两个寄存器时，两个目标不能相同（结果不可预测）', 'A load pair cannot use the same register twice (UNPREDICTABLE)')
}
function pairAccess(c: Cpu, load: boolean, bytes: number, f: Fields, addr: bigint): void {
  const a2 = (addr + BigInt(bytes)) & M64
  // Loading one register twice is UNPREDICTABLE; the CPU we check against makes it UNDEFINED.
  if (load && f.Rt === f.Rt2) c.undefinedInstr(L('两个目标寄存器相同', 'both destinations are the same register'))
  if (load) {
    const v1 = c.load(addr, bytes)
    const v2 = c.load(a2, bytes)
    c.vset(f.Rt!, bytes, v1)
    c.vset(f.Rt2!, bytes, v2)
  } else {
    const v1 = c.vget(f.Rt!, bytes)
    const v2 = c.vget(f.Rt2!, bytes)
    c.store(addr, bytes, v1)
    c.store(a2, bytes, v2)
  }
}
for (const [opc, r] of [
  [0, 's'],
  [1, 'd'],
  [2, 'q'],
] as const)
  for (const load of [0, 1]) {
    const bytes = BYTES[r]!
    const R = r.toUpperCase()
    const regs = `<${R}t>, <${R}t2>`
    const m = load ? 'ldp' : 'stp'
    const base = `${bin(opc, 2)} 101 1`
    const what = load ? T(`从连续内存读两个 ${R} 寄存器`, `Load two ${R} registers from consecutive memory`) : T(`把两个 ${R} 寄存器存到连续内存`, `Store two ${R} registers to consecutive memory`)
    const d = (how: Text) => T(`${what.zh}（${how.zh}）`, `${what.en} (${how.en})`)
    const check = load ? pairCheck : undefined
    INSTRS_.push({
      id: `${m}-${r}-post`,
      mnemonic: m,
      group: 'vload',
      bits: `${base} 001 ${load} imm7:7 Rt2:5 Rn:5 Rt:5`,
      syntax: `${regs}, [<Xn|SP>], #<s:imm7*${bytes}>`,
      check,
      desc: d(T('后变址', 'post-index')),
      exec: (c, f) => {
        const addr = c.base(f.Rn!)
        pairAccess(c, !!load, bytes, f, addr)
        c.setXsp(f.Rn!, (addr + BigInt(sext(f.imm7!, 7) * bytes)) & M64)
      },
    })
    INSTRS_.push({
      id: `${m}-${r}-off`,
      mnemonic: m,
      group: 'vload',
      bits: `${base} 010 ${load} imm7:7 Rt2:5 Rn:5 Rt:5`,
      syntax: `${regs}, [<Xn|SP>{, #<s:imm7*${bytes}>}]`,
      check,
      desc: d(T('地址 = Xn + 偏移', 'address = Xn + offset')),
      exec: (c, f) => pairAccess(c, !!load, bytes, f, (c.base(f.Rn!) + BigInt(sext(f.imm7!, 7) * bytes)) & M64),
    })
    INSTRS_.push({
      id: `${m}-${r}-pre`,
      mnemonic: m,
      group: 'vload',
      bits: `${base} 011 ${load} imm7:7 Rt2:5 Rn:5 Rt:5`,
      syntax: `${regs}, [<Xn|SP>, #<s:imm7*${bytes}>]!`,
      check,
      desc: d(T('前变址', 'pre-index')),
      exec: (c, f) => {
        const addr = (c.base(f.Rn!) + BigInt(sext(f.imm7!, 7) * bytes)) & M64
        pairAccess(c, !!load, bytes, f, addr)
        c.setXsp(f.Rn!, addr)
      },
    })
    INSTRS_.push({
      id: `${load ? 'ldnp' : 'stnp'}-${r}`,
      mnemonic: load ? 'ldnp' : 'stnp',
      group: 'vload',
      bits: `${base} 000 ${load} imm7:7 Rt2:5 Rn:5 Rt:5`,
      syntax: `${regs}, [<Xn|SP>{, #<s:imm7*${bytes}>}]`,
      desc: d(T('提示不需要缓存', 'non-temporal hint')),
      exec: (c, f) => pairAccess(c, !!load, bytes, f, (c.base(f.Rn!) + BigInt(sext(f.imm7!, 7) * bytes)) & M64),
    })
  }

/* ------------------------------------------------------------------ multiple structures */

/** Post-index: the immediate form (Rm fixed at 31) adds the transfer size, the register form adds Xm. */
function writeback(c: Cpu, f: Fields, addr: bigint, size: number): void {
  c.setXsp(f.Rn!, (addr + (f.Rm === undefined || f.Rm === 31 ? BigInt(size) : c.x(f.Rm))) & M64)
}

/** LDn/STn of `regs` registers with `selem` elements per structure (LD1 of k registers: selem 1). */
function multiple(c: Cpu, f: Fields, load: boolean, regs: number, selem: number): number {
  const es = f.size!
  const eb = 1 << es
  const bytes = f.Q ? 16 : 8
  const per = bytes / eb
  const addr = c.base(f.Rn!)
  const total = regs * bytes
  // Memory holds structure after structure; `regBytes` holds register after register (bytes each). The
  // element at memory offset ((r * per + e) * selem + s) * eb is element e of register r * selem + s.
  const at = (off: number) => {
    const k = off / eb
    const s = k % selem
    const e = Math.floor(k / selem) % per
    const r = Math.floor(k / (selem * per))
    return (r * selem + s) * bytes + e * eb
  }
  if (load) {
    // When the whole block can be read, read it at once; otherwise element by element, so a fault names the
    // first element that cannot be read (and no register changes).
    let block = c.loadBlock(addr, total)
    if (!block) {
      block = new Uint8Array(total)
      for (let off = 0; off < total; off += eb) storeLanes([c.load((addr + BigInt(off)) & M64, eb)], es, block, off)
    }
    let regBytes = block
    if (selem > 1) {
      regBytes = new Uint8Array(total)
      for (let off = 0; off < total; off += eb) regBytes.set(block.subarray(off, off + eb), at(off))
    }
    for (let i = 0; i < regs; i++) c.vwrite((f.Rt! + i) % 32, regBytes.subarray(i * bytes, i * bytes + bytes))
  } else {
    const regBytes = new Uint8Array(total)
    for (let i = 0; i < regs; i++) regBytes.set(c.vread((f.Rt! + i) % 32, bytes), i * bytes)
    let block = regBytes
    if (selem > 1) {
      block = new Uint8Array(total)
      for (let off = 0; off < total; off += eb) block.set(regBytes.subarray(at(off), at(off) + eb), off)
    }
    // Element by element when part of the block cannot be written: the elements before the fault are stored.
    if (!c.storeBlock(addr, block))
      for (let off = 0; off < total; off += eb) c.store((addr + BigInt(off)) & M64, eb, lanesAt(block, off, 1, es)[0]!)
  }
  return total
}

const MULTI: [number, number, number][] = [
  // opcode, registers, elements per structure
  [0b0000, 4, 4],
  [0b0010, 4, 1],
  [0b0100, 3, 3],
  [0b0110, 3, 1],
  [0b0111, 1, 1],
  [0b1000, 2, 2],
  [0b1010, 2, 1],
]
const multiDesc = (load: boolean, regs: number, selem: number): Text =>
  selem === 1
    ? load
      ? T(`从连续内存读满 ${regs} 个向量寄存器`, `Load ${regs} vector register${regs > 1 ? 's' : ''} from consecutive memory`)
      : T(`把 ${regs} 个向量寄存器存到连续内存`, `Store ${regs} vector register${regs > 1 ? 's' : ''} to consecutive memory`)
    : load
      ? T(`读 ${selem} 个元素一组的结构，拆开放进 ${regs} 个寄存器（第 i 个元素去第 i 个寄存器）`, `Load structures of ${selem} elements, de-interleaving them into ${regs} registers (element i of each goes to register i)`)
      : T(`把 ${regs} 个寄存器的元素交错存成 ${selem} 个元素一组的结构`, `Store the elements of ${regs} registers interleaved as structures of ${selem} elements`)

for (const [opcode, regs, selem] of MULTI)
  for (const load of [0, 1]) {
    const m = `${load ? 'ld' : 'st'}${selem}`
    const list = `<L:Rt:${regs}:size:Q>`
    const valid = selem === 1 ? undefined : (f: Fields) => !(f.size === 3 && f.Q === 0)
    const desc = multiDesc(!!load, regs, selem)
    const key = `${m}-${regs}`
    INSTRS_.push({
      id: key,
      mnemonic: m,
      group: 'vload',
      bits: `0 Q 0011000 ${load} 000000 ${bin(opcode, 4)} size:2 Rn:5 Rt:5`,
      syntax: `${list}, [<Xn|SP>]`,
      valid,
      desc,
      exec: (c, f) => void multiple(c, f, !!load, regs, selem),
    })
    INSTRS_.push({
      id: `${key}-posti`,
      mnemonic: m,
      group: 'vload',
      bits: `0 Q 0011001 ${load} 0 11111 ${bin(opcode, 4)} size:2 Rn:5 Rt:5`,
      syntax: `${list}, [<Xn|SP>], #<post:${regs}:mult>`,
      valid,
      desc: T(`${desc.zh}，然后 Xn 加上传输的字节数`, `${desc.en}, then add the transfer size to Xn`),
      exec: (c, f) => {
        const addr = c.base(f.Rn!)
        writeback(c, f, addr, multiple(c, f, !!load, regs, selem))
      },
    })
    INSTRS_.push({
      id: `${key}-postr`,
      mnemonic: m,
      group: 'vload',
      bits: `0 Q 0011001 ${load} 0 Rm:5 ${bin(opcode, 4)} size:2 Rn:5 Rt:5`,
      syntax: `${list}, [<Xn|SP>], <Xm>`,
      valid: (f) => f.Rm !== 31 && (!valid || valid(f)),
      desc: T(`${desc.zh}，然后 Xn += Xm`, `${desc.en}, then Xn += Xm`),
      exec: (c, f) => {
        const addr = c.base(f.Rn!)
        multiple(c, f, !!load, regs, selem)
        writeback(c, f, addr, 0)
      },
    })
  }

/* ------------------------------------------------------------------ single structures */

/** Opcode<2:1>, the S:size bits, and how the lane index is made, per element size. */
const LANE_BITS: Record<string, { op: string; tail: string; index: (f: Fields) => number }> = {
  b: { op: '00', tail: 'S size:2', index: (f) => (f.Q! << 3) | (f.S! << 2) | f.size! },
  h: { op: '01', tail: 'S size1 0', index: (f) => (f.Q! << 2) | (f.S! << 1) | f.size1! },
  s: { op: '10', tail: 'S 00', index: (f) => (f.Q! << 1) | f.S! },
  d: { op: '10', tail: '0 01', index: (f) => f.Q! },
}

function lane(c: Cpu, f: Fields, load: boolean, selem: number, es: number, index: number): number {
  const eb = 1 << es
  const addr = c.base(f.Rn!)
  if (load) {
    const vals = Array.from({ length: selem }, (_, s) => c.load((addr + BigInt(s * eb)) & M64, eb))
    vals.forEach((v, s) => {
      const n = (f.Rt! + s) % 32
      const E = elems(c.vread(n, 16), es)
      E[index] = v
      c.vwrite(n, toBytes(E, es))
    })
  } else for (let s = 0; s < selem; s++) c.store((addr + BigInt(s * eb)) & M64, eb, elems(c.vread((f.Rt! + s) % 32, 16), es)[index]!)
  return selem * eb
}

for (let selem = 1; selem <= 4; selem++) {
  const o0 = (selem - 1) >> 1
  const R = (selem - 1) & 1
  for (const load of [0, 1]) {
    const m = `${load ? 'ld' : 'st'}${selem}`
    for (const [letter, lb] of Object.entries(LANE_BITS)) {
      const es = 'bhsd'.indexOf(letter)
      const list = `<LI:${selem}:${letter}>[<lane:${letter}>]`
      const desc = load
        ? T(`从内存读 ${selem} 个元素，放进 ${selem} 个寄存器的同一个通道，其余通道不变`, `Load ${selem} element${selem > 1 ? 's' : ''} into one lane of ${selem} register${selem > 1 ? 's' : ''}, keeping the other lanes`)
        : T(`把 ${selem} 个寄存器同一个通道的元素存到连续内存`, `Store one lane of ${selem} register${selem > 1 ? 's' : ''} to consecutive memory`)
      const run = (c: Cpu, f: Fields) => lane(c, f, !!load, selem, es, lb.index(f))
      const key = `${m}-l${letter}`
      INSTRS_.push({
        id: key,
        mnemonic: m,
        group: 'vload',
        bits: `0 Q 0011010 ${load} ${R} 00000 ${lb.op}${o0} ${lb.tail} Rn:5 Rt:5`,
        syntax: `${list}, [<Xn|SP>]`,
        desc,
        exec: (c, f) => void run(c, f),
      })
      INSTRS_.push({
        id: `${key}-posti`,
        mnemonic: m,
        group: 'vload',
        bits: `0 Q 0011011 ${load} ${R} 11111 ${lb.op}${o0} ${lb.tail} Rn:5 Rt:5`,
        syntax: `${list}, [<Xn|SP>], #<post:${selem}:one:${letter}>`,
        desc: T(`${desc.zh}，然后 Xn 加上传输的字节数`, `${desc.en}, then add the transfer size to Xn`),
        exec: (c, f) => {
          const addr = c.base(f.Rn!)
          writeback(c, f, addr, run(c, f))
        },
      })
      INSTRS_.push({
        id: `${key}-postr`,
        mnemonic: m,
        group: 'vload',
        bits: `0 Q 0011011 ${load} ${R} Rm:5 ${lb.op}${o0} ${lb.tail} Rn:5 Rt:5`,
        syntax: `${list}, [<Xn|SP>], <Xm>`,
        valid: (f) => f.Rm !== 31,
        desc: T(`${desc.zh}，然后 Xn += Xm`, `${desc.en}, then Xn += Xm`),
        exec: (c, f) => {
          const addr = c.base(f.Rn!)
          run(c, f)
          writeback(c, f, addr, 0)
        },
      })
    }
  }
  /* LD1R–LD4R: one structure, each element replicated to every lane of its register. */
  const m = `ld${selem}r`
  const desc = T(`从内存读 ${selem} 个元素，每个复制到对应寄存器的所有通道`, `Load ${selem} element${selem > 1 ? 's' : ''} and replicate each to every lane of its register`)
  const rep = (c: Cpu, f: Fields) => {
    const es = f.size!
    const eb = 1 << es
    const addr = c.base(f.Rn!)
    const per = (f.Q ? 16 : 8) / eb
    const vals = Array.from({ length: selem }, (_, s) => c.load((addr + BigInt(s * eb)) & M64, eb))
    vals.forEach((v, s) => c.vwrite((f.Rt! + s) % 32, toBytes(Array<bigint>(per).fill(v), es)))
    return selem * eb
  }
  const list = `<L:Rt:${selem}:size:Q>`
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'vload',
    bits: `0 Q 0011010 1 ${R} 00000 11${o0} 0 size:2 Rn:5 Rt:5`,
    syntax: `${list}, [<Xn|SP>]`,
    desc,
    exec: (c, f) => void rep(c, f),
  })
  INSTRS_.push({
    id: `${m}-posti`,
    mnemonic: m,
    group: 'vload',
    bits: `0 Q 0011011 1 ${R} 11111 11${o0} 0 size:2 Rn:5 Rt:5`,
    syntax: `${list}, [<Xn|SP>], #<post:${selem}:rep>`,
    desc: T(`${desc.zh}，然后 Xn 加上传输的字节数`, `${desc.en}, then add the transfer size to Xn`),
    exec: (c, f) => {
      const addr = c.base(f.Rn!)
      writeback(c, f, addr, rep(c, f))
    },
  })
  INSTRS_.push({
    id: `${m}-postr`,
    mnemonic: m,
    group: 'vload',
    bits: `0 Q 0011011 1 ${R} Rm:5 11${o0} 0 size:2 Rn:5 Rt:5`,
    syntax: `${list}, [<Xn|SP>], <Xm>`,
    valid: (f) => f.Rm !== 31,
    desc: T(`${desc.zh}，然后 Xn += Xm`, `${desc.en}, then Xn += Xm`),
    exec: (c, f) => {
      const addr = c.base(f.Rn!)
      rep(c, f)
      writeback(c, f, addr, 0)
    },
  })
}

export const INSTRS = INSTRS_
export const ALIASES = ALIASES_
