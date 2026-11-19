/** Test helpers: a console Environment that reads stdin the way the MARS command line does. */
import type { DialogRequest, DialogResponse, Environment, InputRequest, VirtualFileSystem } from '../src/core/isa'

export class MemoryFiles implements VirtualFileSystem {
  files = new Map<string, Uint8Array>()
  read(name: string) {
    return this.files.get(name) ?? null
  }
  write(name: string, data: Uint8Array) {
    this.files.set(name, data.slice())
  }
  list() {
    return [...this.files.keys()]
  }
}

/** Line-oriented stdin: every read (int, float, string, char) consumes one line, as in MARS's CLI mode. */
export class ConsoleEnv implements Environment {
  output = ''
  private lines: string[]
  files = new MemoryFiles()
  dialogs: DialogRequest[] = []
  constructor(stdin = '', private clock = 0) {
    this.lines = stdin.split('\n')
    if (this.lines[this.lines.length - 1] === '') this.lines.pop()
  }
  print(text: string) {
    this.output += text
  }
  readLine(_: Extract<InputRequest, { kind: 'line' }>): string | null {
    return this.lines.length ? this.lines.shift()! : ''
  }
  readChar(): number | null {
    const line = this.lines.shift() ?? ''
    return line.length ? line.charCodeAt(0) : -1
  }
  dialog(request: DialogRequest): DialogResponse | null {
    this.dialogs.push(request)
    if (request.type === 'confirm') return { type: 'confirm', choice: 'yes' }
    if (request.type === 'input') return { type: 'input', text: '' }
    return { type: 'message' }
  }
  now() {
    return this.clock
  }
}
