/** Integer arithmetic, logic, shifts, HI/LO, conditional moves and the SPECIAL2 group. */
import { def, type Cpu, type InstrDef } from './types'

function addOv(c: Cpu, a: number, b: number): number {
  const r = (a + b) | 0
  if (((a ^ r) & (b ^ r)) < 0) c.overflow()
  return r
}

function subOv(c: Cpu, a: number, b: number): number {
  const r = (a - b) | 0
  if (((a ^ b) & (a ^ r)) < 0) c.overflow()
  return r
}

/** 64-bit product as [hi, lo]. */
function mul64(a: number, b: number, signed: boolean): [number, number] {
  const p = signed ? BigInt(a | 0) * BigInt(b | 0) : BigInt(a >>> 0) * BigInt(b >>> 0)
  return [Number(BigInt.asIntN(32, p >> 32n)), Number(BigInt.asIntN(32, p))]
}

/** HI:LO + (or -) product, signed or unsigned. */
function accumulate(c: Cpu, a: number, b: number, signed: boolean, subtract: boolean): void {
  const p = signed ? BigInt(a | 0) * BigInt(b | 0) : BigInt(a >>> 0) * BigInt(b >>> 0)
  const acc = (BigInt(c.hi() | 0) << 32n) | BigInt(c.lo() >>> 0)
  const r = subtract ? acc - p : acc + p
  c.setHi(Number(BigInt.asIntN(32, r >> 32n)))
  c.setLo(Number(BigInt.asIntN(32, r)))
}

const R = (name: string, funct: number, ops: InstrDef['ops'], desc: string, exec: InstrDef['exec'], fixed: Record<string, number> = {}) =>
  def(name, 'R', ops, { op: 0, ...(ops.includes('sa') ? {} : { shamt: 0 }), funct, ...fixed }, 'R', desc, exec)

const S2 = (name: string, funct: number, ops: InstrDef['ops'], desc: string, exec: InstrDef['exec'], fixed: Record<string, number> = {}) =>
  def(name, 'R', ops, { op: 0x1c, shamt: 0, funct, ...fixed }, 'SPECIAL2', desc, exec)

const I = (name: string, opcode: number, ops: InstrDef['ops'], desc: string, exec: InstrDef['exec']) =>
  def(name, 'I', ops, { op: opcode }, 'I', desc, exec)

export const ALU: InstrDef[] = [
  def('nop', 'R', [], { op: 0, rs: 0, rt: 0, rd: 0, shamt: 0, funct: 0 }, 'R', '空操作：机器码全为 0（其实就是 sll $zero, $zero, 0）', () => {}),
  R('add', 0x20, ['rd', 'rs', 'rt'], '{rd} ← {rs} + {rt}，有符号溢出时触发异常', (c, d) => c.sg(d.rd, addOv(c, c.g(d.rs), c.g(d.rt)))),
  R('sub', 0x22, ['rd', 'rs', 'rt'], '{rd} ← {rs} − {rt}，有符号溢出时触发异常', (c, d) => c.sg(d.rd, subOv(c, c.g(d.rs), c.g(d.rt)))),
  I('addi', 0x08, ['rt', 'rs', 'imm'], '{rt} ← {rs} + {imm}（立即数符号扩展），溢出时触发异常', (c, d) => c.sg(d.rt, addOv(c, c.g(d.rs), d.simm))),
  R('addu', 0x21, ['rd', 'rs', 'rt'], '{rd} ← {rs} + {rt}，不检查溢出', (c, d) => c.sg(d.rd, (c.g(d.rs) + c.g(d.rt)) | 0)),
  R('subu', 0x23, ['rd', 'rs', 'rt'], '{rd} ← {rs} − {rt}，不检查溢出', (c, d) => c.sg(d.rd, (c.g(d.rs) - c.g(d.rt)) | 0)),
  I('addiu', 0x09, ['rt', 'rs', 'imm'], '{rt} ← {rs} + {imm}（立即数符号扩展），不检查溢出', (c, d) => c.sg(d.rt, (c.g(d.rs) + d.simm) | 0)),
  R('mult', 0x18, ['rs', 'rt'], 'HI:LO ← {rs} × {rt}（有符号 64 位积）', (c, d) => {
    const [h, l] = mul64(c.g(d.rs), c.g(d.rt), true)
    c.setHi(h)
    c.setLo(l)
  }, { rd: 0 }),
  R('multu', 0x19, ['rs', 'rt'], 'HI:LO ← {rs} × {rt}（无符号 64 位积）', (c, d) => {
    const [h, l] = mul64(c.g(d.rs), c.g(d.rt), false)
    c.setHi(h)
    c.setLo(l)
  }, { rd: 0 }),
  S2('mul', 0x02, ['rd', 'rs', 'rt'], '{rd} ← {rs} × {rt} 的低 32 位；HI、LO 同时写入完整的 64 位积', (c, d) => {
    const [h, l] = mul64(c.g(d.rs), c.g(d.rt), true)
    c.setHi(h)
    c.setLo(l)
    c.sg(d.rd, l)
  }),
  S2('madd', 0x00, ['rs', 'rt'], 'HI:LO ← HI:LO + {rs} × {rt}（有符号）', (c, d) => accumulate(c, c.g(d.rs), c.g(d.rt), true, false), { rd: 0 }),
  S2('maddu', 0x01, ['rs', 'rt'], 'HI:LO ← HI:LO + {rs} × {rt}（无符号）', (c, d) => accumulate(c, c.g(d.rs), c.g(d.rt), false, false), { rd: 0 }),
  S2('msub', 0x04, ['rs', 'rt'], 'HI:LO ← HI:LO − {rs} × {rt}（有符号）', (c, d) => accumulate(c, c.g(d.rs), c.g(d.rt), true, true), { rd: 0 }),
  S2('msubu', 0x05, ['rs', 'rt'], 'HI:LO ← HI:LO − {rs} × {rt}（无符号）', (c, d) => accumulate(c, c.g(d.rs), c.g(d.rt), false, true), { rd: 0 }),
  R('div', 0x1a, ['rs', 'rt'], 'LO ← {rs} ÷ {rt} 的商，HI ← 余数（有符号）。除数为 0 时 HI、LO 不变', (c, d) => {
    const a = c.g(d.rs)
    const b = c.g(d.rt)
    if (b === 0) return
    c.setHi(a % b | 0)
    c.setLo((a / b) | 0)
  }, { rd: 0 }),
  R('divu', 0x1b, ['rs', 'rt'], 'LO ← {rs} ÷ {rt} 的商，HI ← 余数（无符号）。除数为 0 时 HI、LO 不变', (c, d) => {
    const a = c.g(d.rs) >>> 0
    const b = c.g(d.rt) >>> 0
    if (b === 0) return
    c.setHi(a % b | 0)
    c.setLo(Math.floor(a / b) | 0)
  }, { rd: 0 }),
  R('mfhi', 0x10, ['rd'], '{rd} ← HI', (c, d) => c.sg(d.rd, c.hi()), { rs: 0, rt: 0 }),
  R('mflo', 0x12, ['rd'], '{rd} ← LO', (c, d) => c.sg(d.rd, c.lo()), { rs: 0, rt: 0 }),
  R('mthi', 0x11, ['rs'], 'HI ← {rs}', (c, d) => c.setHi(c.g(d.rs)), { rt: 0, rd: 0 }),
  R('mtlo', 0x13, ['rs'], 'LO ← {rs}', (c, d) => c.setLo(c.g(d.rs)), { rt: 0, rd: 0 }),
  R('and', 0x24, ['rd', 'rs', 'rt'], '{rd} ← {rs} & {rt}（按位与）', (c, d) => c.sg(d.rd, c.g(d.rs) & c.g(d.rt))),
  R('or', 0x25, ['rd', 'rs', 'rt'], '{rd} ← {rs} | {rt}（按位或）', (c, d) => c.sg(d.rd, c.g(d.rs) | c.g(d.rt))),
  I('andi', 0x0c, ['rt', 'rs', 'immu'], '{rt} ← {rs} & {immu}（立即数零扩展）', (c, d) => c.sg(d.rt, c.g(d.rs) & d.imm)),
  I('ori', 0x0d, ['rt', 'rs', 'immu'], '{rt} ← {rs} | {immu}（立即数零扩展，高 16 位不受影响）', (c, d) => c.sg(d.rt, c.g(d.rs) | d.imm)),
  R('nor', 0x27, ['rd', 'rs', 'rt'], '{rd} ← ~({rs} | {rt})（或非）', (c, d) => c.sg(d.rd, ~(c.g(d.rs) | c.g(d.rt)))),
  R('xor', 0x26, ['rd', 'rs', 'rt'], '{rd} ← {rs} ^ {rt}（按位异或）', (c, d) => c.sg(d.rd, c.g(d.rs) ^ c.g(d.rt))),
  I('xori', 0x0e, ['rt', 'rs', 'immu'], '{rt} ← {rs} ^ {immu}（立即数零扩展）', (c, d) => c.sg(d.rt, c.g(d.rs) ^ d.imm)),
  R('sll', 0x00, ['rd', 'rt', 'sa'], '{rd} ← {rt} 左移 {sa} 位（低位补 0，相当于 × 2^{sa}）', (c, d) => c.sg(d.rd, c.g(d.rt) << d.sa), { rs: 0 }),
  R('sllv', 0x04, ['rd', 'rt', 'rs'], '{rd} ← {rt} 左移（{rs} 的低 5 位）位', (c, d) => c.sg(d.rd, c.g(d.rt) << (c.g(d.rs) & 31))),
  R('srl', 0x02, ['rd', 'rt', 'sa'], '{rd} ← {rt} 逻辑右移 {sa} 位（高位补 0）', (c, d) => c.sg(d.rd, c.g(d.rt) >>> d.sa), { rs: 0 }),
  R('sra', 0x03, ['rd', 'rt', 'sa'], '{rd} ← {rt} 算术右移 {sa} 位（高位补符号位）', (c, d) => c.sg(d.rd, c.g(d.rt) >> d.sa), { rs: 0 }),
  R('srav', 0x07, ['rd', 'rt', 'rs'], '{rd} ← {rt} 算术右移（{rs} 的低 5 位）位', (c, d) => c.sg(d.rd, c.g(d.rt) >> (c.g(d.rs) & 31))),
  R('srlv', 0x06, ['rd', 'rt', 'rs'], '{rd} ← {rt} 逻辑右移（{rs} 的低 5 位）位', (c, d) => c.sg(d.rd, c.g(d.rt) >>> (c.g(d.rs) & 31))),
  I('lui', 0x0f, ['rt', 'immu'], '{rt} ← {immu} << 16（低 16 位清零）', (c, d) => c.sg(d.rt, d.imm << 16)),
  R('slt', 0x2a, ['rd', 'rs', 'rt'], '{rd} ← ({rs} < {rt}) ? 1 : 0（有符号比较）', (c, d) => c.sg(d.rd, c.g(d.rs) < c.g(d.rt) ? 1 : 0)),
  R('sltu', 0x2b, ['rd', 'rs', 'rt'], '{rd} ← ({rs} < {rt}) ? 1 : 0（无符号比较）', (c, d) => c.sg(d.rd, c.g(d.rs) >>> 0 < c.g(d.rt) >>> 0 ? 1 : 0)),
  I('slti', 0x0a, ['rt', 'rs', 'imm'], '{rt} ← ({rs} < {imm}) ? 1 : 0（有符号比较）', (c, d) => c.sg(d.rt, c.g(d.rs) < d.simm ? 1 : 0)),
  I('sltiu', 0x0b, ['rt', 'rs', 'imm'], '{rt} ← ({rs} < {imm}) ? 1 : 0（立即数先符号扩展，再按无符号比较）', (c, d) => c.sg(d.rt, c.g(d.rs) >>> 0 < d.simm >>> 0 ? 1 : 0)),
  R('movn', 0x0b, ['rd', 'rs', 'rt'], '若 {rt} ≠ 0，则 {rd} ← {rs}', (c, d) => {
    if (c.g(d.rt) !== 0) c.sg(d.rd, c.g(d.rs))
  }),
  R('movz', 0x0a, ['rd', 'rs', 'rt'], '若 {rt} = 0，则 {rd} ← {rs}', (c, d) => {
    if (c.g(d.rt) === 0) c.sg(d.rd, c.g(d.rs))
  }),
  def('movf', 'MOVCI', ['rd', 'rs'], { op: 0, cc: 0, nd: 0, tf: 0, shamt: 0, funct: 0x01 }, 'R', '若浮点条件标志 0 为假，则 {rd} ← {rs}', (c, d) => {
    if (!c.fcc(0)) c.sg(d.rd, c.g(d.rs))
  }),
  def('movf', 'MOVCI', ['rd', 'rs', 'cc'], { op: 0, nd: 0, tf: 0, shamt: 0, funct: 0x01 }, 'R', '若浮点条件标志 {cc} 为假，则 {rd} ← {rs}', (c, d) => {
    if (!c.fcc(d.cc)) c.sg(d.rd, c.g(d.rs))
  }),
  def('movt', 'MOVCI', ['rd', 'rs'], { op: 0, cc: 0, nd: 0, tf: 1, shamt: 0, funct: 0x01 }, 'R', '若浮点条件标志 0 为真，则 {rd} ← {rs}', (c, d) => {
    if (c.fcc(0)) c.sg(d.rd, c.g(d.rs))
  }),
  def('movt', 'MOVCI', ['rd', 'rs', 'cc'], { op: 0, nd: 0, tf: 1, shamt: 0, funct: 0x01 }, 'R', '若浮点条件标志 {cc} 为真，则 {rd} ← {rs}', (c, d) => {
    if (c.fcc(d.cc)) c.sg(d.rd, c.g(d.rs))
  }),
  S2('clo', 0x21, ['rd', 'rs'], '{rd} ← {rs} 从最高位开始连续 1 的个数', (c, d) => c.sg(d.rd, Math.clz32(~c.g(d.rs))), { rt: 0 }),
  S2('clz', 0x20, ['rd', 'rs'], '{rd} ← {rs} 从最高位开始连续 0 的个数', (c, d) => c.sg(d.rd, Math.clz32(c.g(d.rs))), { rt: 0 }),
]
