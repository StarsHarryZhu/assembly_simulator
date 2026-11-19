/** Loads and stores, including the unaligned (lwl/lwr/swl/swr) and atomic (ll/sc) pairs. */
import { def, type Decoded, type Cpu, type InstrDef } from './types'

const ea = (c: Cpu, d: Decoded) => (c.g(d.rs) + d.simm) | 0

const M = (name: string, opcode: number, desc: string, exec: InstrDef['exec']) =>
  def(name, 'I', ['rt', 'mem'], { op: opcode }, 'I', desc, exec)

function setByteOf(word: number, pos: number, byte: number): number {
  const shift = pos * 8
  return (word & ~(0xff << shift)) | ((byte & 0xff) << shift)
}

export const MEMORY: InstrDef[] = [
  M('lw', 0x23, '{rt} ← 内存[{mem}] 的 4 字节（地址必须是 4 的倍数）', (c, d) => c.sg(d.rt, c.loadWord(ea(c, d)))),
  M('ll', 0x30, '载入链接：和 lw 一样读 4 字节（MARS 只有单处理器，总会成功）', (c, d) => c.sg(d.rt, c.loadWord(ea(c, d)))),
  M('lwl', 0x22, '非对齐读取左半部分：把 {mem} 所在字的高位字节并入 {rt} 的高位', (c, d) => {
    const addr = ea(c, d)
    let r = c.g(d.rt)
    const n = (addr >>> 0) % 4
    for (let i = 0; i <= n; i++) r = setByteOf(r, 3 - i, c.loadByte(addr - i, false))
    c.sg(d.rt, r)
  }),
  M('lwr', 0x26, '非对齐读取右半部分：把 {mem} 开始到字末的字节并入 {rt} 的低位', (c, d) => {
    const addr = ea(c, d)
    let r = c.g(d.rt)
    const n = 3 - ((addr >>> 0) % 4)
    for (let i = 0; i <= n; i++) r = setByteOf(r, i, c.loadByte(addr + i, false))
    c.sg(d.rt, r)
  }),
  M('sw', 0x2b, '内存[{mem}] ← {rt}（4 字节，地址必须是 4 的倍数）', (c, d) => c.storeWord(ea(c, d), c.g(d.rt))),
  M('sc', 0x38, '条件存储：和 sw 一样写 4 字节，然后 {rt} ← 1 表示成功', (c, d) => {
    c.storeWord(ea(c, d), c.g(d.rt))
    c.sg(d.rt, 1)
  }),
  M('swl', 0x2a, '非对齐写入左半部分：把 {rt} 的高位字节写到 {mem} 及更低的地址', (c, d) => {
    const addr = ea(c, d)
    const v = c.g(d.rt)
    const n = (addr >>> 0) % 4
    for (let i = 0; i <= n; i++) c.storeByte(addr - i, v >>> ((3 - i) * 8))
  }),
  M('swr', 0x2e, '非对齐写入右半部分：把 {rt} 的低位字节写到 {mem} 到字末', (c, d) => {
    const addr = ea(c, d)
    const v = c.g(d.rt)
    const n = 3 - ((addr >>> 0) % 4)
    for (let i = 0; i <= n; i++) c.storeByte(addr + i, v >>> (i * 8))
  }),
  M('lb', 0x20, '{rt} ← 内存[{mem}] 的 1 字节，符号扩展到 32 位', (c, d) => c.sg(d.rt, c.loadByte(ea(c, d), true))),
  M('lh', 0x21, '{rt} ← 内存[{mem}] 的 2 字节，符号扩展（地址必须是 2 的倍数）', (c, d) => c.sg(d.rt, c.loadHalf(ea(c, d), true))),
  M('lhu', 0x25, '{rt} ← 内存[{mem}] 的 2 字节，零扩展（地址必须是 2 的倍数）', (c, d) => c.sg(d.rt, c.loadHalf(ea(c, d), false))),
  M('lbu', 0x24, '{rt} ← 内存[{mem}] 的 1 字节，零扩展', (c, d) => c.sg(d.rt, c.loadByte(ea(c, d), false))),
  M('sb', 0x28, '内存[{mem}] ← {rt} 的最低 1 字节', (c, d) => c.storeByte(ea(c, d), c.g(d.rt))),
  M('sh', 0x29, '内存[{mem}] ← {rt} 的低 2 字节（地址必须是 2 的倍数）', (c, d) => c.storeHalf(ea(c, d), c.g(d.rt))),
]
