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
import { decodeWord, disassemble, NEED, needsOf, type Exec } from './encoding/table'
import { loadTables } from './instructions/index'
import { ACC, type Cpu, type Fields } from './instructions/types'
import { ESIZE, lanesAt, storeLanes } from './instructions/vec'
import { KERNEL_LIMIT, KTEXT_BASE, TEXT_BASE } from './assembler'
import {
  HEAP_BASE,
  INITIAL_OS,
  KSTACK_TOP,
  MAIN_RETURN,
  MALLOC_BASE,
  PAGE,
  pageUp,
  STACK_SIZE,
  STACK_TOP,
  STUB_BASE,
  STUB_END,
  syscall,
  toUtf8,
  WaitForInput,
  type Host,
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
  SMCR_EL1,
  SP_EL0,
  SP_EL1,
  SPSEL,
  SPSR_EL1,
  SVCR,
  SYSREG_BY_ENC,
  SYSREG_BY_NAME,
  V0,
  VBAR_EL1,
  Z0,
  ZA,
  ZCR_EL1,
  ZT0,
} from './registers'

loadTables()

const TOP = 2 ** 48
const UNDO_LIMIT = 2000
/** Undo records in the ring: one more than the limit, so the step being made never writes over a kept one. */
const RING = UNDO_LIMIT + 1
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
  sme: 0x1d,
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
  SMIDR_EL1: 0n,
}

interface Slot {
  exec: Exec
  fields: Fields
  /** What the instruction's prepare made of its fields. */
  prep: unknown
  line: number
  /** NEED bits of the instruction. */
  needs: number
}

/** A register's value before a step: a number or bigint, or the old bytes of a vector, predicate or ZT0. */
type OldValue = RegValue | Uint8Array

/** Pseudo register id of an undo entry that holds all of NZCV (one entry instead of four). */
const NZCV_LOG = -1

/**
 * One step's undo record. Records are recycled from a ring, so their lists are reused: each list holds the
 * first `…N` entries and the rest are stale, to be overwritten (truncating an array is a slow runtime call in
 * V8, and every step refills the lists).
 */
class StepLog {
  pc = 0
  prevSteps = 0
  prevHalt: HaltReason | null = null
  os: OsState = INITIAL_OS
  stdinLen = 0
  monitor: { addr: number; size: number } | null = null
  regN = 0
  regIds: number[] = []
  /** Old values; for a vector, predicate or ZT0 register (bytesReg), the offset of its old bytes in `bytes`. */
  regOld: RegValue[] = []
  /** The number of old bytes of a bytesReg entry. */
  regLen: number[] = []
  /**
   * Old values of X registers and SP, at the same index as their entry in regIds (a typed array takes a
   * 64-bit value without allocating a bigint).
   */
  x64 = new BigUint64Array(8)
  statusN = 0
  statusIds: number[] = []
  statusOld: number[] = []
  memN = 0
  memAddr: number[] = []
  memSize: number[] = []
  memOld: bigint[] = []
  readN = 0
  reads: number[] = []
  /** ZA rows written (row number, offset of the old bytes in `bytes`, their number), in order. */
  zaN = 0
  zaRows: number[] = []
  zaOld: number[] = []
  zaLen: number[] = []
  /**
   * Old bytes of vector, predicate and ZT0 registers and of ZA rows, `byteN` of them in use (copying into one
   * buffer that the record keeps costs a fraction of allocating a copy for every write).
   */
  bytes = new Uint8Array(0)
  words = new Uint32Array(0)
  byteN = 0
  /** The vector, predicate, ZA and ZT0 storage before a change of PSTATE.SM or PSTATE.ZA cleared it. */
  vecSnap: Uint8Array | null = null
  predSnap: Uint8Array | null = null
  zaSnap: Uint8Array | null = null
  ztSnap: Uint8Array | null = null
  /** The target of a bad branch before the step (it names the fault the next step takes). */
  badTarget = 0n
  /**
   * Before a system call on a file: the store's files it changed, with their contents before (null: the file
   * did not exist). The open-file table itself is part of `os`.
   */
  vfs: [string, Uint8Array | null][] | null = null
  output = ''
  sleep = 0
  reset(pc: number) {
    this.pc = pc
    this.regN = this.statusN = this.memN = this.readN = this.zaN = this.byteN = 0
    if (this.vecSnap || this.zaSnap) this.vecSnap = this.predSnap = this.zaSnap = this.ztSnap = null
    if (this.vfs) this.vfs = null
    this.output = ''
    this.sleep = 0
  }

  /** Copy `len` bytes of src from `from` (a multiple of 4; srcWords views the same buffer); their offset here. */
  keep(src: Uint8Array, srcWords: Uint32Array, from: number, len: number): number {
    const at = this.byteN
    const end = at + len
    if (end > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.bytes.length * 2, end + 3, 256) & ~3)
      grown.set(this.bytes.subarray(0, at))
      this.bytes = grown
      this.words = new Uint32Array(grown.buffer)
    }
    const w = len >> 2
    const d = at >> 2
    const sw = from >> 2
    for (let k = 0; k < w; k++) this.words[d + k] = srcWords[sw + k]!
    for (let i = w << 2; i < len; i++) this.bytes[at + i] = src[from + i]!
    // Offsets stay multiples of 4.
    this.byteN = (end + 3) & ~3
    return at
  }

  /** Bytes kept at an offset. */
  kept(at: number, len: number): Uint8Array {
    return this.bytes.subarray(at, at + len)
  }
}

/** Registers whose undo entries keep old bytes in StepLog.bytes: V0–V31 (Z0–Z31 share them), P0–P15, FFR, ZT0. */
const bytesReg = (id: number) => (id >= V0 && id < V0 + 32) || (id >= P0 && id <= FFR) || id === ZT0

const SYS_OFFSET = 140
/** Bytes per SIMD&FP register in storage (2048-bit SVE vectors). */
const VMAX = 256
/** Bytes per predicate register in storage (one bit per vector byte). */
const PMAX = VMAX / 8
/** The SVE vector length when the settings do not choose one, in bits. */
export const DEFAULT_VL = 256
/** The streaming vector length (SVL) when the settings do not choose one, in bits (this Mac's M5 has 512). */
export const DEFAULT_SVL = 512
/** FPSR after entering or leaving Streaming SVE mode. */
const FPSR_STREAMING = 0x0800009f
/** FPSR.QC, the cumulative saturation bit. */
const QC = 1 << 27

/**
 * Whether an address is a multiple of n (a power of two). Addresses go beyond 2^31, where V8 compiles % to a
 * call to fmod; division and floor are exact and fast for them.
 */
const aligned = (a: number, n: number) => Math.floor(a / n) * n === a

/** A scratch cell: a bigint stored here reads back as two 32-bit numbers. */
const SC64 = new BigUint64Array(1)
const SC32 = new Uint32Array(SC64.buffer)

/** Bytes as a little-endian number, and back. */
function bigOf(bytes: Uint8Array): bigint {
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!)
  return v
}
function storeBig(bytes: Uint8Array, v: bigint): void {
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
}

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
  private vr16 = new Uint16Array(this.vr.buffer)
  private vr32 = new Uint32Array(this.vr.buffer)
  private vr64 = new BigUint64Array(this.vr.buffer)
  /** p0–p15 and FFR (index 16), packed: bit i of a predicate governs vector byte i. */
  private pr = new Uint8Array(17 * PMAX)
  private pr32 = new Uint32Array(this.pr.buffer)
  /** The largest vector length the settings allow, in bytes. */
  private maxVl = DEFAULT_VL / 8
  /** The non-streaming vector length in bytes: maxVl, or less when ZCR_EL1.LEN asks for less. */
  private nsvl = DEFAULT_VL / 8
  /** The largest streaming vector length the settings allow, in bytes; also the stride of ZA's rows. */
  private maxSvl = DEFAULT_SVL / 8
  /** The streaming vector length in bytes: maxSvl, or less when SMCR_EL1.LEN asks for less. */
  private svlen = DEFAULT_SVL / 8
  /** The vector length in effect, in bytes: svlen in Streaming SVE mode, nsvl otherwise. */
  private vlen = DEFAULT_VL / 8
  /** PSTATE.SM and PSTATE.ZA. */
  private smv = 0
  private zav = 0
  /** The ZA array: svlen rows of svlen bytes, each row maxSvl bytes apart. */
  private za = new Uint8Array((DEFAULT_SVL / 8) ** 2)
  private za32 = new Uint32Array(this.za.buffer)
  /** ZT0, 64 bytes. */
  private zt = new Uint8Array(64)
  private zt32 = new Uint32Array(this.zt.buffer)
  private fpcrv = 0
  private fpsrv = 0
  private mem = new WideMemory()
  private status = new Uint8Array(REGISTER_COUNT)
  /** For each 4 KB page, how many logged stores touched each of its words (the memory panel's highlights). */
  private written = new Map<number, Uint32Array>()
  private wKey = -1
  private wPage: Uint32Array | undefined = undefined

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
    const sbits = options?.settings?.svl ?? DEFAULT_SVL
    this.maxSvl = Math.max(16, Math.min(VMAX, 2 ** Math.floor(Math.log2(sbits / 8))))
    this.za = new Uint8Array(this.maxSvl * this.maxSvl)
    this.za32 = new Uint32Array(this.za.buffer)
    const ins = program.instructions
    this.textStart = ins.find((i) => i.addr < TOP)?.addr ?? TEXT_BASE
    if (this.textStart > TEXT_BASE) this.textStart = TEXT_BASE
    for (const i of ins) {
      this.byAddr.set(i.addr, i)
      const d = decodeWord(i.word)
      const slot: Slot = d
        ? { exec: d.instr.spec.exec, fields: d.fields, prep: d.instr.spec.prepare?.(d.fields), line: i.line, needs: needsOf(d.instr.spec, d.fields) }
        : { exec: (c) => c.undefinedInstr(), fields: {}, prep: undefined, line: i.line, needs: 0 }
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
    for (let i = 0; i < RING; i++) this.ring.push(new StepLog())
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
    this.za.fill(0)
    this.zt.fill(0)
    this.smv = 0
    this.zav = 0
    this.nsvl = this.vlen = this.maxVl
    this.svlen = this.maxSvl
    this.sys[ZCR_EL1 - SYS_OFFSET] = 15n
    this.sys[SMCR_EL1 - SYS_OFFSET] = 15n
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
    this.wKey = -1
    this.wPage = undefined
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
    if (addr >= TOP) return addr < this.ktextEnd && aligned(addr, 4) ? this.ktext[(addr - KTEXT_BASE) / 4] : undefined
    return addr >= this.textStart && addr < this.textEnd && aligned(addr, 4) ? this.text[(addr - this.textStart) / 4] : undefined
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
    const log = this.ring[(this.ringHead + this.ringCount) % RING]!
    log.reset(this.pcReg)
    log.prevSteps = this.stepCount
    log.prevHalt = this.haltReason
    log.os = this.os
    log.stdinLen = this.stdin.length
    log.monitor = this.monitor
    log.badTarget = this.badTarget
    this.log = log
    return log
  }

  private commit(): void {
    if (this.waitStdinLen !== null) {
      this.log.stdinLen = this.waitStdinLen
      this.waitStdinLen = null
    }
    if (this.ringCount < UNDO_LIMIT) this.ringCount++
    else this.ringHead = (this.ringHead + 1) % RING
  }

  private execute(log: StepLog): void {
    if (this.haltReason) return
    const pc = this.pcReg
    this.pc = pc
    this.nextPc = pc + 4
    try {
      const slot = this.slotAt(pc)
      if (slot && (pc < TOP || this.elv === 1)) {
        if (slot.needs) this.checkMode(slot.needs)
        slot.exec(this, slot.fields, slot.prep)
      }
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
      // A fault in the simulator itself: take back what the step did, so the machine and its undo log stay
      // consistent, and let the error surface.
      this.rollback(log)
      this.stepCount = log.prevSteps
      this.haltReason = log.prevHalt
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
    for (let i = 0; i < log.regN; i++) {
      const id = log.regIds[i]!
      const old = log.regOld[i]!
      if (id === NZCV_LOG) {
        for (let f = FLAG_N; f <= FLAG_V; f++) {
          if (seen.has(f)) continue
          seen.add(f)
          writes.push({ id: f, before: ((old as number) >> (FLAG_V - f)) & 1, after: this.rawReg(f) })
        }
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      const before = id >= 0 && id <= SP ? log.x64[i]! : bytesReg(id) ? bigOf(log.kept(old as number, log.regLen[i]!)) : old
      writes.push({ id, before, after: this.rawReg(id) })
      // z<n> is the same register as v<n>: report it under both names.
      if (id >= V0 && id < V0 + 32) writes.push({ id: id - V0 + Z0, before, after: this.rawReg(id) })
    }
    const reads = new Set(log.reads.slice(0, log.readN))
    for (const id of [...reads]) if (id >= V0 && id < V0 + 32) reads.add(id - V0 + Z0)
    return {
      pc: log.pc,
      nextPc: this.pcReg,
      reads: [...reads],
      writes,
      memory: log.memAddr.slice(0, log.memN).map((addr, i) => ({ addr, size: log.memSize[i]! })),
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
    const log = this.ring[(this.ringHead + this.ringCount) % RING]!
    const undone = { pc: log.pc, output: log.output }
    this.stdin.length = Math.min(this.stdin.length, log.stdinLen)
    this.rollback(log)
    this.stepCount = log.prevSteps
    this.haltReason = log.prevHalt
    return undone
  }

  private rollback(log: StepLog): void {
    for (let i = log.memN - 1; i >= 0; i--) {
      const a = log.memAddr[i]!
      const size = log.memSize[i]!
      this.rawStore(a, size, log.memOld[i]!)
      this.countWrites(a, size, -1)
    }
    for (let i = log.regN - 1; i >= 0; i--) {
      const id = log.regIds[i]!
      // X0–X30 and SP (31) keep their old values in x64, vectors theirs in bytes.
      this.restoreReg(id, id >= 0 && id <= SP ? log.x64[i]! : bytesReg(id) ? log.kept(log.regOld[i] as number, log.regLen[i]!) : log.regOld[i]!)
    }
    for (let i = log.zaN - 1; i >= 0; i--) this.za.set(log.kept(log.zaOld[i]!, log.zaLen[i]!), log.zaRows[i]! * this.maxSvl)
    if (log.vecSnap) this.vr.set(log.vecSnap)
    if (log.predSnap) this.pr.set(log.predSnap)
    if (log.zaSnap) this.za.set(log.zaSnap)
    if (log.ztSnap) this.zt.set(log.ztSnap)
    for (let i = log.statusN - 1; i >= 0; i--) this.status[log.statusIds[i]!] = log.statusOld[i]!
    if (log.vfs) {
      // The IDE's file store can delete a file that the step created.
      const store = this.env.files
      for (let i = log.vfs.length - 1; i >= 0; i--) {
        const [name, data] = log.vfs[i]!
        if (data) store.write(name, data, false)
        else store.remove?.(name)
      }
    }
    this.os = log.os
    this.monitor = log.monitor
    this.badTarget = log.badTarget
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
    if (id === ZT0) return this.zt.slice()
    if (id === ZA) {
      const out = new Uint8Array(this.svlen * this.svlen)
      for (let r = 0; r < this.svlen; r++) out.set(this.za.subarray(r * this.maxSvl, r * this.maxSvl + this.svlen), r * this.svlen)
      return out
    }
    return new Uint8Array(0)
  }

  lastRowWrites(id: number): { row: number; before: Uint8Array }[] {
    if (id !== ZA || this.ringCount === 0) return []
    const log = this.ring[(this.ringHead + this.ringCount - 1) % RING]!
    const out = new Map<number, Uint8Array>()
    // Enabling or disabling ZA cleared all of it; otherwise the rows written, the first old value of each.
    if (log.zaSnap) for (let r = 0; r < this.svlen; r++) out.set(r, log.zaSnap.slice(r * this.maxSvl, r * this.maxSvl + this.svlen))
    for (let i = 0; i < log.zaN; i++) if (!out.has(log.zaRows[i]!)) out.set(log.zaRows[i]!, log.kept(log.zaOld[i]!, log.zaLen[i]!).slice())
    return [...out].map(([row, before]) => ({ row, before }))
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
    const page = this.written.get(Math.floor(addr / PAGE))
    return page !== undefined && page[(addr - Math.floor(addr / PAGE) * PAGE) >> 2]! > 0
  }

  writtenWords(): number[] {
    const out: number[] = []
    for (const key of [...this.written.keys()].sort((a, b) => a - b)) {
      const page = this.written.get(key)!
      for (let i = 0; i < PAGE / 4; i++) if (page[i]) out.push(key * PAGE + i * 4)
    }
    return out
  }

  /** Count logged stores to the words of [a, a + size) up (d = 1) or back down (d = −1, undo). */
  private countWrites(a: number, size: number, d: number): void {
    for (let w = Math.floor(a / 4) * 4; w < a + size; w += 4) {
      const key = Math.floor(w / PAGE)
      let page = key === this.wKey ? this.wPage : this.written.get(key)
      if (!page) this.written.set(key, (page = new Uint32Array(PAGE / 4)))
      this.wKey = key
      this.wPage = page
      page[(w - key * PAGE) >> 2]! += d
    }
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
    if (id === ZT0) return bigOf(this.zt)
    if (id === ZA) return 0n
    if (id === SP) return this.elv && this.spsel ? this.sp1 : this.sp0
    if (id === PC) return vaOf(this.pcReg)
    if (id <= FLAG_V) return (this.nzcv >> (FLAG_V - id)) & 1
    if (id >= SYS_OFFSET) return this.sysValue(id)
    return 0
  }

  /** Put back a value an undo entry holds. */
  private restoreReg(id: number, old: OldValue): void {
    if (id === NZCV_LOG) this.nzcv = old as number
    else if (!(old instanceof Uint8Array)) this.setRawReg(id, old)
    else if (id >= V0 && id < V0 + 32) this.vr.set(old, (id - V0) * VMAX)
    else if (id >= P0 && id <= FFR) this.pr.set(old, (id - P0) * PMAX)
    else if (id === ZT0) this.zt.set(old)
  }

  private setRawReg(id: number, v: RegValue): void {
    if (id < 31) this.xr[id] = BigInt(v)
    else if (id >= V0 && id < V0 + 32) this.vstore(id - V0, this.vlen, BigInt(v))
    else if (id >= Z0 && id < Z0 + 32) this.vstore(id - Z0, this.vlen, BigInt(v))
    else if (id >= P0 && id <= FFR) this.pstore(id - P0, BigInt(v))
    else if (id === ZT0) storeBig(this.zt, BigInt(v))
    else if (id === ZA) return
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
      case SVCR:
        return BigInt(this.smv | (this.zav << 1))
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
        this.nsvl = Math.min(this.maxVl, 2 ** Math.floor(Math.log2(len + 1)) * 16)
        if (!this.smv) this.vlen = this.nsvl
        return
      }
      case SMCR_EL1: {
        const len = Number(v & 15n)
        this.sys[id - SYS_OFFSET] = BigInt(len)
        this.svlen = Math.min(this.maxSvl, 2 ** Math.floor(Math.log2(len + 1)) * 16)
        if (this.smv) this.vlen = this.svlen
        return
      }
      case SVCR:
        // Only the bits; setSvcr does what a change of mode does to the registers.
        this.smv = Number(v & 1n)
        this.zav = Number((v >> 1n) & 1n)
        this.vlen = this.smv ? this.svlen : this.nsvl
        return
    }
    this.sys[id - SYS_OFFSET] = v
  }

  private markRead(id: number): void {
    const log = this.log
    if (this.recordReads) log.reads[log.readN++] = id
    if (this.status[id] === IDLE) {
      log.statusIds[log.statusN] = id
      log.statusOld[log.statusN++] = IDLE
      this.status[id] = READ
    }
  }

  private markWrite(id: number, old: RegValue): void {
    const log = this.log
    log.regIds[log.regN] = id
    log.regOld[log.regN++] = old
    if (this.status[id] !== WRITTEN) this.statusWritten(id)
  }

  /** markWrite for a vector, predicate or ZT0 register: its old bytes are [from, from + len) of src. */
  private markWriteBytes(id: number, src: Uint8Array, srcWords: Uint32Array, from: number, len: number): void {
    const log = this.log
    const i = log.regN++
    log.regIds[i] = id
    log.regOld[i] = log.keep(src, srcWords, from, len)
    log.regLen[i] = len
    if (this.status[id] !== WRITTEN) this.statusWritten(id)
  }

  private statusWritten(id: number): void {
    const log = this.log
    log.statusIds[log.statusN] = id
    log.statusOld[log.statusN++] = this.status[id]!
    this.status[id] = WRITTEN
  }

  private writeSys(id: number, v: bigint): void {
    this.markWrite(id, this.rawReg(id))
    this.setRawReg(id, v)
  }

  /** The low `bytes` bytes of SIMD&FP register n as a little-endian number. */
  private vbig(n: number, bytes: number): bigint {
    const q = n * (VMAX / 8)
    switch (bytes) {
      case 8:
        return this.vr64[q]!
      case 16:
        return this.vr64[q]! | (this.vr64[q + 1]! << 64n)
      case 4:
        return BigInt(this.vr32[2 * q]!)
      case 2:
        return BigInt(this.vr16[4 * q]!)
      case 1:
        return BigInt(this.vr[8 * q]!)
    }
    let v = 0n
    if (bytes % 8 === 0) for (let i = bytes / 8 - 1; i >= 0; i--) v = (v << 64n) | this.vr64[q + i]!
    else for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.vr[8 * q + i]!)
    return v
  }
  /** Write the low `bytes` bytes of register n (the bytes above stay as they are). */
  private vstore(n: number, bytes: number, v: bigint): void {
    const q = n * (VMAX / 8)
    switch (bytes) {
      case 8:
        // A BigUint64Array keeps the value modulo 2^64.
        this.vr64[q] = v
        return
      case 4:
      case 2:
      case 1:
        // Through the scratch cell: Number() of a bigint is a slow runtime call.
        SC64[0] = v
        if (bytes === 4) this.vr32[2 * q] = SC32[0]!
        else if (bytes === 2) this.vr16[4 * q] = SC32[0]!
        else this.vr[8 * q] = SC32[0]!
        return
    }
    if (bytes % 8 === 0)
      for (let i = 0; i < bytes / 8; i++) {
        this.vr64[q + i] = BigInt.asUintN(64, v)
        v >>= 64n
      }
    else
      for (let i = 0; i < bytes; i++) {
        this.vr[8 * q + i] = Number(v & 0xffn)
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
  get svl(): number {
    return this.svlen
  }
  zaRead(r: number): Uint8Array {
    this.markRead(ZA)
    return this.za.slice(r * this.maxSvl, r * this.maxSvl + this.svlen)
  }
  zaWrite(r: number, data: Uint8Array): void {
    this.logZaRow(r)
    this.za.set(data.subarray(0, this.svlen), r * this.maxSvl)
  }
  zaLanes(r: number, es: number): bigint[] {
    this.markRead(ZA)
    return lanesAt(this.za, r * this.maxSvl, this.svlen >> es, es)
  }
  zaSetLanes(r: number, vals: bigint[], es: number): void {
    this.logZaRow(r)
    storeLanes(vals.length > this.svlen >> es ? vals.slice(0, this.svlen >> es) : vals, es, this.za, r * this.maxSvl)
  }
  /** Keep row r's old bytes for undo. */
  private logZaRow(r: number): void {
    const log = this.log
    // One ZA entry per step (clearZa makes one too, with the whole array in zaSnap).
    if (!log.zaN && !log.zaSnap) this.markWrite(ZA, 0n)
    log.zaRows[log.zaN] = r
    log.zaOld[log.zaN] = log.keep(this.za, this.za32, r * this.maxSvl, this.svlen)
    log.zaLen[log.zaN++] = this.svlen
  }
  zt0Read(): Uint8Array {
    this.markRead(ZT0)
    return this.zt.slice()
  }
  zt0Write(data: Uint8Array): void {
    this.markWriteBytes(ZT0, this.zt, this.zt32, 0, 64)
    this.zt.set(data.subarray(0, 64))
  }
  pread(n: number): Uint8Array {
    this.markRead(P0 + n)
    const out = new Uint8Array(this.vlen)
    const base = n * PMAX
    for (let i = 0; i < this.vlen; i++) out[i] = (this.pr[base + (i >> 3)]! >> (i & 7)) & 1
    return out
  }
  pwrite(n: number, bits: Uint8Array): void {
    const base = n * PMAX
    this.markWriteBytes(P0 + n, this.pr, this.pr32, base, this.vlen / 8)
    this.pr.fill(0, base, base + this.vlen / 8)
    for (let i = 0; i < this.vlen; i++) if (bits[i]) this.pr[base + (i >> 3)]! |= 1 << (i & 7)
  }

  pflags(n: number, es: number): boolean[] {
    this.markRead(P0 + n)
    const out = new Array<boolean>(this.vlen >> es)
    const base = n * PMAX
    for (let i = 0; i < out.length; i++) {
      const bit = i << es
      out[i] = ((this.pr[base + (bit >> 3)]! >> (bit & 7)) & 1) === 1
    }
    return out
  }
  psetFlags(n: number, flags: boolean[], es: number): void {
    const base = n * PMAX
    this.markWriteBytes(P0 + n, this.pr, this.pr32, base, this.vlen / 8)
    this.pr.fill(0, base, base + this.vlen / 8)
    for (let i = 0; i < flags.length; i++) {
      const bit = i << es
      if (flags[i]) this.pr[base + (bit >> 3)]! |= 1 << (bit & 7)
    }
  }

  vread(n: number, bytes: number): Uint8Array {
    this.markRead(V0 + n)
    return this.vr.slice(n * VMAX, n * VMAX + bytes)
  }
  vwrite(n: number, data: Uint8Array): void {
    const base = n * VMAX
    this.markWriteBytes(V0 + n, this.vr, this.vr32, base, this.vlen)
    this.vr.set(data, base)
    this.vr.fill(0, base + data.length, base + this.vlen)
  }
  vlanes(n: number, bytes: number, es: number): bigint[] {
    this.markRead(V0 + n)
    return lanesAt(this.vr, n * VMAX, Math.floor(bytes / (ESIZE[es]! / 8)), es)
  }
  vsetLanes(n: number, vals: bigint[], es: number): void {
    const base = n * VMAX
    this.markWriteBytes(V0 + n, this.vr, this.vr32, base, this.vlen)
    storeLanes(vals, es, this.vr, base)
    this.vr.fill(0, base + (vals.length * ESIZE[es]!) / 8, base + this.vlen)
  }
  vget(n: number, bytes: number): bigint {
    this.markRead(V0 + n)
    return this.vbig(n, bytes)
  }
  vset(n: number, bytes: number, v: bigint, merge?: number): void {
    const base = n * VMAX
    // FEAT_AFP's FPCR.NEP: a scalar result keeps the other bytes of the source register `merge`.
    const keep = merge !== undefined && this.fpcrv & NEP ? this.vbig(merge, 16) : null
    if (keep !== null && merge !== n) this.markRead(V0 + merge!)
    this.markWriteBytes(V0 + n, this.vr, this.vr32, base, this.vlen)
    this.vr.fill(0, base, base + this.vlen)
    if (keep === null) this.vstore(n, bytes, v)
    else {
      const mask = (1n << BigInt(bytes * 8)) - 1n
      this.vstore(n, 16, (keep & ~mask) | (v & mask))
    }
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
    this.markWriteX(n, this.xr[n]!)
    this.xr[n] = v
  }
  setXsp(n: number, v: bigint): void {
    if (n !== 31) return this.setX(n, v)
    v = BigInt.asUintN(64, v)
    if (this.elv && this.spsel) {
      this.markWriteX(SP, this.sp1)
      this.sp1 = v
    } else {
      this.markWriteX(SP, this.sp0)
      this.sp0 = v
    }
  }

  /** markWrite for an X register or SP, keeping the old value in the log's typed array. */
  private markWriteX(id: number, old: bigint): void {
    const log = this.log
    const i = log.regN++
    log.regIds[i] = id
    if (i >= log.x64.length) {
      const grown = new BigUint64Array(log.x64.length * 2)
      grown.set(log.x64)
      log.x64 = grown
    }
    log.x64[i] = old
    if (this.status[id] !== WRITTEN) this.statusWritten(id)
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
    const log = this.log
    log.regIds[log.regN] = NZCV_LOG
    log.regOld[log.regN++] = this.nzcv
    for (let id = FLAG_N; id <= FLAG_V; id++) if (this.status[id] !== WRITTEN) this.statusWritten(id)
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

  /**
   * The permission of the last page checked, while the exception level and the OS state (heap, mappings) stay
   * the same: the memory map's ranges never overlap, so a page wholly inside one has its permission throughout.
   */
  private permKey = -1
  private permEl = 0
  private permOs: OsState | null = null
  private permVal = 0

  /** permission(), remembering whole pages. */
  private pagePermission(a: number, size: number, el: number): number {
    const key = Math.floor(a / PAGE)
    const inPage = a - key * PAGE + size <= PAGE
    if (key === this.permKey && el === this.permEl && this.os === this.permOs && inPage) return this.permVal
    const whole = this.permission(key * PAGE, PAGE, el)
    if (whole > 0) {
      this.permKey = key
      this.permEl = el
      this.permOs = this.os
      this.permVal = whole
      if (inPage) return whole
    }
    return this.permission(a, size, el)
  }

  private check(va: bigint, size: number, write: boolean, acc: number): number {
    const a = addrOf(va)
    const el = acc & ACC.unprivileged ? 0 : this.elv
    const ec = this.elv ? EC.dataAbortSame : EC.dataAbortLower
    const wnr = write ? 1 << 6 : 0
    if (a === null) throw new ArmFault('sigsegv', L(`段错误（SIGSEGV）：${hex16(va)} 不是有效的地址`, `Segmentation fault (SIGSEGV): ${hex16(va)} is not a valid address`), ec, wnr | 0x4, va)
    if (acc & ACC.aligned ? !aligned(a, size) : acc & ACC.lse2 ? Math.floor(a / 16) !== Math.floor((a + size - 1) / 16) : false)
      throw new ArmFault(
        'sigbus',
        L(`总线错误（SIGBUS）：地址 ${hex16(va)} 没有按 ${size} 字节对齐（独占、获取/释放和原子访问必须对齐）`, `Bus error (SIGBUS): address ${hex16(va)} is not ${size}-byte aligned (exclusive, acquire/release and atomic accesses must be)`),
        ec,
        wnr | 0x21,
        va,
      )
    const p = this.pagePermission(a, size, el)
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

  /** The machine address of [va, va + size) when a plain access can read (or write) all of it, else null. */
  private blockAt(va: bigint, size: number, write: boolean): number | null {
    const a = addrOf(va)
    if (a === null) return null
    const p = this.pagePermission(a, size, this.elv)
    return p === 3 || (p === 1 && !write) ? a : null
  }

  loadBlock(addr: bigint, size: number): Uint8Array | null {
    const a = this.blockAt(addr, size, false)
    if (a === null) return null
    const out = new Uint8Array(size)
    let i = 0
    for (; i + 4 <= size; i += 4) {
      const w = this.mem.getWord(a + i)
      out[i] = w
      out[i + 1] = w >>> 8
      out[i + 2] = w >>> 16
      out[i + 3] = w >>> 24
    }
    for (; i < size; i++) out[i] = this.mem.getByte(a + i)
    return out
  }

  storeBlock(addr: bigint, data: Uint8Array): boolean {
    const size = data.length
    const a = this.blockAt(addr, size, true)
    if (a === null) return false
    const log = this.log
    // Logged and written a doubleword at a time, then byte by byte.
    for (let i = 0; i < size; ) {
      const n = size - i >= 8 ? 8 : 1
      log.memAddr[log.memN] = a + i
      log.memSize[log.memN] = n
      log.memOld[log.memN++] = this.rawLoad(a + i, n)
      // Counted per entry, as undo uncounts them.
      this.countWrites(a + i, n, 1)
      this.rawStore(a + i, n, n === 8 ? lanesAt(data, i, 1, 3)[0]! : BigInt(data[i]!))
      i += n
    }
    if (this.monitor && a < this.monitor.addr + this.monitor.size && a + size > this.monitor.addr) this.monitor = null
    return true
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
    log.memAddr[log.memN] = a
    log.memSize[log.memN] = size
    log.memOld[log.memN++] = this.rawLoad(a, size)
    this.countWrites(a, size, 1)
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
    // File contents live in the environment's file store, outside the machine: keep what undo needs before a
    // call on a file (only those calls, so the others stay cheap).
    const nr = Number(this.xr[8]! & 0xffffffffn)
    if (!(nr === 56 || nr === 57 || nr === 62 || ((nr === 63 || nr === 64) && (this.xr[0]! & 0xffffffffn) > 2n))) return syscall(this)
    const log = this.log
    if (!log.vfs) log.vfs = []
    const store = this.env.files
    const before = new Map(store.list().map((name) => [name, store.read(name)]))
    try {
      syscall(this)
    } finally {
      // The store replaces a file's bytes when it is written: an entry that changed is a new array.
      for (const name of new Set([...before.keys(), ...store.list()])) {
        const old = before.get(name) ?? null
        if (store.read(name) !== old && !log.vfs!.some(([n]) => n === name)) log.vfs!.push([name, old])
      }
    }
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
    if (def.id === SVCR) return this.setSvcr(Number(v & 1n), Number((v >> 1n) & 1n))
    if (def.id === SMCR_EL1) {
      // A new streaming vector length leaves ZA, ZT0 and (in Streaming SVE mode) Z and P unknown: zero here.
      const before = this.svlen
      this.writeSys(def.id, v)
      if (this.svlen !== before) {
        if (this.zav) this.clearZa()
        if (this.smv) this.clearVectors()
      }
      return
    }
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
    if (op1 === 3 && op2 === 3) {
      // SMSTART / SMSTOP: CRm<2:1> picks SM, ZA or both, CRm<0> the new value.
      const sm = crm & 2 ? crm & 1 : this.smv
      const za = crm & 4 ? crm & 1 : this.zav
      return this.setSvcr(sm, za)
    }
    if (op1 === 0 && (op2 === 3 || op2 === 4) && this.elv === 0) this.undefinedInstr()
    // UAO, PAN, DIT, SSBS: no effect on this machine.
  }

  /**
   * Change PSTATE.SM and PSTATE.ZA. Entering or leaving Streaming SVE mode zeroes Z, P and FFR and sets FPSR
   * to 0x0800009f; enabling or disabling ZA zeroes ZA and ZT0. Setting a bit to its current value does nothing.
   */
  private setSvcr(sm: number, za: number): void {
    const smChange = sm !== this.smv
    const zaChange = za !== this.zav
    if (!smChange && !zaChange) return
    if (smChange) this.clearVectors()
    if (zaChange) this.clearZa()
    this.writeSys(SVCR, BigInt(sm | (za << 1)))
    if (smChange) this.writeSys(FPSR_ID, BigInt(FPSR_STREAMING))
  }

  /** Zero every Z, P and FFR register (logged for undo before the mode that sets their length changes). */
  private clearVectors(): void {
    const log = this.log
    log.vecSnap ??= this.vr.slice()
    log.predSnap ??= this.pr.slice()
    for (let n = 0; n < 32; n++) this.markWriteBytes(V0 + n, this.vr, this.vr32, n * VMAX, this.vlen)
    for (let n = 0; n <= 16; n++) this.markWriteBytes(P0 + n, this.pr, this.pr32, n * PMAX, this.vlen / 8)
    this.vr.fill(0)
    this.pr.fill(0)
  }

  /** Zero ZA and ZT0 (logged for undo). */
  private clearZa(): void {
    const log = this.log
    log.zaSnap ??= this.za.slice()
    log.ztSnap ??= this.zt.slice()
    this.markWrite(ZA, 0n)
    this.markWriteBytes(ZT0, this.zt, this.zt32, 0, 64)
    this.za.fill(0)
    this.zt.fill(0)
  }

  /** Refuse an instruction that PSTATE.SM or PSTATE.ZA does not allow, as an SME exception (Linux: SIGILL). */
  private checkMode(needs: number): void {
    const text = this.byAddr.get(this.pc)?.basic || hex16(vaOf(this.pc))
    const fail = (smtc: number, zh: string, en: string): never => {
      throw new ArmFault('sigill', L(`非法指令（SIGILL）：${text} ${zh}`, `Illegal instruction (SIGILL): ${text} ${en}`), EC.sme, smtc, null)
    }
    if (needs & NEED.streaming && !this.smv) fail(2, '只能在流式 SVE 模式下执行，先用 smstart 进入', 'runs only in Streaming SVE mode; enter it with smstart first')
    if (needs & NEED.nonStreaming && this.smv) fail(1, '在流式 SVE 模式下不能执行（这台机器和 M5 一样没有 FEAT_SME_FA64），先用 smstop 退出', 'cannot run in Streaming SVE mode (this machine, like the M5, lacks FEAT_SME_FA64); leave it with smstop first')
    if (needs & (NEED.za | NEED.zt0) && !this.zav) fail(3, '要用 ZA，先用 smstart za 打开', 'uses ZA; enable it with smstart za first')
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
