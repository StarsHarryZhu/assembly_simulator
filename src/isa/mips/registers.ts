import { T, type Text } from '../../core/i18n'
import type { RegisterBank, RegisterSpec } from '../../core/isa'

/** Conventional names of the 32 general-purpose registers, by number. */
export const GPR_NAMES = [
  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
  't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
  't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra',
] as const

const TEMP = T('临时', 'temporary')
const SAVED = T('保存（被调用者保存）', 'saved (callee-saved)')
const GPR_NOTES: Text[] = [
  T('恒为 0，写入会被丢弃', 'always 0; writes are discarded'),
  T('汇编器临时寄存器（伪指令展开时使用）', 'assembler temporary (used by pseudo-instruction expansions)'),
  T('返回值 / syscall 编号', 'return value / syscall number'),
  T('返回值', 'return value'),
  T('参数 1', 'argument 1'),
  T('参数 2', 'argument 2'),
  T('参数 3', 'argument 3'),
  T('参数 4', 'argument 4'),
  ...Array.from({ length: 8 }, () => TEMP),
  ...Array.from({ length: 8 }, () => SAVED),
  TEMP,
  TEMP,
  T('内核保留', 'reserved for the kernel'),
  T('内核保留', 'reserved for the kernel'),
  T('全局指针', 'global pointer'),
  T('栈指针', 'stack pointer'),
  T('帧指针', 'frame pointer'),
  T('返回地址', 'return address'),
]

/** Flat register ids shared by the CPU, the undo log and the status colours. */
export const HI = 32
export const LO = 33
export const F0 = 34
export const FCC0 = 66
export const C0_VADDR = 74
export const C0_STATUS = 75
export const C0_CAUSE = 76
export const C0_EPC = 77
export const PC = 78
export const REGISTER_COUNT = 79

export const ZERO = 0
export const AT = 1
export const V0 = 2
export const V1 = 3
export const A0 = 4
export const A1 = 5
export const A2 = 6
export const A3 = 7
export const GP = 28
export const SP = 29
export const FP = 30
export const RA = 31

/** Coprocessor-0 register number -> flat id. MARS implements these four. */
export const C0_BY_NUMBER: Record<number, number> = { 8: C0_VADDR, 12: C0_STATUS, 13: C0_CAUSE, 14: C0_EPC }

export function gprName(n: number): string {
  return '$' + (GPR_NAMES[n] ?? String(n))
}

export function fprName(n: number): string {
  return '$f' + n
}

/** Parse a general-purpose register token: "$t0", "$8", "$zero" (the names above and $0..$31). Returns its number or -1. */
export function parseGpr(token: string): number {
  if (token[0] !== '$') return -1
  const body = token.slice(1)
  if (/^\d+$/.test(body)) {
    const n = Number(body)
    return n <= 31 ? n : -1
  }
  return (GPR_NAMES as readonly string[]).indexOf(body)
}

export function parseFpr(token: string): number {
  const m = /^\$f(\d+)$/.exec(token)
  if (!m) return -1
  const n = Number(m[1])
  return n <= 31 ? n : -1
}

function gprSpec(i: number): RegisterSpec {
  return {
    id: i,
    name: gprName(i),
    number: i,
    bits: 32,
    kind: 'int',
    hardwired: i === 0,
    note: GPR_NOTES[i],
  }
}

export const REGISTER_BANKS: RegisterBank[] = [
  {
    id: 'gpr',
    title: T('通用', 'General'),
    registers: [
      ...Array.from({ length: 32 }, (_, i) => gprSpec(i)),
      { id: HI, name: 'hi', bits: 32, kind: 'special', note: T('乘法结果的高 32 位 / 除法的余数', 'high 32 bits of a product / remainder of a division') },
      { id: LO, name: 'lo', bits: 32, kind: 'special', note: T('乘法结果的低 32 位 / 除法的商', 'low 32 bits of a product / quotient of a division') },
      { id: PC, name: 'pc', bits: 32, kind: 'special', untracked: true, note: T('下一条要执行的指令地址', 'address of the next instruction to execute') },
    ],
  },
  {
    id: 'fpr',
    title: T('浮点', 'Float'),
    registers: [
      ...Array.from({ length: 32 }, (_, i): RegisterSpec => ({
        id: F0 + i,
        name: fprName(i),
        number: i,
        bits: 32,
        kind: 'float',
        note:
          i % 2 === 0
            ? T(`单精度；双精度时与 $f${i + 1} 组成一对（本寄存器放低 32 位）`, `single precision; pairs with $f${i + 1} for a double (this register holds the low 32 bits)`)
            : T(`单精度；双精度时是 $f${i - 1} 的高 32 位`, `single precision; the high 32 bits of $f${i - 1} for a double`),
      })),
      ...Array.from({ length: 8 }, (_, i): RegisterSpec => ({
        id: FCC0 + i,
        name: 'cc' + i,
        number: i,
        bits: 32,
        kind: 'flag',
        note: T(`浮点比较的条件标志 ${i}`, `floating-point compare condition flag ${i}`),
      })),
    ],
  },
  {
    id: 'cp0',
    title: T('CP0', 'CP0'),
    registers: [
      { id: C0_VADDR, name: 'vaddr', number: 8, bits: 32, kind: 'special', note: T('$8：出错的内存地址', '$8: the memory address that faulted') },
      { id: C0_STATUS, name: 'status', number: 12, bits: 32, kind: 'special', note: T('$12：中断屏蔽和异常级别', '$12: interrupt mask and exception level') },
      { id: C0_CAUSE, name: 'cause', number: 13, bits: 32, kind: 'special', note: T('$13：异常原因编码', '$13: exception cause code') },
      { id: C0_EPC, name: 'epc', number: 14, bits: 32, kind: 'special', note: T('$14：发生异常的指令地址', '$14: address of the instruction that raised the exception') },
    ],
  },
]
