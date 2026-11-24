/**
 * The AArch64 machine: X registers, the two stack pointers, PSTATE, the system registers it keeps, memory with
 * per-region permissions, one-instruction steps with an undo log, and the read/write status of every register
 * that the register panel colours.
 *
 * A program runs as a Linux process at EL0. `svc #0` goes to the simulated kernel (linux.ts); calls to the
 * built-in C library (libc.ts) run when a branch reaches its entry point, inside the same step. Other
 * exceptions (undefined instructions, aborts, alignment faults, BRK) go to the program's own EL1 vector
 * table when it has a .ktext section, and otherwise stop the program the way Linux would send a signal.
 */
import { L } from '../../core/i18n'
import type { Environment, HaltReason, InputRequest, Machine, MachineOptions, MachineState, Program, RegChange, RegStatus, RegValue, StepInfo } from '../../core/isa'
import { IDLE, READ, WRITTEN } from '../../core/isa'
import { addrOf, hex16, vaOf } from '../../core/format'
import { WideMemory } from '../../core/memory'
import { decodeWord, disassemble, type Exec } from './encoding/table'
import { loadTables } from './instructions/index'
import { ACC, type Cpu, type Fields } from './instructions/types'
import { KERNEL_LIMIT, KTEXT_BASE, TEXT_BASE } from './assembler'
import {
  HEAP_BASE,
  INITIAL_OS,
  KSTACK_TOP,
  MAIN_RETURN,
  MALLOC_BASE,
  pageUp,
  STACK_SIZE,
  STACK_TOP,
  STUB_BASE,
  STUB_END,
  syscall,
  toUtf8,
  WaitForInput,
  type Host,
  type OpenFile,
  type OsState,
} from './linux'
import { libcAt, type Args } from './libc'
import { FpEnv, FPCR_MASK, NEP } from './softfloat'
import {
  CURRENT_EL,
  DAIF,
  ELR_EL1,
  ESR_EL1,
  FAR_EL1,
  FFR,
  FLAG_C,
  FLAG_N,
  FLAG_V,
  FLAG_Z,
  FPCR_ID,
  FPSR_ID,
  NZCV_SYS,
  P0,
  PC,
  REGISTER_COUNT,
  SP,
  SP_EL0,
  SP_EL1,
  SPSEL,
  SPSR_EL1,
  SYSREG_BY_ENC,
  SYSREG_BY_NAME,
  V0,
  VBAR_EL1,
  Z0,
  ZCR_EL1,
} from './registers'

loadTables()

const TOP = 2 ** 48
const UNDO_LIMIT = 2000
const M64 = 0xffff_ffff_ffff_ffffn
/** Initial stack pointer: room above it for argc, argv and the program name. */
export const INITIAL_SP = STACK_TOP - 64
const COUNTER_HZ = 24_000_000

/** Exception classes (ESR_EL1 bits 31..26). */
export const EC = {
  unknown: 0x00,
  instrAbortLower: 0x20,
  instrAbortSame: 0x21,
  pcAlign: 0x22,
  dataAbortLower: 0x24,
  dataAbortSame: 0x25,
  spAlign: 0x26,
  brk: 0x3c,
} as const

/** A synchronous exception. `signal` names what Linux would send when the program has no vector table. */
export class ArmFault {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly ec: number,
    readonly iss: number,
    readonly far: bigint | null,
    /** Stops the program even when it has a vector table (an abort in the C library). */
    readonly fatal = false,
  ) {}
}

/** Values the ID and identification registers report. */
const FIXED_SYSREGS: Record<string, bigint> = {
  MIDR_EL1: 0x410fd4f0n,
  MPIDR_EL1: 0x80000000n,
  REVIDR_EL1: 0n,
  CTR_EL0: 0x8444c004n,
  DCZID_EL0: 4n,
  CNTFRQ_EL0: BigInt(COUNTER_HZ),
  // EL0 and EL1 in AArch64, FP and AdvSIMD with FP16, SVE, DIT, CSV2, CSV3.
  ID_AA64PFR0_EL1: 0x0011_0011n | (1n << 32n) | (1n << 48n) | (1n << 56n) | (1n << 60n),
  // BTI, SSBS2, SME2.
  ID_AA64PFR1_EL1: 1n | (2n << 4n) | (2n << 24n),
  // SVE2.1 with AES/PMULL128, BitPerm, BF16, B16B16, SHA3, SM4, I8MM, F32MM, F64MM.
  ID_AA64ZFR0_EL1: 0x0110_1101_0121_0022n,
  // SME2.1 with I16I64, F64F64, B16B16, F16F16 and the base outer products.
  ID_AA64SMFR0_EL1: 0x02f1_0000_0000_0000n | (1n << 48n) | (1n << 42n) | (1n << 43n) | (0xfn << 36n) | (1n << 35n) | (1n << 34n) | (1n << 32n),
  // AES+PMULL, SHA1, SHA512, CRC32, LSE, RDM, SHA3, SM3, SM4, DotProd, FHM, FlagM2, TLB ranges.
  ID_AA64ISAR0_EL1: 0x0221_1111_1021_2120n,
  // DPB2, PAuth, JSCVT, FCMA, LRCPC2, PACGA, FRINTTS, SB, SPECRES, BF16, I8MM, XS.
  ID_AA64ISAR1_EL1: 0x0110_1111_1021_1102n,
  // MOPS, BC, CLRBHB, PRFMSLC, CSSC, RPRES.
  ID_AA64ISAR2_EL1: 0x0010_0100_1011_0010n,
  // 48-bit physical addresses, 16-bit ASIDs, 4 KB pages.
  ID_AA64MMFR0_EL1: 0x0000_0000_0000_0025n,
  // AFP (FPCR.FIZ, AH, NEP).
  ID_AA64MMFR1_EL1: 1n << 44n,
  // LSE2 (unaligned atomics within 16 bytes).
  ID_AA64MMFR2_EL1: 0x0000_0001_0000_0000n,
  ID_AA64DFR0_EL1: 0x0000_0000_0000_0006n,
}

interface Slot {
  exec: Exec
  fields: Fields
  line: number
}

/** One step's undo record. Records are recycled from a ring, so their arrays are reused. */
class StepLog {
  pc = 0
  prevSteps = 0
  prevHalt: HaltReason | null = null
  os: OsState = INITIAL_OS
  stdinLen = 0
  monitor: { addr: number; size: number } | null = null
  regIds: number[] = []
  regOld: RegValue[] = []
  statusIds: number[] = []
  statusOld: number[] = []
  memAddr: number[] = []
  memSize: number[] = []
  memOld: bigint[] = []
  reads: number[] = []
  output = ''
  sleep = 0
  reset(pc: number) {
    this.pc = pc
    this.regIds.length = 0
    this.regOld.length = 0
    this.statusIds.length = 0
    this.statusOld.length = 0
    this.memAddr.length = 0
    this.memSize.length = 0
    this.memOld.length = 0
    this.reads.length = 0
    this.output = ''
    this.sleep = 0
  }
}

const SYS_OFFSET = 140
/** Bytes per SIMD&FP register in storage (2048-bit SVE vectors). */
const VMAX = 256
/** Bytes per predicate register in storage (one bit per vector byte). */
const PMAX = VMAX / 8
/** The SVE vector length when the settings do not choose one, in bits. */
export const DEFAULT_VL = 256
/** FPSR.QC, the cumulative saturation bit. */
const QC = 1 << 27

export class ArmMachine implements Machine, Cpu, Host {
  readonly program: Program
  readonly env: Environment

  private xr = new BigUint64Array(31)
  private sp0 = 0n
  private sp1 = 0n
  private nzcv = 0
  /** PSTATE.EL and PSTATE.SP, and the DAIF mask bits (3..0 = D A I F). */
  private elv = 0
  private spsel = 0
  private daif = 0
  private sys: bigint[] = []
  /** SIMD&FP registers, VMAX bytes each (room for the longest SVE vector); the low `vlen` bytes are live. */
  private vr = new Uint8Array(32 * VMAX)
  /** p0–p15 and FFR (index 16), packed: bit i of a predicate governs vector byte i. */
  private pr = new Uint8Array(17 * PMAX)
  /** The largest vector length the settings allow, in bytes. */
  private maxVl = DEFAULT_VL / 8
  /** The current vector length in bytes: maxVl, or less when ZCR_EL1.LEN asks for less. */
  private vlen = DEFAULT_VL / 8
  private fpcrv = 0
  private fpsrv = 0
  private mem = new WideMemory()
  private status = new Uint8Array(REGISTER_COUNT)
  private written = new Map<number, number>()

  private pcReg = 0
  /** Internal address of the instruction being executed. */
  pc = 0
  private nextPc = 0
  /** The target of a branch to an address between the two halves of the address space. */
  private badTarget = 0n
  private stepCount = 0
  private haltReason: HaltReason | null = null
  private pendingReq: InputRequest | null = null

  private text: (Slot | undefined)[] = []
  private ktext: (Slot | undefined)[] = []
  private textStart = TEXT_BASE
  private textEnd = TEXT_BASE
  private ktextEnd = KTEXT_BASE
  private hasVectors = false
  /** The program's sections: [start, end) and whether they may be written. */
  private regions: { start: number; end: number; write: boolean }[] = []
  private byAddr = new Map<number, Program['instructions'][number]>()

  private recordReads = true
  private ring: StepLog[] = []
  private ringHead = 0
  private ringCount = 0
  private log: StepLog = new StepLog()

  os: OsState = INITIAL_OS
  readonly files = new Map<number, OpenFile>()
  /** Every byte typed so far; os.stdinPos says how far the program has read. */
  private stdin: number[] = []
  /** stdin length before the waiting step's input arrived. */
  private waitStdinLen: number | null = null
  private monitor: { addr: number; size: number } | null = null

  constructor(program: Program, env: Environment, options?: MachineOptions) {
    this.program = program
    this.env = env
    const bits = options?.settings?.vl ?? DEFAULT_VL
    this.maxVl = Math.max(16, Math.min(VMAX, 2 ** Math.floor(Math.log2(bits / 8))))
    this.vlen = this.maxVl
    const ins = program.instructions
    this.textStart = ins.find((i) => i.addr < TOP)?.addr ?? TEXT_BASE
    if (this.textStart > TEXT_BASE) this.textStart = TEXT_BASE
    for (const i of ins) {
      this.byAddr.set(i.addr, i)
      const d = decodeWord(i.word)
      const slot: Slot = d ? { exec: d.instr.spec.exec, fields: d.fields, line: i.line } : { exec: (c) => c.undefinedInstr(), fields: {}, line: i.line }
      if (i.addr >= TOP) {
        this.ktext[(i.addr - KTEXT_BASE) / 4] = slot
        this.ktextEnd = Math.max(this.ktextEnd, i.addr + 4)
        this.hasVectors = true
      } else {
        this.text[(i.addr - this.textStart) / 4] = slot
        this.textEnd = Math.max(this.textEnd, i.addr + 4)
      }
    }
    for (const sec of program.sections ?? []) this.regions.push({ start: sec.addr, end: pageUp(sec.addr + sec.size), write: !/text|rodata/.test(sec.name) })
    for (let i = 0; i < UNDO_LIMIT; i++) this.ring.push(new StepLog())
    this.reset()
  }

  /* ---------------------------------------------------------------- Machine */

  reset(): void {
    this.xr.fill(0n)
    this.nzcv = 0
    this.elv = 0
    this.spsel = 0
    this.daif = 0
    this.sys = new Array(REGISTER_COUNT - SYS_OFFSET).fill(0n)
    this.vr.fill(0)
    this.pr.fill(0)
    this.vlen = this.maxVl
    this.sys[ZCR_EL1 - SYS_OFFSET] = 15n
    this.fpcrv = 0
    this.fpsrv = 0
    this.sp1 = vaOf(KSTACK_TOP)
    if (this.hasVectors) this.sys[VBAR_EL1 - SYS_OFFSET] = vaOf(this.program.symbols.vectors ?? KTEXT_BASE)
    this.mem = new WideMemory()
    for (const chunk of this.program.image) this.mem.load(chunk.addr, chunk.bytes)
    // The process's initial stack: argc, argv[0], NULL, envp NULL, auxv AT_NULL, and the program name.
    const name = STACK_TOP - 16
    this.mem.load(name, toUtf8('a.out\0'))
    this.mem.setDword(INITIAL_SP, 1n)
    this.mem.setDword(INITIAL_SP + 8, BigInt(name))
    this.sp0 = BigInt(INITIAL_SP)
    this.status.fill(IDLE)
    this.written.clear()
    this.pcReg = this.program.entry
    const sym = this.program.symbols
    if (sym._start === undefined && sym.main !== undefined && this.program.entry === sym.main) {
      // Called like a C main: main(argc, argv, envp), returning to code that calls exit.
      this.xr[0] = 1n
      this.xr[1] = BigInt(INITIAL_SP + 8)
      this.xr[2] = BigInt(INITIAL_SP + 24)
      this.xr[30] = BigInt(MAIN_RETURN)
    }
    this.stepCount = 0
    this.haltReason = null
    this.pendingReq = null
    this.ringHead = 0
    this.ringCount = 0
    this.os = INITIAL_OS
    this.stdin = []
    this.waitStdinLen = null
    this.monitor = null
    this.files.clear()
    if (!this.executable(this.pcReg)) this.haltReason = { kind: 'dropped-off' }
  }

  get state(): MachineState {
    if (this.haltReason) return 'halted'
    if (this.pendingReq) return 'waiting'
    return 'ready'
  }
  get halted(): HaltReason | null {
    return this.haltReason
  }
  get pending(): InputRequest | null {
    return this.pendingReq
  }
  get steps(): number {
    return this.stepCount
  }
  get programCounter(): number {
    return this.pcReg
  }
  get canUndo(): boolean {
    return this.ringCount > 0
  }
  get lastSleep(): number {
    return this.log.sleep
  }

  resolve(value: unknown): void {
    if (this.pendingReq?.kind !== 'line' || typeof value !== 'string') return
    this.waitStdinLen ??= this.stdin.length
    this.stdin.push(...toUtf8(value + '\n'))
  }

  lineAt(addr: number): number | null {
    return this.slotAt(addr)?.line ?? null
  }

  private slotAt(addr: number): Slot | undefined {
    if (addr >= TOP) return addr < this.ktextEnd && addr % 4 === 0 ? this.ktext[(addr - KTEXT_BASE) / 4] : undefined
    return addr >= this.textStart && addr < this.textEnd && addr % 4 === 0 ? this.text[(addr - this.textStart) / 4] : undefined
  }

  private isStub(addr: number): boolean {
    return addr >= STUB_BASE && addr < STUB_END && addr % 16 === 0 && (addr === MAIN_RETURN || libcAt(addr) !== undefined)
  }

  private executable(addr: number): boolean {
    return this.slotAt(addr) !== undefined || this.isStub(addr)
  }

  step(): StepInfo {
    const log = this.beginLog()
    this.execute(log)
    return this.info(log)
  }

  run(limit: number, breakpoints: ReadonlySet<number>, skipFirstBreak = true): { steps: number; stop: 'halted' | 'waiting' | 'breakpoint' | 'limit' | 'sleep' } {
    let n = 0
    const checkBreaks = breakpoints.size > 0
    const from = skipFirstBreak ? 1 : 0
    this.recordReads = false
    try {
      while (n < limit) {
        if (this.haltReason) return { steps: n, stop: 'halted' }
        if (checkBreaks && n >= from && breakpoints.has(this.pcReg)) return { steps: n, stop: 'breakpoint' }
        const log = this.beginLog()
        this.execute(log)
        if (this.pendingReq) return { steps: n, stop: 'waiting' }
        n++
        if (log.sleep > 0) return { steps: n, stop: 'sleep' }
      }
      return { steps: n, stop: this.haltReason ? 'halted' : 'limit' }
    } finally {
      this.recordReads = true
    }
  }

  private beginLog(): StepLog {
    const log = this.ring[(this.ringHead + this.ringCount) % UNDO_LIMIT]!
    log.reset(this.pcReg)
    log.prevSteps = this.stepCount
    log.prevHalt = this.haltReason
    log.os = this.os
    log.stdinLen = this.stdin.length
    log.monitor = this.monitor
    this.log = log
    return log
  }

  private commit(): void {
    if (this.waitStdinLen !== null) {
      this.log.stdinLen = this.waitStdinLen
      this.waitStdinLen = null
    }
    if (this.ringCount < UNDO_LIMIT) this.ringCount++
    else this.ringHead = (this.ringHead + 1) % UNDO_LIMIT
  }

  private execute(log: StepLog): void {
    if (this.haltReason) return
    const pc = this.pcReg
    this.pc = pc
    this.nextPc = pc + 4
    try {
      const slot = this.slotAt(pc)
      if (slot && (pc < TOP || this.elv === 1)) slot.exec(this, slot.fields)
      else if (this.isStub(pc)) this.callStub(pc)
      else this.fetchFault(pc)
      // A branch into the C library runs the function as part of the same step (and a function that
      // returns to another entry point, as main returning to the exit code, runs that one too).
      for (let k = 0; k < 4 && !this.haltReason && this.nextPc >= STUB_BASE && this.nextPc < STUB_END && this.isStub(this.nextPc); k++) this.callStub(this.nextPc)
      this.pendingReq = null
      this.pcReg = this.nextPc
      this.stepCount++
      if (!this.haltReason && !this.executable(this.pcReg)) {
        const halt = this.badPc(this.pcReg)
        // With a vector table, the next step takes the fault there.
        if (halt.kind === 'dropped-off' || !this.hasVectors) this.haltReason = halt
      }
      this.commit()
    } catch (e) {
      if (e instanceof WaitForInput) {
        this.rollback(log)
        this.pendingReq = e.request
        return
      }
      if (e instanceof ArmFault) {
        this.pendingReq = null
        this.stepCount++
        this.takeException(e)
        this.commit()
        return
      }
      throw e
    }
  }

  /** The PC points somewhere without an instruction. */
  private fetchFault(pc: number): never {
    if (pc < 0) {
      throw new ArmFault('sigsegv', L(`段错误（SIGSEGV）：跳转目标 ${hex16(this.badTarget)} 不是有效的地址`, `Segmentation fault (SIGSEGV): branch target ${hex16(this.badTarget)} is not a valid address`), this.elv ? EC.instrAbortSame : EC.instrAbortLower, 0x4, this.badTarget)
    }
    const va = vaOf(pc)
    if (pc % 4) throw new ArmFault('sigbus', L(`总线错误（SIGBUS）：跳转目标 ${hex16(va)} 没有按 4 字节对齐`, `Bus error (SIGBUS): branch target ${hex16(va)} is not 4-byte aligned`), EC.pcAlign, 0, va)
    if (pc >= TOP && this.elv === 0 && this.slotAt(pc))
      throw new ArmFault('sigsegv', L(`段错误（SIGSEGV）：用户态（EL0）不能执行内核代码 ${hex16(va)}`, `Segmentation fault (SIGSEGV): user mode (EL0) cannot run kernel code at ${hex16(va)}`), EC.instrAbortLower, 0xf, va)
    throw new ArmFault('sigsegv', L(`段错误（SIGSEGV）：跳到了 ${hex16(va)}，那里没有指令`, `Segmentation fault (SIGSEGV): jumped to ${hex16(va)}, where there is no instruction`), this.elv ? EC.instrAbortSame : EC.instrAbortLower, 0x4, va)
  }

  private badPc(addr: number): HaltReason {
    // Running past the last instruction ends the program, as in MARS.
    if (addr === this.textEnd || addr === this.ktextEnd) return { kind: 'dropped-off' }
    try {
      this.fetchFault(addr)
    } catch (e) {
      if (e instanceof ArmFault) return { kind: 'error', code: e.code, message: e.message, addr: this.pc, line: this.lineAt(this.pc) }
    }
    return { kind: 'dropped-off' }
  }

  /** Run a C library function (or the return from main) and return to x30. */
  private callStub(addr: number): void {
    this.pc = addr
    if (addr === MAIN_RETURN) {
      this.exit(Number(this.x(0) & 0xffn))
      this.nextPc = addr
      return
    }
    const fn = libcAt(addr)!
    const stack = (i: number) => this.load((this.xsp(31) + BigInt(8 * i)) & M64, 8)
    const args: Args = Object.assign((i: number) => (i < 8 ? this.x(i) : stack(i - 8)), { fp: (i: number) => this.vget(i, 16), stack })
    const result = fn.run(this, args)
    if (result !== null) this.setX(0, result)
    if (this.haltReason) {
      this.nextPc = addr
      return
    }
    this.branchTo(this.x(30))
  }

  /** Take a synchronous exception to EL1, or stop the program when there is no vector table. */
  private takeException(e: ArmFault): void {
    const fromEl = this.elv
    const vbar = addrOf(this.sys[VBAR_EL1 - SYS_OFFSET]!)
    const offset = fromEl === 0 ? 0x400 : this.spsel ? 0x200 : 0
    const vector = vbar === null ? -1 : vbar + offset
    if (!this.hasVectors || e.fatal || vector < 0 || !this.slotAt(vector)) {
      const esr = ((e.ec << 26) | (1 << 25) | e.iss) >>> 0
      const detail = L(`（异常类别 EC = 0x${e.ec.toString(16)}，ESR = 0x${esr.toString(16)}${e.far !== null ? `，出错地址 ${hex16(e.far)}` : ''}）`, ` (exception class EC = 0x${e.ec.toString(16)}, ESR = 0x${esr.toString(16)}${e.far !== null ? `, fault address ${hex16(e.far)}` : ''})`)
      const line = this.lineAt(this.pc) ?? this.lineAt(this.log.pc)
      this.haltReason = { kind: 'error', code: e.code, message: e.message + detail, addr: this.pc, line }
      return
    }
    const spsr = (this.nzcv << 28) | (this.daif << 6) | (fromEl << 2) | (fromEl ? this.spsel : 0)
    this.writeSys(SPSR_EL1, BigInt(spsr >>> 0))
    this.writeSys(ELR_EL1, vaOf(this.pc))
    this.writeSys(ESR_EL1, BigInt(((e.ec << 26) | (1 << 25) | e.iss) >>> 0))
    if (e.far !== null) this.writeSys(FAR_EL1, e.far)
    this.writeSys(CURRENT_EL, 4n)
    this.writeSys(SPSEL, 1n)
    this.writeSys(DAIF, 0xfn << 6n)
    this.pcReg = vector
  }

  private info(log: StepLog): StepInfo {
    const writes: RegChange[] = []
    const seen = new Set<number>()
    for (let i = 0; i < log.regIds.length; i++) {
      const id = log.regIds[i]!
      if (seen.has(id)) continue
      seen.add(id)
      writes.push({ id, before: log.regOld[i]!, after: this.rawReg(id) })
      // z<n> is the same register as v<n>: report it under both names.
      if (id >= V0 && id < V0 + 32) writes.push({ id: id - V0 + Z0, before: log.regOld[i]!, after: this.rawReg(id) })
    }
    const reads = new Set(log.reads)
    for (const id of log.reads) if (id >= V0 && id < V0 + 32) reads.add(id - V0 + Z0)
    return {
      pc: log.pc,
      nextPc: this.pcReg,
      reads: [...reads],
      writes,
      memory: log.memAddr.map((addr, i) => ({ addr, size: log.memSize[i]! })),
      output: log.output,
      sleepMs: log.sleep,
      halted: this.haltReason,
    }
  }

  undo(): { pc: number; output: string } | null {
    if (this.pendingReq) {
      this.pendingReq = null
      if (this.waitStdinLen !== null) this.stdin.length = this.waitStdinLen
      this.waitStdinLen = null
    }
    if (this.ringCount === 0) return null
    this.ringCount--
    const log = this.ring[(this.ringHead + this.ringCount) % UNDO_LIMIT]!
    const undone = { pc: log.pc, output: log.output }
    this.stdin.length = Math.min(this.stdin.length, log.stdinLen)
    this.rollback(log)
    this.stepCount = log.prevSteps
    this.haltReason = log.prevHalt
    return undone
  }

  private rollback(log: StepLog): void {
    for (let i = log.memAddr.length - 1; i >= 0; i--) {
      const a = log.memAddr[i]!
      const size = log.memSize[i]!
      this.rawStore(a, size, log.memOld[i]!)
      for (let w = Math.floor(a / 4) * 4; w < a + size; w += 4) {
        const n = (this.written.get(w) ?? 1) - 1
        if (n <= 0) this.written.delete(w)
        else this.written.set(w, n)
      }
    }
    for (let i = log.regIds.length - 1; i >= 0; i--) this.setRawReg(log.regIds[i]!, log.regOld[i]!)
    for (let i = log.statusIds.length - 1; i >= 0; i--) this.status[log.statusIds[i]!] = log.statusOld[i]!
    this.os = log.os
    this.monitor = log.monitor
    this.pcReg = log.pc
    log.reset(log.pc)
  }

  readRegister(id: number): RegValue {
    if (id === PC) return vaOf(this.pcReg)
    return this.rawReg(id)
  }

  readRegisterBytes(id: number): Uint8Array {
    if (id >= V0 && id < V0 + 32) return this.vr.slice((id - V0) * VMAX, (id - V0) * VMAX + 16)
    if (id >= Z0 && id < Z0 + 32) return this.vr.slice((id - Z0) * VMAX, (id - Z0) * VMAX + this.vlen)
    if (id >= P0 && id <= FFR) return this.pr.slice((id - P0) * PMAX, (id - P0) * PMAX + this.vlen / 8)
    return new Uint8Array(0)
  }

  registerStatus(id: number): RegStatus {
    if (id >= Z0 && id < Z0 + 32) return this.status[id - Z0 + V0] as RegStatus
    return this.status[id] as RegStatus
  }

  readByte(addr: number): number {
    return this.mem.getByte(addr)
  }

  readWord(addr: number): number {
    return this.mem.getWord(addr)
  }

  everWritten(addr: number): boolean {
    return this.written.has(Math.floor(addr / 4) * 4)
  }

  writtenWords(): number[] {
    return [...this.written.keys()].sort((a, b) => a - b)
  }

  heapBlocks(): { addr: number; size: number; index: number; note?: string }[] {
    const out: { addr: number; size: number; index: number; note?: string }[] = []
    if (this.os.brk > HEAP_BASE) out.push({ addr: HEAP_BASE, size: this.os.brk - HEAP_BASE, index: 0, note: 'brk' })
    for (const b of this.os.mmaps) out.push({ addr: b.addr, size: b.size, index: b.serial, note: 'mmap' })
    for (const b of this.os.allocs) out.push({ addr: b.addr, size: b.size, index: b.serial, note: 'malloc' })
    return out.sort((a, b) => a.addr - b.addr)
  }

  setRegister(id: number, value: RegValue): void {
    if (id === PC) {
      const a = addrOf(BigInt(value))
      if (a !== null) this.pcReg = a
    } else this.setRawReg(id, value)
  }

  /* ---------------------------------------------------------------- raw state (no tracking) */

  private rawReg(id: number): RegValue {
    if (id < 31) return this.xr[id]!
    if (id >= V0 && id < V0 + 32) return this.vbig(id - V0, this.vlen)
    if (id >= Z0 && id < Z0 + 32) return this.vbig(id - Z0, this.vlen)
    if (id >= P0 && id <= FFR) return this.pbig(id - P0)
    if (id === SP) return this.elv && this.spsel ? this.sp1 : this.sp0
    if (id === PC) return vaOf(this.pcReg)
    if (id <= FLAG_V) return (this.nzcv >> (FLAG_V - id)) & 1
    if (id >= SYS_OFFSET) return this.sysValue(id)
    return 0
  }

  private setRawReg(id: number, v: RegValue): void {
    if (id < 31) this.xr[id] = BigInt(v)
    else if (id >= V0 && id < V0 + 32) this.vstore(id - V0, this.vlen, BigInt(v))
    else if (id >= Z0 && id < Z0 + 32) this.vstore(id - Z0, this.vlen, BigInt(v))
    else if (id >= P0 && id <= FFR) this.pstore(id - P0, BigInt(v))
    else if (id === SP) {
      if (this.elv && this.spsel) this.sp1 = BigInt.asUintN(64, BigInt(v))
      else this.sp0 = BigInt.asUintN(64, BigInt(v))
    } else if (id === PC) {
      const a = addrOf(BigInt(v))
      if (a !== null) this.pcReg = a
    } else if (id >= FLAG_N && id <= FLAG_V) {
      const bit = 1 << (FLAG_V - id)
      this.nzcv = Number(v) ? this.nzcv | bit : this.nzcv & ~bit
    } else if (id >= SYS_OFFSET) this.setSysValue(id, BigInt.asUintN(64, BigInt(v)))
  }

  private sysValue(id: number): bigint {
    switch (id) {
      case CURRENT_EL:
        return BigInt(this.elv << 2)
      case SPSEL:
        return BigInt(this.spsel)
      case DAIF:
        return BigInt(this.daif << 6)
      case NZCV_SYS:
        return BigInt(this.nzcv << 28) & 0xffffffffn
      case SP_EL0:
        return this.sp0
      case SP_EL1:
        return this.sp1
      case FPCR_ID:
        return BigInt(this.fpcrv)
      case FPSR_ID:
        return BigInt(this.fpsrv)
    }
    return this.sys[id - SYS_OFFSET] ?? 0n
  }

  private setSysValue(id: number, v: bigint): void {
    switch (id) {
      case CURRENT_EL:
        this.elv = Number((v >> 2n) & 1n)
        return
      case SPSEL:
        this.spsel = Number(v & 1n)
        return
      case DAIF:
        this.daif = Number((v >> 6n) & 15n)
        return
      case NZCV_SYS:
        this.nzcv = Number((v >> 28n) & 15n)
        return
      case SP_EL0:
        this.sp0 = v
        return
      case SP_EL1:
        this.sp1 = v
        return
      case FPCR_ID:
        this.fpcrv = Number(v & BigInt(FPCR_MASK))
        return
      case FPSR_ID:
        this.fpsrv = Number(v & BigInt(QC | 0x9f))
        return
      case ZCR_EL1: {
        // The vector length becomes the largest power of two up to (LEN + 1) × 128 bits that the machine has.
        const len = Number(v & 15n)
        this.sys[id - SYS_OFFSET] = BigInt(len)
        this.vlen = Math.min(this.maxVl, 2 ** Math.floor(Math.log2(len + 1)) * 16)
        return
      }
    }
    this.sys[id - SYS_OFFSET] = v
  }

  private markRead(id: number): void {
    if (this.recordReads) this.log.reads.push(id)
    if (this.status[id] === IDLE) {
      this.log.statusIds.push(id)
      this.log.statusOld.push(IDLE)
      this.status[id] = READ
    }
  }

  private markWrite(id: number, old: RegValue): void {
    this.log.regIds.push(id)
    this.log.regOld.push(old)
    if (this.status[id] !== WRITTEN) {
      this.log.statusIds.push(id)
      this.log.statusOld.push(this.status[id]!)
      this.status[id] = WRITTEN
    }
  }

  private writeSys(id: number, v: bigint): void {
    this.markWrite(id, this.rawReg(id))
    this.setRawReg(id, v)
  }

  /** The low `bytes` bytes of SIMD&FP register n as a little-endian number. */
  private vbig(n: number, bytes: number): bigint {
    const base = n * VMAX
    let v = 0n
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.vr[base + i]!)
    return v
  }
  private vstore(n: number, bytes: number, v: bigint): void {
    const base = n * VMAX
    for (let i = 0; i < bytes; i++) {
      this.vr[base + i] = Number(v & 0xffn)
      v >>= 8n
    }
  }

  /** Predicate n (16 = FFR) as a number: bit i governs vector byte i. */
  private pbig(n: number): bigint {
    const base = n * PMAX
    let v = 0n
    for (let i = this.vlen / 8 - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.pr[base + i]!)
    return v
  }
  private pstore(n: number, v: bigint): void {
    const base = n * PMAX
    for (let i = 0; i < this.vlen / 8; i++) {
      this.pr[base + i] = Number(v & 0xffn)
      v >>= 8n
    }
  }

  /* ---------------------------------------------------------------- Cpu: SIMD&FP */

  get vl(): number {
    return this.vlen
  }
  pread(n: number): Uint8Array {
    this.markRead(P0 + n)
    const out = new Uint8Array(this.vlen)
    const base = n * PMAX
    for (let i = 0; i < this.vlen; i++) out[i] = (this.pr[base + (i >> 3)]! >> (i & 7)) & 1
    return out
  }
  pwrite(n: number, bits: Uint8Array): void {
    this.markWrite(P0 + n, this.pbig(n))
    const base = n * PMAX
    this.pr.fill(0, base, base + this.vlen / 8)
    for (let i = 0; i < this.vlen; i++) if (bits[i]) this.pr[base + (i >> 3)]! |= 1 << (i & 7)
  }

  vread(n: number, bytes: number): Uint8Array {
    this.markRead(V0 + n)
    return this.vr.slice(n * VMAX, n * VMAX + bytes)
  }
  vwrite(n: number, data: Uint8Array): void {
    const id = V0 + n
    this.markWrite(id, this.vbig(n, this.vlen))
    const base = n * VMAX
    this.vr.set(data, base)
    this.vr.fill(0, base + data.length, base + this.vlen)
  }
  vget(n: number, bytes: number): bigint {
    this.markRead(V0 + n)
    return this.vbig(n, bytes)
  }
  vset(n: number, bytes: number, v: bigint, merge?: number): void {
    const id = V0 + n
    // FEAT_AFP's FPCR.NEP: a scalar result keeps the other bytes of the source register `merge`.
    const keep = merge !== undefined && this.fpcrv & NEP ? this.vbig(merge, 16) : 0n
    if (merge !== undefined && this.fpcrv & NEP && merge !== n) this.markRead(V0 + merge)
    this.markWrite(id, this.vbig(n, this.vlen))
    const mask = (1n << BigInt(bytes * 8)) - 1n
    this.vstore(n, this.vlen, (keep & ~mask) | (v & mask))
  }
  fpEnv(): FpEnv {
    this.markRead(FPCR_ID)
    return new FpEnv(this.fpcrv)
  }
  get fpcr(): number {
    return this.fpcrv
  }
  fpFlags(env: FpEnv): void {
    const next = this.fpsrv | (env.flags & 0x9f)
    if (next !== this.fpsrv) this.writeSys(FPSR_ID, BigInt(next))
  }
  setQC(): void {
    if (!(this.fpsrv & QC)) this.writeSys(FPSR_ID, BigInt(this.fpsrv | QC))
  }

  /* ---------------------------------------------------------------- Cpu: registers */

  get pcVa(): bigint {
    return vaOf(this.pc)
  }
  get el(): number {
    return this.elv
  }

  x(n: number): bigint {
    if (n === 31) return 0n
    this.markRead(n)
    return this.xr[n]!
  }
  xsp(n: number): bigint {
    if (n !== 31) return this.x(n)
    this.markRead(SP)
    return this.elv && this.spsel ? this.sp1 : this.sp0
  }
  setX(n: number, v: bigint): void {
    if (n === 31) return
    this.markWrite(n, this.xr[n]!)
    this.xr[n] = v
  }
  setXsp(n: number, v: bigint): void {
    if (n !== 31) return this.setX(n, v)
    v = BigInt.asUintN(64, v)
    if (this.elv && this.spsel) {
      this.markWrite(SP, this.sp1)
      this.sp1 = v
    } else {
      this.markWrite(SP, this.sp0)
      this.sp0 = v
    }
  }
  r(sf: number, n: number): bigint {
    return sf ? this.x(n) : this.x(n) & 0xffffffffn
  }
  rsp(sf: number, n: number): bigint {
    return sf ? this.xsp(n) : this.xsp(n) & 0xffffffffn
  }
  setR(sf: number, n: number, v: bigint): void {
    this.setX(n, sf ? v : v & 0xffffffffn)
  }
  setRsp(sf: number, n: number, v: bigint): void {
    this.setXsp(n, sf ? v : v & 0xffffffffn)
  }
  base(n: number): bigint {
    const v = this.xsp(n)
    if (n === 31 && v & 15n)
      throw new ArmFault('sigbus', L(`总线错误（SIGBUS）：sp = ${hex16(v)} 没有按 16 字节对齐，不能用作访存的基址`, `Bus error (SIGBUS): sp = ${hex16(v)} is not 16-byte aligned, so it cannot be a base address`), EC.spAlign, 0, null)
    return v
  }

  flags(): number {
    this.markRead(FLAG_N)
    this.markRead(FLAG_Z)
    this.markRead(FLAG_C)
    this.markRead(FLAG_V)
    return this.nzcv
  }
  setFlags(nzcv: number): void {
    const old = this.nzcv
    for (let id = FLAG_N; id <= FLAG_V; id++) this.markWrite(id, (old >> (FLAG_V - id)) & 1)
    this.nzcv = nzcv & 15
  }
  cond(c: number): boolean {
    const f = this.nzcv
    const n = (f >> 3) & 1
    const z = (f >> 2) & 1
    const cy = (f >> 1) & 1
    const v = f & 1
    let r: boolean
    switch (c >> 1) {
      case 0:
        this.markRead(FLAG_Z)
        r = z === 1
        break
      case 1:
        this.markRead(FLAG_C)
        r = cy === 1
        break
      case 2:
        this.markRead(FLAG_N)
        r = n === 1
        break
      case 3:
        this.markRead(FLAG_V)
        r = v === 1
        break
      case 4:
        this.markRead(FLAG_C)
        this.markRead(FLAG_Z)
        r = cy === 1 && z === 0
        break
      case 5:
        this.markRead(FLAG_N)
        this.markRead(FLAG_V)
        r = n === v
        break
      case 6:
        this.markRead(FLAG_N)
        this.markRead(FLAG_V)
        this.markRead(FLAG_Z)
        r = n === v && z === 0
        break
      default:
        return true
    }
    return c & 1 ? !r : r
  }

  branchRel(offset: number): void {
    const t = this.pc + offset
    if (t >= 0 && (this.pc >= TOP) === (t >= TOP)) this.nextPc = t
    else this.branchTo((vaOf(this.pc) + BigInt(offset)) & M64)
  }
  branchTo(target: bigint): void {
    const a = addrOf(target)
    if (a === null) {
      this.badTarget = BigInt.asUintN(64, target)
      this.nextPc = -1
    } else this.nextPc = a
  }

  /* ---------------------------------------------------------------- Cpu: memory */

  /** Whether [a, a + size) may be read (1) or also written (3) at an exception level; 0 when unmapped. */
  private permission(a: number, size: number, el: number): number {
    const end = a + size
    if (a >= TOP && el === 0) return -1
    if (a >= KERNEL_LIMIT && end <= KSTACK_TOP) return 3
    if (a >= STACK_TOP - STACK_SIZE && end <= STACK_TOP) return 3
    for (const r of this.regions) if (a >= r.start && end <= r.end) return r.write ? 3 : 1
    if (a >= this.textStart && end <= this.textEnd) return 1
    if (a >= HEAP_BASE && end <= pageUp(this.os.brk)) return 3
    if (a >= MALLOC_BASE && end <= this.os.arenaTop) return 3
    for (const m of this.os.mmaps) if (a >= m.addr && end <= m.addr + m.size) return 3
    return 0
  }

  private check(va: bigint, size: number, write: boolean, acc: number): number {
    const a = addrOf(va)
    const el = acc & ACC.unprivileged ? 0 : this.elv
    const ec = this.elv ? EC.dataAbortSame : EC.dataAbortLower
    const wnr = write ? 1 << 6 : 0
    if (a === null) throw new ArmFault('sigsegv', L(`段错误（SIGSEGV）：${hex16(va)} 不是有效的地址`, `Segmentation fault (SIGSEGV): ${hex16(va)} is not a valid address`), ec, wnr | 0x4, va)
    if (acc & ACC.aligned ? a % size !== 0 : acc & ACC.lse2 ? Math.floor(a / 16) !== Math.floor((a + size - 1) / 16) : false)
      throw new ArmFault(
        'sigbus',
        L(`总线错误（SIGBUS）：地址 ${hex16(va)} 没有按 ${size} 字节对齐（独占、获取/释放和原子访问必须对齐）`, `Bus error (SIGBUS): address ${hex16(va)} is not ${size}-byte aligned (exclusive, acquire/release and atomic accesses must be)`),
        ec,
        wnr | 0x21,
        va,
      )
    const p = this.permission(a, size, el)
    if (p === 3 || (p === 1 && !write)) return a
    if (p === -1) throw new ArmFault('sigsegv', L(`段错误（SIGSEGV）：用户态（EL0）不能访问内核地址 ${hex16(va)}`, `Segmentation fault (SIGSEGV): user mode (EL0) cannot access kernel address ${hex16(va)}`), ec, wnr | 0xf, va)
    if (p === 1) throw new ArmFault('sigsegv', L(`段错误（SIGSEGV）：地址 ${hex16(va)} 是只读的（代码或 .rodata）`, `Segmentation fault (SIGSEGV): address ${hex16(va)} is read-only (code or .rodata)`), ec, wnr | 0xf, va)
    throw new ArmFault('sigsegv', L(`段错误（SIGSEGV）：地址 ${hex16(va)} 没有可用的内存`, `Segmentation fault (SIGSEGV): there is no memory at ${hex16(va)}`), ec, wnr | 0x4, va)
  }

  private rawLoad(a: number, size: number): bigint {
    switch (size) {
      case 1:
        return BigInt(this.mem.getByte(a))
      case 2:
        return BigInt(this.mem.getHalf(a))
      case 4:
        return BigInt(this.mem.getWord(a) >>> 0)
      case 8:
        return this.mem.getDword(a)
    }
    return (this.mem.getDword(a + 8) << 64n) | this.mem.getDword(a)
  }

  private rawStore(a: number, size: number, v: bigint): void {
    switch (size) {
      case 1:
        return this.mem.setByte(a, Number(v & 0xffn))
      case 2:
        return this.mem.setHalf(a, Number(v & 0xffffn))
      case 4:
        return this.mem.setWord(a, Number(v & 0xffffffffn))
      case 8:
        return this.mem.setDword(a, v)
    }
    // 16 bytes (Q registers, pairs of doublewords).
    this.mem.setDword(a, v & 0xffff_ffff_ffff_ffffn)
    this.mem.setDword(a + 8, (v >> 64n) & 0xffff_ffff_ffff_ffffn)
  }

  load(addr: bigint, size: number, acc = 0): bigint {
    return this.rawLoad(this.check(addr, size, false, acc), size)
  }

  tryLoad(addr: bigint, size: number): bigint | null {
    try {
      return this.load(addr, size)
    } catch (e) {
      if (e instanceof ArmFault) return null
      throw e
    }
  }

  store(addr: bigint, size: number, value: bigint, acc = 0): void {
    const a = this.check(addr, size, true, acc)
    const log = this.log
    log.memAddr.push(a)
    log.memSize.push(size)
    log.memOld.push(this.rawLoad(a, size))
    for (let w = Math.floor(a / 4) * 4; w < a + size; w += 4) this.written.set(w, (this.written.get(w) ?? 0) + 1)
    this.rawStore(a, size, value)
    // A store by this CPU to the monitored block clears the exclusive monitor, as another CPU's would.
    if (this.monitor && a < this.monitor.addr + this.monitor.size && a + size > this.monitor.addr) this.monitor = null
  }

  /* ---------------------------------------------------------------- Cpu: exceptions and system */

  undefinedInstr(why?: string): never {
    const text = this.byAddr.get(this.pc)?.basic || hex16(vaOf(this.pc))
    const message = L(`非法指令（SIGILL）：${text} 在这里不能执行`, `Illegal instruction (SIGILL): ${text} cannot run here`)
    throw new ArmFault('sigill', why ? `${message}${L('：', ': ')}${why}` : message, EC.unknown, 0, null)
  }

  svc(_imm: number): void {
    syscall(this)
  }

  brk(imm: number): never {
    throw new ArmFault('sigtrap', L(`断点（SIGTRAP）：执行了 brk #${imm}`, `Breakpoint (SIGTRAP): brk #${imm} executed`), EC.brk, imm & 0xffff, null)
  }

  eret(): void {
    if (this.elv === 0) this.undefinedInstr()
    this.markRead(SPSR_EL1)
    this.markRead(ELR_EL1)
    const spsr = this.sys[SPSR_EL1 - SYS_OFFSET]!
    const elr = this.sys[ELR_EL1 - SYS_OFFSET]!
    const m = Number(spsr & 15n)
    this.setFlags(Number((spsr >> 28n) & 15n))
    this.writeSys(DAIF, spsr & (15n << 6n))
    // An SPSR naming a level above EL1 is an illegal return; it stays at EL1 as the architecture allows.
    const el = (m >> 2) & 3
    this.writeSys(SPSEL, BigInt(el === 0 ? 0 : m & 1))
    if (el <= 1) this.writeSys(CURRENT_EL, BigInt(el << 2))
    this.branchTo(elr)
  }

  sysRead(enc: number): bigint {
    const def = SYSREG_BY_ENC.get(enc)
    if (!def) return this.undefinedInstr()
    // Linux emulates EL0 reads of the identification registers.
    const emulated = def.name.startsWith('ID_') || def.name === 'MIDR_EL1' || def.name === 'MPIDR_EL1' || def.name === 'REVIDR_EL1'
    if (this.elv < def.readEl && !emulated) this.undefinedInstr()
    if (def.id === NZCV_SYS) {
      this.flags()
      return BigInt(this.nzcv << 28)
    }
    this.markRead(def.id)
    if (def.name === 'CNTVCT_EL0' || def.name === 'CNTPCT_EL0') return BigInt(Math.floor(this.env.now() * (COUNTER_HZ / 1000)))
    const fixed = FIXED_SYSREGS[def.name]
    if (fixed !== undefined) return fixed
    return this.sysValue(def.id)
  }

  sysWrite(enc: number, v: bigint): void {
    const def = SYSREG_BY_ENC.get(enc)
    if (!def || def.writeEl === null || this.elv < def.writeEl) return this.undefinedInstr()
    if (def.id === NZCV_SYS) return this.setFlags(Number((v >> 28n) & 15n))
    if (def.id === CURRENT_EL) return this.undefinedInstr()
    this.writeSys(def.id, v)
  }

  pstate(op1: number, op2: number, crm: number): void {
    if (op1 === 0 && op2 === 5) {
      if (this.elv === 0) this.undefinedInstr()
      return this.writeSys(SPSEL, BigInt(crm & 1))
    }
    if (op1 === 3 && (op2 === 6 || op2 === 7)) {
      // Linux leaves SCTLR_EL1.UMA clear: EL0 may not touch the interrupt masks.
      if (this.elv === 0) this.undefinedInstr()
      const now = BigInt(this.daif)
      const next = op2 === 6 ? now | BigInt(crm) : now & ~BigInt(crm)
      return this.writeSys(DAIF, next << 6n)
    }
    if (op1 === 0 && (op2 === 3 || op2 === 4) && this.elv === 0) this.undefinedInstr()
    // UAO, PAN, DIT, SSBS: no effect on this machine.
  }

  sysOp(op1: number, crn: number, crm: number, op2: number, rt: number): void {
    // DC ZVA zeroes a 64-byte block; the other cache and TLB operations have no visible effect.
    if (op1 === 3 && crn === 7 && crm === 4 && op2 === 1) {
      const base = this.x(rt) & ~63n
      this.check(base, 64, true, 0)
      for (let i = 0n; i < 64n; i += 8n) this.store(base + i, 8, 0n)
      return
    }
    // EL0 may use the operations Linux opens to it (op1 = 3: DC CVAC/CVAU/CIVAC/ZVA, IC IVAU).
    if (this.elv === 0 && op1 !== 3) this.undefinedInstr()
  }

  markExclusive(addr: bigint, size: number): void {
    const a = addrOf(addr)
    this.monitor = a === null ? null : { addr: a, size }
  }
  checkExclusive(addr: bigint, size: number): boolean {
    const a = addrOf(addr)
    const ok = this.monitor !== null && a === this.monitor.addr && size === this.monitor.size
    this.monitor = null
    return ok
  }
  clearExclusive(): void {
    this.monitor = null
  }

  /* ---------------------------------------------------------------- Host (kernel and C library) */

  private needByte(): void {
    if (this.os.stdinPos < this.stdin.length) return
    const line = this.env.readLine({ kind: 'line', purpose: 'string' })
    if (line == null) throw new WaitForInput({ kind: 'line', purpose: 'string' })
    this.stdin.push(...toUtf8(line + '\n'))
  }
  peekByte(): number {
    this.needByte()
    return this.stdin[this.os.stdinPos]!
  }
  nextByte(): number {
    this.needByte()
    const b = this.stdin[this.os.stdinPos]!
    this.os = { ...this.os, stdinPos: this.os.stdinPos + 1 }
    return b
  }
  out(text: string): void {
    if (!text) return
    this.log.output += text
    this.env.print(text)
  }
  sleep(ms: number): void {
    this.log.sleep = Math.max(this.log.sleep, ms)
  }
  exit(code: number): void {
    this.haltReason = { kind: 'exit', code }
  }
  abort(code: string, message: string): never {
    throw new ArmFault(code, message, EC.unknown, 0, null, true)
  }
}

export { SYSREG_BY_NAME }

export function createMachine(program: Program, env: Environment, options?: MachineOptions): ArmMachine {
  return new ArmMachine(program, env, options)
}
