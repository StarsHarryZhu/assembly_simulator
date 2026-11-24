/**
 * One editing-and-running session, independent of any UI framework and of the ISA.
 *
 * Owns the source, the assembled program, the machine, the console, breakpoints and the three ways of
 * running: single step (by instruction or by source line), run to the end, and auto-step at an interval.
 * Listeners are told after every change; the Vue layer turns that into a re-render.
 */
import { sameCode } from './source'
import { L } from './i18n'
import type {
  AssembleResult,
  Diagnostic,
  DialogRequest,
  DialogResponse,
  Environment,
  HaltReason,
  InputRequest,
  IsaPlugin,
  Machine,
  MachineOptions,
  RegChange,
  SourceFile,
  StepInfo,
  VirtualFileSystem,
} from './isa'

export type Mode = 'idle' | 'running' | 'auto'
export type Granularity = 'instruction' | 'line'

export interface ConsoleChunk {
  kind: 'out' | 'in' | 'note' | 'error'
  text: string
  /** Index of the step that produced it; undo removes chunks from undone steps. */
  step: number
}

export interface Message {
  severity: 'error' | 'warning' | 'info'
  text: string
  line?: number
  col?: number
}

/** Files the program can open (syscall 13) and .include can name. */
export class FileStore implements VirtualFileSystem {
  private map = new Map<string, Uint8Array>()
  onChange: () => void = () => {}
  read(name: string) {
    return this.map.get(name) ?? null
  }
  write(name: string, data: Uint8Array) {
    this.map.set(name, data.slice())
    this.onChange()
  }
  remove(name: string) {
    this.map.delete(name)
    this.onChange()
  }
  list() {
    return [...this.map.keys()].sort()
  }
  size(name: string) {
    return this.map.get(name)?.length ?? 0
  }
  text(name: string) {
    const d = this.map.get(name)
    return d ? new TextDecoder().decode(d) : ''
  }
}

/**
 * Run mode works in slices so the page stays responsive: each slice runs chunks of RUN_CHUNK steps until
 * SLICE_MS have passed (or MAX_CHUNKS chunks), then yields to the browser to repaint and handle input.
 */
const RUN_CHUNK = 20_000
const SLICE_MS = 12
const MAX_CHUNKS = 50
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const LINE_STEP_LIMIT = 100_000
const CONSOLE_LIMIT = 400_000

export interface SessionOptions {
  playNote?: Environment['playNote']
  now?: () => number
}

export class Session {
  readonly isa: IsaPlugin
  readonly files = new FileStore()
  file: SourceFile
  result: AssembleResult | null = null
  machine: Machine | null = null
  /** Source text at the last successful assembly, to know when it is stale. */
  private assembledText: string | null = null
  mode: Mode = 'idle'
  interval = 500
  granularity: Granularity = 'line'
  readonly breakpoints = new Set<number>()
  private breakpointAddrs = new Set<number>()
  /** What the most recent step (or line step) changed; null after a run or an undo. */
  last: StepInfo | null = null
  console: ConsoleChunk[] = []
  messages: Message[] = []
  /** A syscall dialog waiting for the user. */
  dialog: DialogRequest | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  private opts: SessionOptions

  constructor(isa: IsaPlugin, file: SourceFile, opts: SessionOptions = {}) {
    this.isa = isa
    this.file = { ...file }
    this.opts = opts
    this.files.onChange = () => this.notify()
  }

  /* ---------------------------------------------------------------- events */

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  /* ---------------------------------------------------------------- environment */

  private readonly env: Environment = {
    print: (text) => this.emit('out', text),
    readLine: () => null,
    readChar: () => null,
    dialog: (request) => {
      this.dialog = request
      return null
    },
    files: this.files,
    playNote: (...a) => this.opts.playNote?.(...a),
    now: () => (this.opts.now ?? Date.now)(),
  }

  private emit(kind: ConsoleChunk['kind'], text: string, step = this.machine?.steps ?? 0): void {
    if (!text) return
    const last = this.console[this.console.length - 1]
    if (last && last.kind === kind && last.step === step) last.text += text
    else this.console.push({ kind, text, step })
    let total = 0
    for (let i = this.console.length - 1; i >= 0; i--) {
      total += this.console[i]!.text.length
      if (total > CONSOLE_LIMIT) {
        this.console.splice(0, i + 1, { kind: 'note', text: L('…（更早的输出已省略）\n', '… (earlier output omitted)\n'), step: -1 })
        break
      }
    }
  }

  clearConsole(): void {
    this.console = []
    this.notify()
  }

  /* ---------------------------------------------------------------- source and assembly */

  get stale(): boolean {
    return this.file.text !== this.assembledText
  }

  get diagnostics(): Diagnostic[] {
    return this.result?.diagnostics ?? []
  }

  setSource(text: string): void {
    if (text === this.file.text) return
    this.file.text = text
    if (this.mode !== 'idle') this.pause()
    this.notify()
  }

  /**
   * Replace the source with a version that has the same code on every line and only different comments
   * (an example following the interface language). The assembled program and the run state stay valid.
   * Anything else is an ordinary edit.
   */
  replaceComments(text: string): void {
    if (text === this.file.text) return
    if (!sameCode(text, this.file.text, this.isa.language.commentChar)) return this.setSource(text)
    this.keepProgram(text)
    this.notify()
  }

  /**
   * Take the formatter's version of the source. When it keeps every line in place, the program is the same
   * and a paused run can go on; a program that has not started is reassembled so messages show the new
   * columns. When lines moved (a label put on its own line), or the text is not the formatter's output, it
   * is an ordinary edit.
   */
  reformat(text: string): void {
    if (text === this.file.text) return
    const before = this.file.text
    if (this.isa.format?.(before) !== text || text.split('\n').length !== before.split('\n').length) return this.setSource(text)
    this.keepProgram(text)
    if (this.mode === 'idle' && !this.stale && (!this.machine || this.machine.steps === 0)) this.assemble()
    else this.notify()
  }

  /** Swap in text with the same instructions on the same lines, keeping the assembled program if it was current. */
  private keepProgram(text: string): void {
    const current = !this.stale
    this.file.text = text
    if (!current) return
    this.assembledText = text
    const lines = text.split('\n')
    for (const ins of this.result?.program?.instructions ?? []) {
      if (ins.file === this.file.name && lines[ins.line - 1] != null) ins.source = lines[ins.line - 1]!
    }
  }

  setName(name: string): void {
    this.file.name = name
    this.notify()
  }

  assemble(): boolean {
    this.stopTimer()
    this.mode = 'idle'
    this.dialog = null
    this.result = this.isa.assemble(this.file, {
      files: this.files.list().map((name) => ({ name, text: this.files.text(name) })),
    })
    this.assembledText = this.file.text
    this.messages = this.result.diagnostics.map((d) => ({
      severity: d.severity,
      text: L(`第 ${d.line} 行${d.col ? `第 ${d.col} 列` : ''}：${d.message}`, `Line ${d.line}${d.col ? `, column ${d.col}` : ''}: ${d.message}`),
      line: d.line,
      col: d.col,
    }))
    this.console = []
    this.last = null
    if (this.result.ok && this.result.program) {
      const p = this.result.program
      this.machine = this.isa.createMachine(p, this.env, this.machineOptions())
      this.messages.push({
        severity: 'info',
        text: L(`汇编成功：${p.instructions.length} 条真指令，${p.declarations.length} 条数据声明。`, `Assembled: ${p.instructions.length} basic instructions, ${p.declarations.length} data declarations.`),
      })
      this.mapBreakpoints()
    } else {
      this.machine = null
      const n = this.result.diagnostics.filter((d) => d.severity === 'error').length
      this.messages.push({ severity: 'error', text: L(`汇编失败：${n} 个错误。`, `Assembly failed: ${n} error(s).`) })
    }
    this.notify()
    return this.result.ok
  }

  /** Assemble if there is no machine yet or the source changed since. */
  private ready(): boolean {
    if (!this.machine || this.stale) return this.assemble()
    return true
  }

  /* ---------------------------------------------------------------- breakpoints */

  toggleBreakpoint(line: number): void {
    if (this.breakpoints.has(line)) this.breakpoints.delete(line)
    else this.breakpoints.add(line)
    this.mapBreakpoints()
    this.notify()
  }

  setBreakpoints(lines: Iterable<number>): void {
    this.breakpoints.clear()
    for (const l of lines) this.breakpoints.add(l)
    this.mapBreakpoints()
    this.notify()
  }

  private mapBreakpoints(): void {
    this.breakpointAddrs.clear()
    const p = this.result?.program
    if (!p) return
    for (const ins of p.instructions) if (ins.part === 0 && ins.file === this.file.name && this.breakpoints.has(ins.line)) this.breakpointAddrs.add(ins.addr)
  }

  /* ---------------------------------------------------------------- state */

  /** Source line of the next instruction to run. */
  get currentLine(): number | null {
    const m = this.machine
    if (!m || m.halted) return null
    return m.lineAt(m.programCounter)
  }

  get halted(): HaltReason | null {
    return this.machine?.halted ?? null
  }

  get pending(): InputRequest | null {
    return this.machine?.pending ?? null
  }

  /** Position of the next instruction inside its pseudo-instruction expansion. */
  get currentPart(): { part: number; parts: number } | null {
    const m = this.machine
    if (!m || m.halted) return null
    const ins = this.result?.program?.instructions.find((i) => i.addr === m.programCounter)
    return ins ? { part: ins.part, parts: ins.parts } : null
  }

  /* ---------------------------------------------------------------- running */

  private stopTimer(): void {
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = null
  }

  pause(): void {
    this.stopTimer()
    this.mode = 'idle'
    this.notify()
  }

  /** Values of the plugin's machine settings; change them with setSetting. */
  readonly settings: Record<string, number> = {}

  private machineOptions(): MachineOptions {
    return { settings: { ...this.settings } }
  }

  /** Change a machine setting; the program starts again with it. */
  setSetting(id: string, value: number): void {
    if (this.settings[id] === value) return
    this.settings[id] = value
    if (this.machine) this.reset()
    else this.notify()
  }

  reset(): void {
    this.stopTimer()
    this.mode = 'idle'
    this.dialog = null
    if (this.stale || !this.machine) {
      this.assemble()
      return
    }
    this.machine = this.isa.createMachine(this.result!.program!, this.env, this.machineOptions())
    this.console = []
    this.last = null
    this.notify()
  }

  /** Report a halt that just happened, once. */
  private noteHalt(before: HaltReason | null): void {
    const h = this.machine?.halted
    if (!h || before) return
    const step = Math.max(0, (this.machine?.steps ?? 1) - 1)
    if (h.kind === 'exit') this.emit('note', L(`\n—— 程序结束${h.code != null ? `，退出码 ${h.code}` : ''} ——\n`, `\n—— Program finished${h.code != null ? `, exit code ${h.code}` : ''} ——\n`), step)
    else if (h.kind === 'dropped-off') this.emit('note', L('\n—— 执行完最后一条指令，程序结束 ——\n', '\n—— Program finished (dropped off the bottom) ——\n'), step)
    else this.emit('error', L(`\n运行出错${h.line != null ? `（第 ${h.line} 行）` : ''}：${h.message}\n`, `\nRuntime error${h.line != null ? ` (line ${h.line})` : ''}: ${h.message}\n`), step)
  }

  /** One instruction, or one source line, depending on granularity. */
  step(): void {
    if (this.mode !== 'idle') this.pause()
    this.stepOnce()
    this.notify()
  }

  private stepOnce(): StepInfo | null {
    if (!this.ready()) return null
    const m = this.machine!
    if (m.halted || m.pending) return null
    const before = m.halted
    let info = m.step()
    if (this.granularity === 'line') {
      let n = 0
      while (!m.halted && !m.pending && n++ < LINE_STEP_LIMIT && this.currentPart && this.currentPart.part !== 0) {
        info = merge(info, m.step())
      }
    }
    this.last = info
    this.noteHalt(before)
    return info
  }

  /** Undo one step. After an edit the old history no longer matches the code, so it reassembles instead. */
  back(): void {
    if (this.mode !== 'idle') this.pause()
    if (!this.machine || this.stale) {
      this.assemble()
      return
    }
    const m = this.machine
    this.dialog = null
    const once = () => {
      const u = m.undo()
      if (!u) return false
      this.console = this.console.filter((c) => c.step < m.steps)
      return true
    }
    if (once() && this.granularity === 'line') {
      let n = 0
      while (this.currentPart && this.currentPart.part !== 0 && n++ < LINE_STEP_LIMIT && once()) {
        /* keep undoing to the start of the line */
      }
    }
    this.last = null
    this.notify()
  }

  run(): void {
    this.startRun(true)
  }

  /** `fromBreakpoint`: the user resumes here, so a breakpoint on the current instruction is passed. */
  private startRun(fromBreakpoint: boolean): void {
    if (!this.ready()) return
    const m = this.machine!
    if (m.halted) return
    this.stopTimer()
    this.mode = 'running'
    this.last = null
    this.notify()
    const slice = (skipFirstBreak: boolean) => {
      this.timer = null
      if (this.mode !== 'running') return
      const before = m.halted
      const deadline = now() + SLICE_MS
      let r = m.run(RUN_CHUNK, this.breakpointAddrs, skipFirstBreak)
      for (let n = 1; r.stop === 'limit' && n < MAX_CHUNKS && now() < deadline; n++) r = m.run(RUN_CHUNK, this.breakpointAddrs, false)
      this.noteHalt(before)
      if (r.stop === 'limit') this.timer = setTimeout(() => slice(false), 0)
      else if (r.stop === 'sleep') this.timer = setTimeout(() => slice(false), m.lastSleep ?? 0)
      else if (r.stop === 'waiting') {
        /* stay in run mode; input resumes it */
      } else {
        this.mode = 'idle'
        if (r.stop === 'breakpoint') this.emit('note', L(`\n—— 停在断点（第 ${this.currentLine} 行）——\n`, `\n—— Stopped at breakpoint (line ${this.currentLine}) ——\n`))
      }
      this.notify()
    }
    this.timer = setTimeout(() => slice(fromBreakpoint), 0)
  }

  auto(): void {
    if (!this.ready()) return
    const m = this.machine!
    if (m.halted) return
    this.stopTimer()
    this.mode = 'auto'
    const tick = (first: boolean) => {
      this.timer = null
      if (this.mode !== 'auto') return
      if (!first && this.breakpointAddrs.has(m.programCounter)) {
        this.mode = 'idle'
        this.emit('note', L(`\n—— 停在断点（第 ${this.currentLine} 行）——\n`, `\n—— Stopped at breakpoint (line ${this.currentLine}) ——\n`))
        this.notify()
        return
      }
      const info = this.stepOnce()
      this.notify()
      if (!info || m.halted) {
        if (m.halted) this.mode = 'idle'
        if (!m.pending) this.mode = 'idle'
        this.notify()
        return
      }
      if (m.pending) return
      this.timer = setTimeout(() => tick(false), Math.max(this.interval, info.sleepMs, 16))
    }
    tick(true)
  }

  setInterval(ms: number): void {
    this.interval = ms
    this.notify()
  }

  setGranularity(g: Granularity): void {
    this.granularity = g
    this.notify()
  }

  /* ---------------------------------------------------------------- input */

  /** The user typed a line (or a character) the program asked for. */
  submit(value: string): void {
    const m = this.machine
    const req = m?.pending
    if (!m || !req) return
    if (req.kind === 'char') {
      const code = value.length ? value.charCodeAt(0) : 10
      this.emit('in', value.length ? value[0]! : '\n')
      m.resolve(code)
    } else if (req.kind === 'line') {
      this.emit('in', value + '\n')
      m.resolve(value)
    } else return
    this.continueAfterInput()
  }

  answerDialog(response: DialogResponse): void {
    const m = this.machine
    if (!m || m.pending?.kind !== 'dialog') return
    this.dialog = null
    m.resolve(response)
    this.continueAfterInput()
  }

  private continueAfterInput(): void {
    if (this.mode === 'running') {
      // complete the waiting instruction, then keep running
      const before = this.machine!.halted
      this.machine!.step()
      this.noteHalt(before)
      this.notify()
      if (!this.machine!.halted) this.startRun(false)
      else {
        this.mode = 'idle'
        this.notify()
      }
      return
    }
    if (this.mode === 'auto') {
      const before = this.machine!.halted
      this.last = this.machine!.step()
      this.noteHalt(before)
      this.notify()
      if (this.machine!.halted) this.mode = 'idle'
      else this.timer = setTimeout(() => this.auto(), Math.max(this.interval, 16))
      this.notify()
      return
    }
    const before = this.machine!.halted
    this.last = this.machine!.step()
    this.noteHalt(before)
    this.notify()
  }

  dispose(): void {
    this.stopTimer()
    this.listeners.clear()
  }
}

/** Combine consecutive steps (a line step): first "before", last "after". */
function merge(a: StepInfo, b: StepInfo): StepInfo {
  const writes = new Map<number, RegChange>()
  for (const w of a.writes) writes.set(w.id, { ...w })
  for (const w of b.writes) {
    const prev = writes.get(w.id)
    writes.set(w.id, prev ? { id: w.id, before: prev.before, after: w.after } : { ...w })
  }
  return {
    pc: a.pc,
    nextPc: b.nextPc,
    reads: [...new Set([...a.reads, ...b.reads])],
    writes: [...writes.values()],
    memory: [...a.memory, ...b.memory],
    output: a.output + b.output,
    sleepMs: a.sleepMs + b.sleepMs,
    halted: b.halted,
  }
}
