/**
 * The MIPS machine: registers, memory, one-instruction steps, an undo log, and the read/write status
 * of every register (idle -> read -> written) that the register panel colours.
 *
 * Memory map and behaviour follow MARS 4.5's default configuration: no delay slots, little-endian,
 * the text segment is read-only, and $sp/$gp start where MARS puts them.
 */
import { L, tx, type Text } from '../../core/i18n'
import type {
  DialogRequest,
  DialogResponse,
  Environment,
  HaltReason,
  InputRequest,
  Machine,
  MachineState,
  Program,
  RegChange,
  RegStatus,
  StepInfo,
} from '../../core/isa'
import { IDLE, READ, WRITTEN } from '../../core/isa'
import { bitsFromDouble, bitsFromFloat, doubleFromBits, floatFromBits, hex8 } from '../../core/format'
import { PagedMemory } from '../../core/memory'
import { decodeFields, findDef } from './encoding'
import type { Cpu, Decoded, InstrDef } from './instructions/types'
import { HEAP_LIMIT, KTEXT_BASE, memoryRegion, TEXT_BASE } from './assembler'
import { C0_BY_NUMBER, C0_CAUSE, C0_EPC, C0_STATUS, C0_VADDR, F0, FCC0, GP, HI, LO, REGISTER_COUNT, SP } from './registers'
import { JavaRandom, runSyscall } from './syscalls'

export const INITIAL_SP = 0x7fffeffc
export const INITIAL_GP = 0x10008000
export const HEAP_BASE = 0x10040000
export const EXCEPTION_HANDLER = 0x80000180
const UNDO_LIMIT = 2000

/** MARS exception cause codes. */
export const CAUSE = {
  addressLoad: 4,
  addressStore: 5,
  syscall: 8,
  breakpoint: 9,
  reserved: 10,
  overflow: 12,
  trap: 13,
} as const

/** A runtime error. `cause` is set when a .ktext handler may catch it. */
export class MipsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    override readonly cause: number | null = null,
    readonly badAddr: number | null = null,
  ) {
    super(message)
  }
}

/** Thrown by a syscall that needs input that has not arrived yet. */
export class WaitForInput {
  constructor(readonly request: InputRequest) {}
}

interface Slot {
  def: InstrDef
  d: Decoded
  line: number
}

/** One step's undo record. Records are recycled from a ring, so their arrays are reused. */
class StepLog {
  pc = 0
  prevSteps = 0
  prevHalt: HaltReason | null = null
  heapTop = 0
  heapBlocks = 0
  regIds: number[] = []
  regOld: number[] = []
  statusIds: number[] = []
  statusOld: number[] = []
  /** Stores this step made: start address, size (1, 2 or 4 bytes) and the bytes they replaced. */
  memAddr: number[] = []
  memSize: number[] = []
  memOld: number[] = []
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

const region = memoryRegion

export class MipsMachine implements Machine, Cpu {
  readonly program: Program
  readonly env: Environment

  private gpr = new Int32Array(32)
  private hiReg = 0
  private loReg = 0
  private fpr = new Int32Array(32)
  private fccBits = 0
  private c0Regs = new Int32Array(4)
  private mem = new PagedMemory()
  private status = new Uint8Array(REGISTER_COUNT)
  private written = new Map<number, number>()

  private pcReg = 0
  /** Address of the instruction being executed (Cpu.pc). */
  pc = 0
  private nextPc = 0
  private stepCount = 0
  private haltReason: HaltReason | null = null
  private pendingReq: InputRequest | null = null
  private provided: string | number | DialogResponse | null | undefined = undefined

  private text: (Slot | undefined)[] = []
  private ktext: (Slot | undefined)[] = []
  private textEnd = TEXT_BASE
  private ktextEnd = KTEXT_BASE
  private hasHandler = false

  private recordReads = true
  private ring: StepLog[] = []
  private ringHead = 0
  private ringCount = 0
  private log: StepLog = new StepLog()

  heapTop = HEAP_BASE
  private blocks: { addr: number; size: number; index: number }[] = []
  readonly randoms = new Map<number, JavaRandom>()
  /** Open descriptors. `failed`: a read-open of a missing file, which keeps its descriptor as in MARS. */
  readonly openFiles = new Map<number, { name: string; data: Uint8Array; length: number; pos: number; write: boolean; failed?: boolean }>()

  constructor(program: Program, env: Environment) {
    this.program = program
    this.env = env
    for (const ins of program.instructions) {
      const def = findDef(ins.word)
      if (!def) continue
      const slot: Slot = { def, d: decodeFields(ins.word), line: ins.line }
      if (ins.addr >= KTEXT_BASE) {
        this.ktext[(ins.addr - KTEXT_BASE) >>> 2] = slot
        this.ktextEnd = Math.max(this.ktextEnd, ins.addr + 4)
      } else {
        this.text[(ins.addr - TEXT_BASE) >>> 2] = slot
        this.textEnd = Math.max(this.textEnd, ins.addr + 4)
      }
    }
    this.hasHandler = this.slotAt(EXCEPTION_HANDLER) != null
    for (let i = 0; i < UNDO_LIMIT; i++) this.ring.push(new StepLog())
    this.reset()
  }

  /* ---------------------------------------------------------------- Machine */

  reset(): void {
    this.gpr.fill(0)
    this.gpr[SP] = INITIAL_SP
    this.gpr[GP] = INITIAL_GP
    this.hiReg = 0
    this.loReg = 0
    this.fpr.fill(0)
    this.fccBits = 0
    this.c0Regs.fill(0)
    this.c0Regs[1] = 0x0000ff11
    this.mem = new PagedMemory()
    for (const chunk of this.program.image) this.mem.load(chunk.addr, chunk.bytes)
    this.status.fill(IDLE)
    this.written.clear()
    this.pcReg = this.program.entry
    this.stepCount = 0
    this.haltReason = null
    this.pendingReq = null
    this.provided = undefined
    this.ringHead = 0
    this.ringCount = 0
    this.heapTop = HEAP_BASE
    this.blocks = []
    this.randoms.clear()
    this.openFiles.clear()
    if (!this.slotAt(this.pcReg)) this.haltReason = { kind: 'dropped-off' }
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

  resolve(value: string | number | DialogResponse | null): void {
    this.provided = value
  }

  /** Line of the source for an address, if an instruction is there. */
  lineAt(addr: number): number | null {
    return this.slotAt(addr)?.line ?? null
  }

  private slotAt(addr: number): Slot | undefined {
    addr >>>= 0
    if (addr >= TEXT_BASE && addr < this.textEnd && (addr & 3) === 0) return this.text[(addr - TEXT_BASE) >>> 2]
    if (addr >= KTEXT_BASE && addr < this.ktextEnd && (addr & 3) === 0) return this.ktext[(addr - KTEXT_BASE) >>> 2]
    return undefined
  }

  step(): StepInfo {
    const log = this.beginLog()
    this.execute(log)
    return this.info(log)
  }

  /**
   * Run until halted, waiting for input, a breakpoint, a sleep request, or `limit` steps.
   * Skips the breakpoint check on the first instruction so a run can continue from a breakpoint.
   */
  run(limit: number, breakpoints: ReadonlySet<number>, skipFirstBreak = true): { steps: number; stop: 'halted' | 'waiting' | 'breakpoint' | 'limit' | 'sleep' } {
    let n = 0
    const checkBreaks = breakpoints.size > 0
    const from = skipFirstBreak ? 1 : 0
    // Nobody reads per-step read lists during a run; statuses are still kept.
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

  /** Pause requested by the last step (syscall 32/33), in ms. */
  get lastSleep(): number {
    return this.log.sleep
  }

  private beginLog(): StepLog {
    const log = this.ring[(this.ringHead + this.ringCount) % UNDO_LIMIT]!
    log.reset(this.pcReg)
    log.prevSteps = this.stepCount
    log.prevHalt = this.haltReason
    log.heapTop = this.heapTop
    log.heapBlocks = this.blocks.length
    this.log = log
    return log
  }

  private commit(): void {
    if (this.ringCount < UNDO_LIMIT) this.ringCount++
    else this.ringHead = (this.ringHead + 1) % UNDO_LIMIT
  }

  private execute(log: StepLog): void {
    if (this.haltReason) return
    const pc = this.pcReg
    const slot = this.slotAt(pc)
    this.pc = pc
    this.nextPc = (pc + 4) >>> 0
    if (!slot) {
      this.haltReason = this.badPc(pc)
      this.commit()
      return
    }
    try {
      slot.def.exec(this, slot.d)
      this.provided = undefined
      this.pendingReq = null
      this.pcReg = this.nextPc
      this.stepCount++
      if (!this.haltReason && !this.slotAt(this.pcReg)) this.haltReason = this.badPc(this.pcReg)
      this.commit()
    } catch (e) {
      if (e instanceof WaitForInput) {
        this.rollback(log)
        this.pendingReq = e.request
        return
      }
      if (e instanceof MipsError) {
        this.provided = undefined
        this.pendingReq = null
        this.stepCount++
        if (e.cause != null && this.hasHandler && region(pc) !== 'ktext') this.enterHandler(pc, e)
        else this.haltReason = { kind: 'error', code: e.code, message: e.message, addr: pc, line: slot.line }
        this.commit()
        return
      }
      throw e
    }
  }

  private badPc(addr: number): HaltReason {
    const r = region(addr)
    if ((r === 'text' && addr >= this.textEnd) || (r === 'ktext' && addr >= this.ktextEnd)) return { kind: 'dropped-off' }
    return { kind: 'error', code: 'bad-pc', message: L(`程序计数器的值无效：${hex8(addr)}（跳到了没有指令的地方）`, `Invalid program counter: ${hex8(addr)} (no instruction there)`), addr, line: null }
  }

  private enterHandler(pc: number, e: MipsError): void {
    this.setC0Flat(C0_EPC, pc)
    this.setC0Flat(C0_CAUSE, (this.c0Regs[2]! & ~0x7c) | ((e.cause! & 31) << 2))
    if (e.badAddr != null) this.setC0Flat(C0_VADDR, e.badAddr)
    this.setC0Flat(C0_STATUS, this.c0Regs[1]! | 0x2)
    this.pcReg = EXCEPTION_HANDLER
  }

  private info(log: StepLog): StepInfo {
    const writes: RegChange[] = []
    const seen = new Set<number>()
    for (let i = 0; i < log.regIds.length; i++) {
      const id = log.regIds[i]!
      if (seen.has(id)) continue
      seen.add(id)
      writes.push({ id, before: log.regOld[i]!, after: this.rawReg(id) })
    }
    return {
      pc: log.pc,
      nextPc: this.pcReg,
      reads: [...new Set(log.reads)],
      writes,
      memory: log.memAddr.map((addr, i) => ({ addr, size: log.memSize[i]! })),
      output: log.output,
      sleepMs: log.sleep,
      halted: this.haltReason,
    }
  }

  undo(): { pc: number; output: string } | null {
    if (this.pendingReq) {
      // The waiting instruction never ran; just stop waiting.
      this.pendingReq = null
      this.provided = undefined
    }
    if (this.ringCount === 0) return null
    this.ringCount--
    const log = this.ring[(this.ringHead + this.ringCount) % UNDO_LIMIT]!
    const undone = { pc: log.pc, output: log.output }
    this.rollback(log)
    this.stepCount = log.prevSteps
    this.haltReason = log.prevHalt
    this.heapTop = log.heapTop
    this.blocks.length = log.heapBlocks
    return undone
  }

  /** Revert everything a (possibly partial) step recorded. */
  private rollback(log: StepLog): void {
    for (let i = log.memAddr.length - 1; i >= 0; i--) {
      const a = log.memAddr[i]!
      const size = log.memSize[i]!
      const old = log.memOld[i]!
      for (let j = 0; j < size; j++) this.mem.setByte(a + j, old >>> (8 * j))
      for (let w = (a & ~3) >>> 0; w < a + size; w += 4) {
        const n = (this.written.get(w >>> 0) ?? 1) - 1
        if (n <= 0) this.written.delete(w >>> 0)
        else this.written.set(w >>> 0, n)
      }
    }
    for (let i = log.regIds.length - 1; i >= 0; i--) this.setRawReg(log.regIds[i]!, log.regOld[i]!)
    for (let i = log.statusIds.length - 1; i >= 0; i--) this.status[log.statusIds[i]!] = log.statusOld[i]!
    this.pcReg = log.pc
    log.reset(log.pc)
  }

  readRegister(id: number): number {
    if (id === 78) return this.pcReg
    return this.rawReg(id)
  }

  registerStatus(id: number): RegStatus {
    return this.status[id] as RegStatus
  }

  readByte(addr: number): number {
    return this.mem.getByte(addr)
  }

  readWord(addr: number): number {
    return this.mem.getWord(addr)
  }

  everWritten(addr: number): boolean {
    return this.written.has((addr & ~3) >>> 0)
  }

  heapBlocks(): { addr: number; size: number; index: number }[] {
    return this.blocks.slice()
  }

  writtenWords(): number[] {
    return [...this.written.keys()].sort((a, b) => a - b)
  }

  setRegister(id: number, value: number): void {
    if (id === 78) this.pcReg = value >>> 0
    else if (id !== 0) this.setRawReg(id, value | 0)
  }

  /* ---------------------------------------------------------------- raw register access (no tracking) */

  private rawReg(id: number): number {
    if (id < 32) return this.gpr[id]!
    if (id === HI) return this.hiReg
    if (id === LO) return this.loReg
    if (id < FCC0) return this.fpr[id - F0]!
    if (id < FCC0 + 8) return (this.fccBits >> (id - FCC0)) & 1
    if (id <= C0_EPC) return this.c0Regs[id - C0_VADDR]!
    return 0
  }

  private setRawReg(id: number, v: number): void {
    if (id < 32) this.gpr[id] = v
    else if (id === HI) this.hiReg = v | 0
    else if (id === LO) this.loReg = v | 0
    else if (id < FCC0) this.fpr[id - F0] = v
    else if (id < FCC0 + 8) {
      const bit = 1 << (id - FCC0)
      this.fccBits = v ? this.fccBits | bit : this.fccBits & ~bit
    } else if (id <= C0_EPC) this.c0Regs[id - C0_VADDR] = v
  }

  private markRead(id: number): void {
    if (this.recordReads) this.log.reads.push(id)
    if (this.status[id] === IDLE) {
      this.log.statusIds.push(id)
      this.log.statusOld.push(IDLE)
      this.status[id] = READ
    }
  }

  private markWrite(id: number, old: number): void {
    this.log.regIds.push(id)
    this.log.regOld.push(old)
    if (this.status[id] !== WRITTEN) {
      this.log.statusIds.push(id)
      this.log.statusOld.push(this.status[id]!)
      this.status[id] = WRITTEN
    }
  }

  private setC0Flat(id: number, v: number): void {
    this.markWrite(id, this.rawReg(id))
    this.setRawReg(id, v | 0)
  }

  /* ---------------------------------------------------------------- Cpu */

  g(r: number): number {
    this.markRead(r)
    return this.gpr[r]!
  }

  sg(r: number, value: number): void {
    if (r === 0) return
    this.markWrite(r, this.gpr[r]!)
    this.gpr[r] = value
  }

  hi(): number {
    this.markRead(HI)
    return this.hiReg
  }
  lo(): number {
    this.markRead(LO)
    return this.loReg
  }
  setHi(value: number): void {
    this.markWrite(HI, this.hiReg)
    this.hiReg = value | 0
  }
  setLo(value: number): void {
    this.markWrite(LO, this.loReg)
    this.loReg = value | 0
  }

  fbits(n: number): number {
    this.markRead(F0 + n)
    return this.fpr[n]!
  }
  setFbits(n: number, bits: number): void {
    this.markWrite(F0 + n, this.fpr[n]!)
    this.fpr[n] = bits
  }
  single(n: number): number {
    return floatFromBits(this.fbits(n))
  }
  /**
   * A computed result. MARS stores it with Java's Float.floatToIntBits / Double.doubleToLongBits, which
   * write every NaN as the one canonical pattern, whatever NaN the host arithmetic produced.
   */
  setSingle(n: number, value: number): void {
    this.setFbits(n, Number.isNaN(value) ? 0x7fc00000 : bitsFromFloat(value))
  }
  double(n: number): number {
    const low = this.fbits(n)
    const high = this.fbits(n + 1)
    return doubleFromBits(low, high)
  }
  setDouble(n: number, value: number): void {
    const [low, high] = Number.isNaN(value) ? [0, 0x7ff80000] : bitsFromDouble(value)
    this.setFbits(n, low)
    this.setFbits(n + 1, high)
  }
  requireEven(message: Text, ...regs: number[]): void {
    if (regs.some((r) => r % 2 === 1)) this.fault(tx(message), 'fp-even')
  }
  fcc(cc: number): boolean {
    this.markRead(FCC0 + cc)
    return ((this.fccBits >> cc) & 1) === 1
  }
  setFcc(cc: number, value: boolean): void {
    this.markWrite(FCC0 + cc, (this.fccBits >> cc) & 1)
    const bit = 1 << cc
    this.fccBits = value ? this.fccBits | bit : this.fccBits & ~bit
  }
  c0(number: number): number {
    const id = C0_BY_NUMBER[number]
    if (id == null) return 0
    this.markRead(id)
    return this.rawReg(id)
  }
  setC0(number: number, value: number): void {
    const id = C0_BY_NUMBER[number]
    if (id == null) return
    this.setC0Flat(id, value)
  }

  branch(simm: number): void {
    this.nextPc = (this.pc + 4 + simm * 4) >>> 0
  }
  jump(addr: number): void {
    this.nextPc = addr >>> 0
  }

  private checkLoad(a: number): void {
    const r = region(a)
    if (r == null) throw new MipsError('addr-range', L(`地址越界：${hex8(a)}（这里没有可用的内存）`, `Address out of range: ${hex8(a)} (no memory there)`), CAUSE.addressLoad, a)
    // MARS keeps code out of data memory: a load from either text segment is an address error.
    if (r === 'text' || r === 'ktext') throw new MipsError('text-read', L(`不能直接读代码段：${hex8(a)}`, `Cannot read directly from the text segment: ${hex8(a)}`), CAUSE.addressLoad, a)
  }
  private checkStore(a: number, size: number): void {
    const r = region(a)
    if (r == null) throw new MipsError('addr-range', L(`地址越界：${hex8(a)}（这里没有可用的内存）`, `Address out of range: ${hex8(a)} (no memory there)`), CAUSE.addressStore, a)
    if (r === 'text' || r === 'ktext') throw new MipsError('text-write', L(`不能直接写代码段：${hex8(a)}`, `Cannot write directly to the text segment: ${hex8(a)}`), CAUSE.addressStore, a)
    const log = this.log
    log.memAddr.push(a)
    log.memSize.push(size)
    log.memOld.push(size === 4 ? this.mem.getWord(a) : size === 2 ? this.mem.getHalf(a) : this.mem.getByte(a))
    for (let w = (a & ~3) >>> 0; w < a + size; w += 4) this.written.set(w >>> 0, (this.written.get(w >>> 0) ?? 0) + 1)
  }
  private misaligned(kind: 'load' | 'store', unit: 'word' | 'halfword' | 'doubleword', a: number): never {
    const what = unit === 'word' ? '4' : unit === 'halfword' ? '2' : '8'
    throw new MipsError(
      `${kind}-align`,
      L(`${kind === 'load' ? '读取' : '写入'}地址没有按 ${what} 字节对齐：${hex8(a)}`, `${kind === 'load' ? 'Load' : 'Store'} address not aligned on a ${what}-byte boundary: ${hex8(a)}`),
      kind === 'load' ? CAUSE.addressLoad : CAUSE.addressStore,
      a,
    )
  }

  loadWord(addr: number): number {
    const a = addr >>> 0
    if (a & 3) this.misaligned('load', 'word', a)
    this.checkLoad(a)
    return this.mem.getWord(a)
  }
  loadHalf(addr: number, signed: boolean): number {
    const a = addr >>> 0
    if (a & 1) this.misaligned('load', 'halfword', a)
    this.checkLoad(a)
    const v = this.mem.getHalf(a)
    return signed ? (v << 16) >> 16 : v
  }
  loadByte(addr: number, signed: boolean): number {
    const a = addr >>> 0
    this.checkLoad(a)
    const v = this.mem.getByte(a)
    return signed ? (v << 24) >> 24 : v
  }
  storeWord(addr: number, value: number): void {
    const a = addr >>> 0
    if (a & 3) this.misaligned('store', 'word', a)
    this.checkStore(a, 4)
    this.mem.setWord(a, value)
  }
  storeHalf(addr: number, value: number): void {
    const a = addr >>> 0
    if (a & 1) this.misaligned('store', 'halfword', a)
    this.checkStore(a, 2)
    this.mem.setHalf(a, value)
  }
  storeByte(addr: number, value: number): void {
    const a = addr >>> 0
    this.checkStore(a, 1)
    this.mem.setByte(a, value)
  }
  requireDoubleAligned(addr: number, store: boolean): void {
    if ((addr >>> 0) & 7) this.misaligned(store ? 'store' : 'load', 'doubleword', addr >>> 0)
  }

  overflow(): never {
    throw new MipsError('overflow', L('算术溢出（结果超出 32 位有符号数的范围）', 'Arithmetic overflow (the result does not fit in a signed 32-bit integer)'), CAUSE.overflow)
  }
  trap(): never {
    throw new MipsError('trap', L('陷阱：trap 指令的条件成立', 'Trap: the trap instruction\'s condition holds'), CAUSE.trap)
  }
  breakpoint(code: number | null): never {
    throw new MipsError('break', code == null ? L('执行了 break 指令（没有给代码）', 'break instruction executed (no code)') : L(`执行了 break 指令，代码 = ${code}`, `break instruction executed, code = ${code}`), CAUSE.breakpoint)
  }
  fault(message: string, code = 'fault'): never {
    throw new MipsError(code, message)
  }
  /** A failed system call: a syscall exception (cause 8) that a .ktext handler may catch, as in MARS. */
  syscallFault(message: string, code: string): never {
    throw new MipsError(code, message, CAUSE.syscall)
  }
  syscall(): void {
    runSyscall(this)
  }
  eret(): void {
    this.setC0Flat(C0_STATUS, this.c0Regs[1]! & ~0x2)
    this.markRead(C0_EPC)
    this.nextPc = this.c0Regs[3]! >>> 0
  }

  /* ---------------------------------------------------------------- services for syscalls */

  /** Print text and remember it for this step. */
  out(text: string): void {
    if (!text) return
    this.log.output += text
    this.env.print(text)
  }

  /** Text for a pending line request, from resolve() or the environment; throws WaitForInput if none yet. */
  input(request: Extract<InputRequest, { kind: 'line' }>): string {
    if (typeof this.provided === 'string') {
      const v = this.provided
      this.provided = undefined
      return v
    }
    const v = this.env.readLine(request)
    if (v == null) throw new WaitForInput(request)
    return v
  }

  inputChar(): number {
    if (typeof this.provided === 'number') {
      const v = this.provided
      this.provided = undefined
      return v
    }
    if (typeof this.provided === 'string') {
      const v = this.provided
      this.provided = undefined
      return v.length ? v.charCodeAt(0) : 10
    }
    const v = this.env.readChar()
    if (v == null) throw new WaitForInput({ kind: 'char' })
    return v
  }

  dialog(request: DialogRequest): DialogResponse {
    if (this.provided && typeof this.provided === 'object') {
      const v = this.provided
      this.provided = undefined
      return v
    }
    const v = this.env.dialog(request)
    if (v == null) throw new WaitForInput({ kind: 'dialog', dialog: request })
    return v
  }

  sleep(ms: number): void {
    this.log.sleep = Math.max(this.log.sleep, ms)
  }

  exit(code: number | null): void {
    this.haltReason = { kind: 'exit', code }
  }

  /** Raw memory access for syscalls that move strings and buffers (with write logging). */
  storeBytes(addr: number, bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.storeByte(addr + i, bytes[i]!)
  }

  loadCString(addr: number, max = 1 << 20): Uint8Array {
    const out: number[] = []
    for (let i = 0; i < max; i++) {
      const b = this.loadByte(addr + i, false)
      if (b === 0) break
      out.push(b)
    }
    return Uint8Array.from(out)
  }

  sbrk(bytes: number): number {
    if (bytes < 0) this.syscallFault(L(`sbrk 申请的字节数不能是负数（${bytes}）`, `sbrk cannot allocate a negative number of bytes (${bytes})`), 'sbrk-negative')
    const result = this.heapTop
    // The new top is rounded up to a word and must stay below 0x10400000, where MARS's data memory
    // ends. MARS compares as a signed int, so a request that wraps past 0x7fffffff gets through there
    // and hands out memory it cannot back; here it fails like any other request that is too big.
    const end = this.heapTop + bytes
    const next = end + ((4 - (end % 4)) % 4)
    if (next >= HEAP_LIMIT)
      this.syscallFault(L(`sbrk 申请的 ${bytes} 字节超出了可用的堆空间（堆最多到 0x10400000）`, `sbrk request of ${bytes} bytes exceeds the available heap (which ends at 0x10400000)`), 'sbrk-full')
    this.heapTop = next >>> 0
    if (bytes > 0) this.blocks.push({ addr: result, size: bytes, index: this.blocks.length + 1 })
    return result
  }
}

export function createMachine(program: Program, env: Environment): MipsMachine {
  return new MipsMachine(program, env)
}
