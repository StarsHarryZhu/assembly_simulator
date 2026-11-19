/** Shared types for the MIPS basic-instruction table. */
import { T, type Text } from '../../../core/i18n'
import { EN_DESC } from './en'

/** Bit-field layouts; see ../formats.ts. */
export type FormatId =
  | 'R'
  | 'I'
  | 'J'
  | 'BRK'
  | 'COP0'
  | 'CP1M'
  | 'ERET'
  | 'FR'
  | 'FRG'
  | 'FCMP'
  | 'FBR'
  | 'MOVCI'
  | 'FMOVC'
  | 'FI'

/** Families the calculator filters by. */
export type Group = 'R' | 'I' | 'J' | 'REGIMM' | 'SPECIAL2' | 'TRAP' | 'CP0' | 'FP'

/**
 * One source operand, named after where it goes:
 *  rd rs rt     general register into that field
 *  fd fs ft     float register into that field
 *  c0           coprocessor-0 register number ($8, $12, ...) into rd
 *  sa           5-bit shift amount
 *  cc           condition-code number (3 bits are encoded)
 *  imm          signed 16-bit immediate
 *  immu         unsigned 16-bit immediate
 *  code         break code (0..65535, encoded in bits 25..6)
 *  off          branch label -> PC-relative word offset
 *  tgt          jump label -> 26-bit word address
 *  mem          offset(base): signed 16-bit offset into imm, general register into rs
 */
export type Op = 'rd' | 'rs' | 'rt' | 'fd' | 'fs' | 'ft' | 'c0' | 'sa' | 'cc' | 'imm' | 'immu' | 'code' | 'off' | 'tgt' | 'mem'

/** Every field of a word, pre-extracted once when a program is loaded. FP aliases share bits. */
export interface Decoded {
  word: number
  op: number
  rs: number
  rt: number
  rd: number
  sa: number
  funct: number
  /** Raw 16-bit immediate. */
  imm: number
  /** Sign-extended immediate. */
  simm: number
  target: number
  code: number
  /** Condition code in bits 20..18 (bc1t, movf, movf.s). */
  cc: number
  /** Condition code in bits 10..8 (c.eq.s and friends). */
  ccLow: number
  /** fmt = rs, ft = rt, fs = rd, fd = sa. */
  fmt: number
  ft: number
  fs: number
  fd: number
}

/** What an instruction can do to the machine. Implemented by ../cpu.ts. */
export interface Cpu {
  /** Address of the instruction being executed. */
  readonly pc: number
  g(r: number): number
  sg(r: number, value: number): void
  hi(): number
  lo(): number
  setHi(value: number): void
  setLo(value: number): void
  /** Raw bits of a float register. */
  fbits(n: number): number
  setFbits(n: number, bits: number): void
  single(n: number): number
  setSingle(n: number, value: number): void
  /** Double in an even/odd register pair. Raises "all registers must be even-numbered" for odd n. */
  double(n: number): number
  setDouble(n: number, value: number): void
  requireEven(message: Text, ...regs: number[]): void
  fcc(cc: number): boolean
  setFcc(cc: number, value: boolean): void
  c0(number: number): number
  setC0(number: number, value: number): void
  /** Taken branch: next PC = pc + 4 + simm * 4. */
  branch(simm: number): void
  jump(addr: number): void
  loadWord(addr: number): number
  loadHalf(addr: number, signed: boolean): number
  loadByte(addr: number, signed: boolean): number
  storeWord(addr: number, value: number): void
  storeHalf(addr: number, value: number): void
  storeByte(addr: number, value: number): void
  /** Doubleword-aligned check used by ldc1/sdc1. */
  requireDoubleAligned(addr: number, store: boolean): void
  overflow(): never
  trap(): never
  breakpoint(code: number | null): never
  fault(message: string, code?: string): never
  syscall(): void
  eret(): void
}

export type Exec = (c: Cpu, d: Decoded) => void

export interface InstrDef {
  name: string
  fmt: FormatId
  ops: Op[]
  /** Fixed field values; every bit not covered by an operand must be fixed here or by the format. */
  fixed: Record<string, number>
  group: Group
  /** Description in both languages; {op} placeholders name the operands. */
  desc: Text
  exec: Exec
}

/** Small builder so the tables stay one line per instruction. */
export function def(
  name: string,
  fmt: FormatId,
  ops: Op[],
  fixed: Record<string, number>,
  group: Group,
  desc: string,
  exec: Exec,
): InstrDef {
  return { name, fmt, ops, fixed, group, desc: T(desc, EN_DESC[desc] ?? desc), exec }
}
