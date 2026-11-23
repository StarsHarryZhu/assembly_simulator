/**
 * What an instruction's semantics may do to the machine. Implemented by ../cpu.ts; instruction tables only
 * see this interface, so the machine can change how it stores state without touching them.
 *
 * Register values are unsigned bigints (64-bit, or 32-bit zero-extended for W registers). Addresses passed
 * to load and store are virtual addresses as bigints; the machine checks and translates them.
 */

/** Access kinds for load and store. */
export const ACC = {
  normal: 0,
  /** Exclusive, acquire/release and atomic accesses: the address must be aligned to the size. */
  aligned: 1,
  /** LDTR/STTR: at EL1 they access memory as EL0 would. */
  unprivileged: 2,
  /**
   * Acquire/release and atomic accesses with FEAT_LSE2: unaligned is fine within a 16-byte block, but an
   * access that crosses one faults.
   */
  lse2: 4,
} as const

export interface Cpu {
  /** Internal address of the instruction being executed. */
  readonly pc: number
  /** The executing instruction's address as a virtual address. */
  readonly pcVa: bigint
  /** Current exception level, 0 or 1. */
  readonly el: number

  /** X register n, 31 reading as zero. */
  x(n: number): bigint
  /** X register n, 31 meaning SP. */
  xsp(n: number): bigint
  setX(n: number, v: bigint): void
  setXsp(n: number, v: bigint): void
  /** Register n at a width: sf 1 is 64-bit, sf 0 is the low 32 bits. 31 reads as zero. */
  r(sf: number, n: number): bigint
  /** Same, with 31 meaning SP. */
  rsp(sf: number, n: number): bigint
  /** Write register n at a width (a W write clears the upper 32 bits). 31 discards. */
  setR(sf: number, n: number, v: bigint): void
  /** Same, with 31 meaning SP. */
  setRsp(sf: number, n: number, v: bigint): void
  /** The base address register of a load or store: 31 is SP, which must then be 16-byte aligned. */
  base(n: number): bigint

  /** N Z C V as bits 3..0. */
  flags(): number
  setFlags(nzcv: number): void
  /** Whether a condition (0–15) holds. */
  cond(c: number): boolean

  /** Continue at pc + offset (bytes). */
  branchRel(offset: number): void
  /** Continue at an address held in a register. */
  branchTo(target: bigint): void

  load(addr: bigint, size: number, acc?: number): bigint
  store(addr: bigint, size: number, value: bigint, acc?: number): void

  /** Raise an undefined instruction exception; `why` explains it when the encoding exists but this use does not. */
  undefinedInstr(why?: string): never
  /** SVC: a Linux system call. */
  svc(imm: number): void
  /** BRK: a breakpoint exception. */
  brk(imm: number): never
  /** ERET. */
  eret(): void
  /** MRS. */
  sysRead(enc: number): bigint
  /** MSR (register). */
  sysWrite(enc: number, v: bigint): void
  /** MSR (immediate): a PSTATE field. */
  pstate(op1: number, op2: number, crm: number): void
  /** SYS (DC, IC, AT, TLBI): only DC ZVA changes memory. */
  sysOp(op1: number, crn: number, crm: number, op2: number, rt: number): void

  /** The exclusive monitor of LDXR/STXR. */
  markExclusive(addr: bigint, size: number): void
  /** Whether the monitor still covers the address; clears it either way. */
  checkExclusive(addr: bigint, size: number): boolean
  clearExclusive(): void
}

export type Fields = Record<string, number>
