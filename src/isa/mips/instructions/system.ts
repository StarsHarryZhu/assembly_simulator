/** syscall, break, traps, coprocessor 0 and eret. */
import { def, type InstrDef } from './types'

const T = (name: string, funct: number, desc: string, test: (a: number, b: number) => boolean) =>
  def(name, 'R', ['rs', 'rt'], { op: 0, rd: 0, shamt: 0, funct }, 'TRAP', desc, (c, d) => {
    if (test(c.g(d.rs), c.g(d.rt))) c.trap()
  })

const TI = (name: string, rt: number, desc: string, test: (a: number, imm: number) => boolean) =>
  def(name, 'I', ['rs', 'imm'], { op: 0x01, rt }, 'TRAP', desc, (c, d) => {
    if (test(c.g(d.rs), d.simm)) c.trap()
  })

export const SYSTEM: InstrDef[] = [
  def('break', 'BRK', ['code'], { op: 0, funct: 0x0d }, 'R', '触发断点异常，代码 {code}', (c, d) => c.breakpoint(d.code)),
  def('break', 'BRK', [], { op: 0, code: 0, funct: 0x0d }, 'R', '触发断点异常', (c) => c.breakpoint(null)),
  def('syscall', 'R', [], { op: 0, rs: 0, rt: 0, rd: 0, shamt: 0, funct: 0x0c }, 'R', '系统调用：按 $v0 里的编号请求服务（打印、读取、退出……）', (c) => c.syscall()),
  def('mfc0', 'COP0', ['rt', 'c0'], { op: 0x10, sub: 0x00, zero: 0 }, 'CP0', '{rt} ← 协处理器 0 的 {c0}', (c, d) => c.sg(d.rt, c.c0(d.rd))),
  def('mtc0', 'COP0', ['rt', 'c0'], { op: 0x10, sub: 0x04, zero: 0 }, 'CP0', '协处理器 0 的 {c0} ← {rt}', (c, d) => c.setC0(d.rd, c.g(d.rt))),
  T('teq', 0x34, '若 {rs} = {rt}，触发陷阱异常', (a, b) => a === b),
  TI('teqi', 0x0c, '若 {rs} = {imm}，触发陷阱异常', (a, i) => a === i),
  T('tne', 0x36, '若 {rs} ≠ {rt}，触发陷阱异常', (a, b) => a !== b),
  TI('tnei', 0x0e, '若 {rs} ≠ {imm}，触发陷阱异常', (a, i) => a !== i),
  T('tge', 0x30, '若 {rs} ≥ {rt}（有符号），触发陷阱异常', (a, b) => a >= b),
  T('tgeu', 0x31, '若 {rs} ≥ {rt}（无符号），触发陷阱异常', (a, b) => a >>> 0 >= b >>> 0),
  TI('tgei', 0x08, '若 {rs} ≥ {imm}（有符号），触发陷阱异常', (a, i) => a >= i),
  TI('tgeiu', 0x09, '若 {rs} ≥ {imm}（立即数符号扩展后按无符号比较），触发陷阱异常', (a, i) => a >>> 0 >= i >>> 0),
  T('tlt', 0x32, '若 {rs} < {rt}（有符号），触发陷阱异常', (a, b) => a < b),
  T('tltu', 0x33, '若 {rs} < {rt}（无符号），触发陷阱异常', (a, b) => a >>> 0 < b >>> 0),
  TI('tlti', 0x0a, '若 {rs} < {imm}（有符号），触发陷阱异常', (a, i) => a < i),
  TI('tltiu', 0x0b, '若 {rs} < {imm}（立即数符号扩展后按无符号比较），触发陷阱异常', (a, i) => a >>> 0 < i >>> 0),
  def('eret', 'ERET', [], { op: 0x10, co: 1, zero: 0, funct: 0x18 }, 'CP0', '从异常返回：清除 status 的异常级别位，跳到 EPC', (c) => c.eret()),
]
