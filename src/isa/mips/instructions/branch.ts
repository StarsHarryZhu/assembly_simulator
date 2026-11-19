/** Branches (PC-relative), REGIMM branches and jumps. No delay slots, as in MARS by default. */
import { RA } from '../registers'
import { def, type InstrDef } from './types'

const B = (name: string, opcode: number, ops: InstrDef['ops'], fixed: Record<string, number>, desc: string, exec: InstrDef['exec']) =>
  def(name, 'I', ops, { op: opcode, ...fixed }, 'I', desc, exec)

const RI = (name: string, rt: number, desc: string, exec: InstrDef['exec']) =>
  def(name, 'I', ['rs', 'off'], { op: 0x01, rt }, 'REGIMM', desc, exec)

export const BRANCH: InstrDef[] = [
  B('beq', 0x04, ['rs', 'rt', 'off'], {}, '若 {rs} = {rt}，跳到 {off}', (c, d) => {
    if (c.g(d.rs) === c.g(d.rt)) c.branch(d.simm)
  }),
  B('bne', 0x05, ['rs', 'rt', 'off'], {}, '若 {rs} ≠ {rt}，跳到 {off}', (c, d) => {
    if (c.g(d.rs) !== c.g(d.rt)) c.branch(d.simm)
  }),
  RI('bgez', 0x01, '若 {rs} ≥ 0，跳到 {off}', (c, d) => {
    if (c.g(d.rs) >= 0) c.branch(d.simm)
  }),
  RI('bgezal', 0x11, '若 {rs} ≥ 0，$ra ← 下一条指令的地址，再跳到 {off}', (c, d) => {
    if (c.g(d.rs) >= 0) {
      c.sg(RA, c.pc + 4)
      c.branch(d.simm)
    }
  }),
  B('bgtz', 0x07, ['rs', 'off'], { rt: 0 }, '若 {rs} > 0，跳到 {off}', (c, d) => {
    if (c.g(d.rs) > 0) c.branch(d.simm)
  }),
  B('blez', 0x06, ['rs', 'off'], { rt: 0 }, '若 {rs} ≤ 0，跳到 {off}', (c, d) => {
    if (c.g(d.rs) <= 0) c.branch(d.simm)
  }),
  RI('bltz', 0x00, '若 {rs} < 0，跳到 {off}', (c, d) => {
    if (c.g(d.rs) < 0) c.branch(d.simm)
  }),
  RI('bltzal', 0x10, '若 {rs} < 0，$ra ← 下一条指令的地址，再跳到 {off}', (c, d) => {
    if (c.g(d.rs) < 0) {
      c.sg(RA, c.pc + 4)
      c.branch(d.simm)
    }
  }),
  def('j', 'J', ['tgt'], { op: 0x02 }, 'J', '跳到 {tgt}（地址高 4 位沿用当前 PC）', (c, d) => c.jump(((c.pc + 4) & 0xf0000000) | (d.target << 2))),
  def('jr', 'R', ['rs'], { op: 0, rt: 0, rd: 0, shamt: 0, funct: 0x08 }, 'R', '跳到 {rs} 里存的地址', (c, d) => c.jump(c.g(d.rs))),
  def('jal', 'J', ['tgt'], { op: 0x03 }, 'J', '$ra ← 下一条指令的地址，再跳到 {tgt}', (c, d) => {
    c.sg(RA, c.pc + 4)
    c.jump(((c.pc + 4) & 0xf0000000) | (d.target << 2))
  }),
  def('jalr', 'R', ['rd', 'rs'], { op: 0, rt: 0, shamt: 0, funct: 0x09 }, 'R', '{rd} ← 下一条指令的地址，再跳到 {rs} 里存的地址', (c, d) => {
    const target = c.g(d.rs)
    c.sg(d.rd, c.pc + 4)
    c.jump(target)
  }),
  def('jalr', 'R', ['rs'], { op: 0, rt: 0, rd: 31, shamt: 0, funct: 0x09 }, 'R', '$ra ← 下一条指令的地址，再跳到 {rs} 里存的地址', (c, d) => {
    const target = c.g(d.rs)
    c.sg(RA, c.pc + 4)
    c.jump(target)
  }),
]
