/**
 * Compare our assembler and simulator with MARS 4.5 on every program in tests/golden/programs.
 * Expected results were produced by scripts/mars-golden.mjs and are committed; MARS itself is not needed here.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assemble } from '../src/isa/mips/assembler'
import { createMachine } from '../src/isa/mips/cpu'
import { F0, HI, LO } from '../src/isa/mips/registers'
import { ConsoleEnv } from './helpers'

const ROOT = join(import.meta.dirname, 'golden')
const names = readdirSync(join(ROOT, 'expected'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort()

interface Golden {
  assemble: { ok: boolean; errors: { line: number; col: number; message: string }[]; text?: [number, number, number][]; data?: number[] }
  run?: { stdout: string; messages: string; regs: Record<string, number>; mem: Record<string, number> }
}

/** MARS assembler messages -> our diagnostic codes. */
const ASM_CODES: [RegExp, string][] = [
  [/operand is out of range/, 'out-of-range'],
  [/operand is of incorrect type/, 'bad-type'],
  [/Too few or incorrectly formatted operands/, 'too-few'],
  [/Too many or incorrectly formatted operands/, 'too-many'],
  [/is not a recognized operator/, 'unknown-op'],
  [/not found in symbol table/, 'undefined-symbol'],
  [/already defined/, 'duplicate-label'],
  [/directive cannot appear in text segment/, 'dir-in-text'],
  [/is not a valid integer constant or label/, 'bad-data-value'],
  [/requires a non-negative integer/, 'space-negative'],
  [/is an out-of-range value/, 'float-range'],
  [/Error reading include file/, 'include'],
  [/Macro started but not ended/, 'macro-unterminated'],
]

/** MARS runtime messages -> our halt codes. */
const RUN_CODES: [RegExp, string][] = [
  [/arithmetic overflow/, 'overflow'],
  [/address out of range/, 'addr-range'],
  [/fetch address not aligned/, 'load-align'],
  [/store address not aligned/, 'store-align'],
  [/^trap$/, 'trap'],
  [/break instruction executed/, 'break'],
  [/invalid or unimplemented syscall/, 'syscall-invalid'],
  [/invalid program counter/, 'bad-pc'],
  [/Cannot write directly to text segment/, 'text-write'],
  [/invalid integer input/, 'input-int'],
  [/invalid float input|invalid double input/, 'input-float'],
  [/must be even-numbered/, 'fp-even'],
  [/Upper bound of range cannot be negative/, 'random-bound'],
]

function codeOf(table: [RegExp, string][], message: string): string {
  for (const [re, code] of table) if (re.test(message)) return code
  return 'unknown:' + message
}

const hex = (v: number) => '0x' + (v >>> 0).toString(16).padStart(8, '0')

describe.each(names)('%s', (name) => {
  const g: Golden = JSON.parse(readFileSync(join(ROOT, 'expected', `${name}.json`), 'utf8'))
  const file = name.startsWith('example-')
    ? join(import.meta.dirname, '..', 'src', 'isa', 'mips', 'examples', `${name.slice(8)}.asm`)
    : join(ROOT, 'programs', `${name}.asm`)
  const source = readFileSync(file, 'utf8')
  const result = assemble({ name: `${name}.asm`, text: source })

  it('assembles like MARS', () => {
    if (!g.assemble.ok) {
      expect(result.ok).toBe(false)
      const want = g.assemble.errors.map((e) => `${e.line}:${e.col} ${codeOf(ASM_CODES, e.message)}`)
      const got = result.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.line}:${d.col} ${d.code}`)
      expect(got).toEqual(want)
      return
    }
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const program = result.program!
    const got = program.instructions.filter((i) => i.addr < 0x80000000).map((i) => `${hex(i.addr)} ${hex(i.word)} ${i.line}`)
    const want = g.assemble.text!.map(([a, w, l]) => `${hex(a)} ${hex(w)} ${l}`)
    // Compare line by line so a failure names the first differing instruction.
    for (let i = 0; i < Math.max(got.length, want.length); i++) {
      if (got[i] !== want[i]) {
        const line = Number((want[i] ?? got[i])!.split(' ')[2])
        expect(`${got[i]}  <- ${source.split('\n')[line - 1]?.trim()}`).toBe(`${want[i]}  <- ${source.split('\n')[line - 1]?.trim()}`)
      }
    }
    // Data segment from 0x10010000, as words.
    const data: number[] = []
    const machine = createMachine(program, new ConsoleEnv())
    for (let i = 0; i < Math.max(g.assemble.data!.length, 1); i++) data.push(machine.readWord(0x10010000 + 4 * i) >>> 0)
    while (data.length && data[data.length - 1] === 0) data.pop()
    expect(data.map(hex)).toEqual(g.assemble.data!.map(hex))
  })

  if (g.run) {
    it('runs like MARS', () => {
      expect(result.ok).toBe(true)
      const input = existsSync(join(ROOT, 'programs', `${name}.in`)) ? readFileSync(join(ROOT, 'programs', `${name}.in`), 'utf8') : ''
      const env = new ConsoleEnv(input)
      const m = createMachine(result.program!, env)
      const limit = Number(/#\s*golden:.*steps=(\d+)/.exec(source)?.[1] ?? 5_000_000)
      m.run(limit, new Set())
      expect(env.output).toBe(g.run!.stdout)
      const err = /Runtime exception at 0x[0-9a-f]+: (.*)$|Error in : (.*)$/m.exec(g.run!.messages)
      if (err) {
        expect(m.halted?.kind).toBe('error')
        expect((m.halted as { code: string }).code).toBe(codeOf(RUN_CODES, (err[1] ?? err[2])!.trim()))
      } else {
        expect(m.halted?.kind === 'error' ? m.halted.message : 'ok').toBe('ok')
      }
      const regs: Record<string, string> = {}
      const want: Record<string, string> = {}
      for (const [k, v] of Object.entries(g.run!.regs)) {
        if (k === 'pc') continue
        want[k] = hex(v)
        const id = k === 'hi' ? HI : k === 'lo' ? LO : k.startsWith('$f') ? F0 + Number(k.slice(2)) : Number(k.slice(1))
        regs[k] = hex(m.readRegister(id) as number)
      }
      expect(regs).toEqual(want)
      const mem: Record<string, string> = {}
      const wantMem: Record<string, string> = {}
      for (const [a, v] of Object.entries(g.run!.mem)) {
        wantMem[a] = hex(v)
        mem[a] = hex(m.readWord(parseInt(a, 16)))
      }
      expect(mem).toEqual(wantMem)
    })
  }
})
