import { T, type Text } from '../../core/i18n'
import type { FormatId, Op } from './instructions/types'

export interface FieldSpec {
  name: string
  hi: number
  lo: number
}

const f = (name: string, hi: number, lo: number): FieldSpec => ({ name, hi, lo })
const OP = f('op', 31, 26)

/** Bit layouts, most significant field first. Every layout covers all 32 bits. */
export const FORMATS: Record<FormatId, FieldSpec[]> = {
  R: [OP, f('rs', 25, 21), f('rt', 20, 16), f('rd', 15, 11), f('shamt', 10, 6), f('funct', 5, 0)],
  I: [OP, f('rs', 25, 21), f('rt', 20, 16), f('imm', 15, 0)],
  J: [OP, f('target', 25, 0)],
  BRK: [OP, f('code', 25, 6), f('funct', 5, 0)],
  COP0: [OP, f('sub', 25, 21), f('rt', 20, 16), f('rd', 15, 11), f('zero', 10, 0)],
  CP1M: [OP, f('sub', 25, 21), f('rt', 20, 16), f('fs', 15, 11), f('zero', 10, 0)],
  ERET: [OP, f('co', 25, 25), f('zero', 24, 6), f('funct', 5, 0)],
  FR: [OP, f('fmt', 25, 21), f('ft', 20, 16), f('fs', 15, 11), f('fd', 10, 6), f('funct', 5, 0)],
  FRG: [OP, f('fmt', 25, 21), f('rt', 20, 16), f('fs', 15, 11), f('fd', 10, 6), f('funct', 5, 0)],
  FCMP: [OP, f('fmt', 25, 21), f('ft', 20, 16), f('fs', 15, 11), f('cc', 10, 8), f('zero', 7, 6), f('funct', 5, 0)],
  FBR: [OP, f('sub', 25, 21), f('cc', 20, 18), f('nd', 17, 17), f('tf', 16, 16), f('imm', 15, 0)],
  MOVCI: [OP, f('rs', 25, 21), f('cc', 20, 18), f('nd', 17, 17), f('tf', 16, 16), f('rd', 15, 11), f('shamt', 10, 6), f('funct', 5, 0)],
  FMOVC: [OP, f('fmt', 25, 21), f('cc', 20, 18), f('nd', 17, 17), f('tf', 16, 16), f('fs', 15, 11), f('fd', 10, 6), f('funct', 5, 0)],
  FI: [OP, f('rs', 25, 21), f('ft', 20, 16), f('imm', 15, 0)],
}

/** Names for the calculator's field rows. */
export const FIELD_TITLES: Record<string, Text> = {
  op: T('操作码', 'opcode'),
  rs: T('源寄存器 rs', 'source rs'),
  rt: T('rt', 'rt'),
  rd: T('目的寄存器 rd', 'destination rd'),
  shamt: T('移位量', 'shift amount'),
  funct: T('功能码', 'function'),
  imm: T('立即数', 'immediate'),
  target: T('跳转目标', 'jump target'),
  code: T('断点代码', 'break code'),
  sub: T('子操作码', 'sub-opcode'),
  zero: T('保留，必须为 0', 'reserved, must be 0'),
  co: T('CO 位', 'CO bit'),
  fmt: T('精度 fmt', 'format fmt'),
  ft: T('ft', 'ft'),
  fs: T('fs', 'fs'),
  fd: T('fd', 'fd'),
  cc: T('条件码', 'condition code'),
  nd: T('nd', 'nd'),
  tf: T('真/假', 'true/false'),
}

/** The field an operand fills. "mem" fills imm and rs. */
export function fieldOfOp(op: Op): string {
  switch (op) {
    case 'c0':
      return 'rd'
    case 'sa':
      return 'shamt'
    case 'immu':
    case 'off':
    case 'mem':
      return 'imm'
    case 'tgt':
      return 'target'
    default:
      return op
  }
}

export function fieldMask(spec: FieldSpec): number {
  const width = spec.hi - spec.lo + 1
  return width === 32 ? 0xffffffff : ((1 << width) - 1) << spec.lo
}

export function getField(word: number, spec: FieldSpec): number {
  const width = spec.hi - spec.lo + 1
  return width === 32 ? word >>> 0 : (word >>> spec.lo) & ((1 << width) - 1)
}

export function setField(word: number, spec: FieldSpec, value: number): number {
  const width = spec.hi - spec.lo + 1
  const mask = width === 32 ? 0xffffffff : (1 << width) - 1
  return ((word & ~(mask << spec.lo)) | ((value & mask) << spec.lo)) >>> 0
}
