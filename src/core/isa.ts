/**
 * Architecture-neutral contracts.
 *
 * The UI imports only from src/core and from the registry in src/isa/index.ts; it never reaches into an
 * ISA folder. A future ARM or x86-64 port supplies an IsaPlugin and everything else keeps working.
 */

import type { Text } from './i18n'

/** A register value. 32-bit architectures use number (raw two's-complement bits); 64-bit ones use bigint. */
export type RegValue = number | bigint

export interface RegisterSpec {
  /** Flat index into the machine's register state, unique across every bank. */
  id: number
  /** Display name, e.g. "$t0", "x5", "rax". */
  name: string
  /** Architectural number shown next to the name, when the ISA has one. */
  number?: number
  /** Width in bits. A register whose width follows a setting (an SVE Z register) gives its widest. */
  bits: number
  /**
   * int, float, flag and special registers hold one value (readRegister). vector, predicate and matrix
   * registers are read as bytes (readRegisterBytes): a SIMD or SVE vector, an SVE predicate, the SME ZA array.
   */
  kind: 'int' | 'float' | 'flag' | 'special' | 'vector' | 'predicate' | 'matrix'
  /** Writes are discarded ($zero, xzr). */
  hardwired?: boolean
  /** Touched by every step (the PC); not coloured by read/write status. */
  untracked?: boolean
  /** One-line description for tooltips. */
  note?: Text
}

export interface RegisterBank {
  id: string
  title: Text
  registers: RegisterSpec[]
}

export interface MemorySegment {
  id: string
  title: Text
  start: number
  /** Inclusive. */
  end: number
}

export interface MemoryLayout {
  littleEndian: boolean
  segments: MemorySegment[]
  textBase: number
  dataBase: number
  heapBase: number
  /** Initial stack pointer. The stack panel shows words from the current SP up to here. */
  stackBase: number
  stackGrowsDown: boolean
  wordSize: number
  /**
   * 32 (the default): addresses are unsigned 32-bit numbers. 64: addresses are numbers below 2^49; those
   * at or above 2^48 stand for the top half of the address space (0xffff000000000000 + the rest), where
   * kernels live. See vaOf in format.ts.
   */
  addressBits?: 32 | 64
}

export interface Diagnostic {
  severity: 'error' | 'warning'
  message: string
  file: string
  /** 1-based. */
  line: number
  /** 1-based; 0 when the message is about the whole line. */
  col: number
  /** Length of the offending token, for underlining. */
  length?: number
  /** Stable machine-readable kind, e.g. "too-few" or "undefined-symbol" (tests compare these). */
  code?: string
}

export interface ProgramInstruction {
  addr: number
  /** Encoded instruction. Fixed-width ISAs use one word; variable-width ones use bytes. */
  word: number
  bytes?: Uint8Array
  /** The basic (machine-level) instruction as text, e.g. "addiu $t1, $zero, 5". */
  basic: string
  file: string
  /** 1-based source line. */
  line: number
  /** That source line, as written. */
  source: string
  /** Index of this instruction inside its pseudo-instruction expansion, and the expansion length. */
  part: number
  parts: number
}

/** dword is an 8-byte integer (.quad, .xword, .dword). */
export type DataKind = 'dword' | 'word' | 'half' | 'byte' | 'ascii' | 'asciiz' | 'space' | 'float' | 'double'

/** One data-segment declaration; the memory panel shows one entry per declaration. */
export interface DataDeclaration {
  label: string | null
  kind: DataKind
  addr: number
  /** Bytes. */
  size: number
  /** Elements (bytes for strings and .space). */
  count: number
  file: string
  line: number
  segment: string
}

export interface Program {
  isa: string
  /** Address order. */
  instructions: ProgramInstruction[]
  declarations: DataDeclaration[]
  symbols: Record<string, number>
  /** Initial memory contents. */
  image: { addr: number; bytes: Uint8Array }[]
  entry: number
  /**
   * Where each section landed, for ISAs that lay sections out after assembling (AArch64 places .data after
   * .text). `size` counts reserved bytes too (.bss, .skip). MIPS sections sit at fixed addresses and omit it.
   */
  sections?: { name: string; addr: number; size: number }[]
}

export interface AssembleResult {
  ok: boolean
  diagnostics: Diagnostic[]
  program: Program | null
}

export interface SourceFile {
  name: string
  text: string
}

export interface AssembleOptions {
  /** Other files .include can name (the virtual file system). */
  files?: SourceFile[]
}

/** Register status, as the register panel colours it. */
export const IDLE = 0
export const READ = 1
export const WRITTEN = 2
export type RegStatus = typeof IDLE | typeof READ | typeof WRITTEN

export interface RegChange {
  id: number
  before: RegValue
  after: RegValue
}

export interface MemChange {
  addr: number
  size: number
}

export type HaltReason =
  | { kind: 'exit'; code: number | null }
  | { kind: 'dropped-off' }
  | { kind: 'error'; code: string; message: string; addr: number; line: number | null }

export interface StepInfo {
  /** Address of the instruction that ran. */
  pc: number
  nextPc: number
  reads: number[]
  writes: RegChange[]
  memory: MemChange[]
  /** Text the program printed during this step. */
  output: string
  /** Requested pause after this step (syscall 32 sleep, 33 MIDI), in ms; the runner honours it. */
  sleepMs: number
  halted: HaltReason | null
}

export type MachineState = 'ready' | 'waiting' | 'halted'

/** What the program is waiting for when the state is 'waiting'. */
export type InputRequest =
  | { kind: 'line'; prompt?: string; purpose: 'int' | 'float' | 'double' | 'string'; maxLength?: number }
  | { kind: 'char' }
  | { kind: 'dialog'; dialog: DialogRequest }
  | { kind: 'sleep'; ms: number }

export type DialogRequest =
  | { type: 'confirm'; message: string }
  | { type: 'input'; message: string; purpose: 'int' | 'float' | 'double' | 'string'; maxLength?: number }
  | { type: 'message'; message: string; level: 'error' | 'info' | 'warning' | 'question' | 'plain' }

export type DialogResponse =
  | { type: 'confirm'; choice: 'yes' | 'no' | 'cancel' }
  | { type: 'input'; text: string | null }
  | { type: 'message' }

/** Everything outside the CPU: console, files, dialogs, sound, clock. The IDE and the tests implement it. */
export interface Environment {
  print(text: string): void
  /** Return the text, or null to suspend the machine until input arrives. */
  readLine(request: Extract<InputRequest, { kind: 'line' }>): string | null
  readChar(): number | null
  dialog(request: DialogRequest): DialogResponse | null
  files: VirtualFileSystem
  playNote?(pitch: number, durationMs: number, instrument: number, volume: number): void
  now(): number
}

export interface VirtualFileSystem {
  read(name: string): Uint8Array | null
  write(name: string, data: Uint8Array, append: boolean): void
  list(): string[]
}

export interface Machine {
  readonly program: Program
  readonly state: MachineState
  readonly halted: HaltReason | null
  readonly pending: InputRequest | null
  readonly steps: number
  /** Address of the next instruction to execute. */
  readonly programCounter: number
  /** Execute one instruction. When the state is 'waiting', retries the instruction that is waiting. */
  step(): StepInfo
  /** Undo the most recent step. Returns what that step printed (so the console can take it back), or null. */
  undo(): { pc: number; output: string } | null
  readonly canUndo: boolean
  /** Supply what the pending request asked for, then step() completes the waiting instruction. */
  resolve(value: string | number | DialogResponse | null): void
  readRegister(id: number): RegValue
  /** The bytes of a vector, predicate or matrix register, least significant first. */
  readRegisterBytes?(id: number): Uint8Array
  registerStatus(id: number): RegStatus
  readByte(addr: number): number
  readWord(addr: number): number
  /** Has this address been written since the program started? */
  everWritten(addr: number): boolean
  /** Every word address written since the program started (ascending). */
  writtenWords(): number[]
  /** Source line of the instruction at an address, if any. */
  lineAt(addr: number): number | null
  /**
   * Run until halted, waiting for input, a breakpoint, a sleep request, or `limit` steps. Much cheaper
   * than calling step() in a loop. A breakpoint on the first instruction is skipped unless
   * `skipFirstBreak` is false (so resuming from a breakpoint moves on, while a run continued in slices
   * still stops at a breakpoint that falls on a slice boundary).
   */
  run(limit: number, breakpoints: ReadonlySet<number>, skipFirstBreak?: boolean): { steps: number; stop: 'halted' | 'waiting' | 'breakpoint' | 'limit' | 'sleep' }
  /** Set a register before running (the calculator's demo uses it). Not recorded in the undo log. */
  setRegister(id: number, value: RegValue): void
  /** Extra data-memory regions created at run time (heap blocks), shown as memory entries. */
  heapBlocks(): { addr: number; size: number; index: number; /** How it was made, e.g. "sbrk", "malloc". */ note?: string }[]
  /** Pause the most recent step asked for (sleep or sound syscalls), in ms. */
  readonly lastSleep: number
}

/** What a label names: an instruction (branch and jump targets) or a place in data memory. */
export type LabelKind = 'code' | 'data'

export interface CatalogEntry {
  /** Unique key, e.g. "addi" or "li#2". */
  key: string
  mnemonic: string
  /** Example syntax, e.g. "addi $t1, $t2, -100". */
  example: string
  group: string
  pseudo: boolean
  /** May contain {op} placeholders naming the operands of a basic instruction. */
  description: Text
}

/** A decoded instruction split into named bit fields, for the calculator and decoder views. */
export interface FieldView {
  name: string
  /** Display title, e.g. "操作码". */
  title: string
  /** Inclusive bit range, high first. */
  hi: number
  lo: number
  value: number
  /** What this field means for this instruction, e.g. "$t1", "funct = add", "unused". */
  meaning: string
  fixed: boolean
  used: boolean
}

export interface DecodedView {
  ok: boolean
  text: string
  mnemonic: string
  format: string
  fields: FieldView[]
  notes: string[]
  /** What this encoding does, when the mnemonic alone does not say (AArch64 forms share mnemonics). */
  description?: Text
}

/** One operand of a single assembly line, as the calculator edits it. */
export interface LineOperand {
  /** What the ISA calls this kind of operand, e.g. "reg", "freg", "int", "label", "mem". */
  kind: string
  /** As written in the line. */
  text: string
  /** What the form expects here, e.g. "-32768 到 32767 的整数". */
  hint: string
  /** Allowed values, when the operand is a register. */
  options?: string[]
}

export interface LineInstruction {
  addr: number
  word: number
  basic: string
  view: DecodedView
}

/** A single line of assembly, encoded on its own (the calculator). */
export interface LineAnalysis {
  ok: boolean
  error: string | null
  mnemonic: string
  /** The catalog form the assembler picked for this line. */
  entry: CatalogEntry | null
  operands: LineOperand[]
  /** Label operands and the address each one stands for. */
  labels: { name: string; addr: number }[]
  /** The basic instructions the line becomes (one, or a pseudo-instruction's expansion). */
  instructions: LineInstruction[]
  /** A tiny program holding the line, for the step-by-step demo. */
  program: Program | null
  /** Registers the expansion reads before writing them (the demo's starting values), with defaults. */
  inputs: { id: number; value: RegValue }[]
}

/** An example program, written once per language (the code is the same; comments differ). */
export interface ExampleProgram {
  id: string
  title: Text
  text: Text
}

/** A register a reference row reads or writes, and what it holds. */
export interface RefRegister {
  /** Register name as written in source, e.g. "$a0". */
  reg: string
  text: Text
}

/**
 * One row of a reference table: a service number, a register, an exception code, an instruction.
 * Rows either explain themselves in `text`, or list the registers they read and write.
 */
export interface RefRow {
  key: string
  title: Text
  text?: Text
  args?: RefRegister[]
  results?: RefRegister[]
  note?: Text
  /** Source showing the row in use; may span several lines. */
  example?: string
}

/**
 * Reference for instructions that need more than one line: what each value of a register or operand
 * means (MIPS `syscall` picks a service by `$v0`, `mfc0` names a coprocessor 0 register), how a
 * family of instructions works together, or what each assembler directive does.
 */
export interface ReferenceTable {
  id: string
  /** Instructions (or directives) that show this table. */
  mnemonics: string[]
  title: Text
  intro: Text
  /** Header of the key column, e.g. "$v0". */
  keyTitle: Text
  groups: { title?: Text; rows: RefRow[] }[]
}

export interface IsaPlugin {
  id: string
  displayName: string
  available: boolean
  registers: RegisterBank[]
  /** Flat register count (size of status arrays). */
  registerCount: number
  pcRegister: number
  spRegister: number
  fpRegister?: number
  layout: MemoryLayout
  /** Words the editor highlights and completes. */
  language: {
    mnemonics: string[]
    registers: string[]
    directives: string[]
    /** Directives that open a segment (`.text`, `.data`, …): always written in the first column. */
    sections: string[]
    /** The section directives whose labels name memory (`.data`, `.kdata`); every other section holds code. */
    dataSections: string[]
    /**
     * For each mnemonic, the operand positions (0-based, counted by commas) that take a label, and which
     * kind fits there: a branch or jump target ('code') or an address in memory ('data').
     */
    labelOperands: Record<string, Record<number, LabelKind>>
    /** Starts a comment that runs to the end of the line ('#' in MIPS, '//' in GNU as for AArch64). */
    commentChar: string
    /** Starts a comment only as the first text of a line (GNU as for AArch64: '#', which elsewhere marks an immediate). */
    lineStartComment?: string
    /** Opening and closing delimiters of block comments, which may span lines (C-style in GNU as). */
    blockComment?: [string, string]
    /** Separates statements written on one line (GNU as: ';'). */
    statementSeparator?: string
    /** Whether a word is a register, for highlighting. Default: it is listed in `registers`. */
    isRegister?: (word: string) => boolean
    /** The directive that declares each kind of data, for the memory panel. Default: the MIPS names. */
    dataDirectives?: Partial<Record<DataKind, string>>
    /** Extension of source files, for new, example and downloaded files. Default: '.asm' (MARS); GNU as uses '.s'. */
    fileExtension?: string
  }
  catalog: CatalogEntry[]
  /** Catalog groups in display order. */
  catalogGroups: { id: string; title: Text }[]
  examples: ExampleProgram[]
  /** Longer references for instructions a one-line description cannot explain. */
  references?: ReferenceTable[]
  /** Starting content of the instruction set and disassembler tabs. */
  samples: {
    /** The line the instruction set tab opens with. */
    line: string
    /** The disassembler's starting words, one per line (`0x… @ address` allowed). */
    words: string
    /** Words offered as one-click examples in the disassembler, with the mnemonic they decode to. */
    decoderExamples: { word: string; note: string }[]
    /** An instruction that pushes onto the stack, for the empty-stack hint, e.g. "addi $sp, $sp, -4". */
    push: string
  }
  /** The register that always reads zero, if any; the calculator's demo leaves it out of the inputs. */
  zeroRegister?: number
  assemble(source: SourceFile, options?: AssembleOptions): AssembleResult
  createMachine(program: Program, env: Environment): Machine
  /** Decode one instruction word at an address. */
  decode(word: number, addr: number): DecodedView
  /** Encode one line of assembly on its own. `labels` gives addresses to label operands. */
  analyzeLine(line: string, options?: { at?: number; labels?: Record<string, number> }): LineAnalysis
  /** Write a line for a catalog form from its operand texts (the inverse of analyzeLine's operands). */
  buildLine(entryKey: string, operands: string[]): string
  /**
   * Lay a source out in the ISA's house style (the editor's Format command). Only whitespace may change,
   * except that a line break may move a code label onto its own line, so the program assembles the same.
   */
  format?(text: string): string
}
