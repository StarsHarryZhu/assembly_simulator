/** Register status colours, undo, waiting for input, and run() stop reasons. */
import { describe, expect, it } from 'vitest'
import { IDLE, READ, WRITTEN } from '../../src/core/isa'
import { assemble } from '../../src/isa/mips/assembler'
import { createMachine } from '../../src/isa/mips/cpu'
import { A0, HI, LO, SP, T0, T1, T2, V0 } from './regs'
import { ConsoleEnv } from '../helpers'

function machine(src: string, env = new ConsoleEnv()) {
  const r = assemble({ name: 't.asm', text: src })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  return { m: createMachine(r.program!, env), env, program: r.program! }
}

describe('register status', () => {
  it('starts idle, turns read, then written, and never goes back', () => {
    const { m } = machine('li $t0, 5\nadd $t1, $t0, $t0\nadd $t0, $t1, $zero\nmove $t2, $t0')
    expect(m.registerStatus(T0)).toBe(IDLE)
    m.step()
    expect(m.registerStatus(T0)).toBe(WRITTEN)
    m.step()
    expect(m.registerStatus(T1)).toBe(WRITTEN)
    expect(m.registerStatus(0)).toBe(READ)
    m.step()
    m.step()
    expect(m.registerStatus(T2)).toBe(WRITTEN)
    expect(m.registerStatus(SP)).toBe(IDLE)
  })

  it('does not count a write to $zero as a modification', () => {
    const { m } = machine('addi $zero, $zero, 5')
    const info = m.step()
    expect(info.writes).toEqual([])
    expect(m.registerStatus(0)).toBe(READ)
  })

  it("reports this step's writes with before and after values", () => {
    const { m } = machine('li $t0, 3\nmult $t0, $t0')
    m.step()
    const info = m.step()
    expect(info.writes.map((w) => [w.id, w.before, w.after])).toEqual([
      [HI, 0, 0],
      [LO, 0, 9],
    ])
    expect(info.reads).toEqual([T0])
  })
})

describe('undo', () => {
  it('restores registers, memory, status and the PC', () => {
    const { m } = machine('.data\nw: .word 7\n.text\nla $t0, w\nli $t1, 9\nsw $t1, 0($t0)')
    m.step() // lui  (la expands to lui + ori)
    m.step() // ori
    m.step() // li
    const before = m.programCounter
    const info = m.step()
    expect(info.memory).toEqual([{ addr: 0x10010000, size: 4 }])
    expect(m.readWord(0x10010000)).toBe(9)
    expect(m.everWritten(0x10010000)).toBe(true)
    expect(m.undo()).not.toBeNull()
    expect(m.readWord(0x10010000)).toBe(7)
    expect(m.everWritten(0x10010000)).toBe(false)
    expect(m.programCounter).toBe(before)
    m.undo()
    expect(m.readRegister(T1)).toBe(0)
    expect(m.registerStatus(T1)).toBe(IDLE)
    expect(m.steps).toBe(2)
  })

  it('un-halts a finished program and returns the printed text', () => {
    const { m } = machine('li $a0, 42\nli $v0, 1\nsyscall\nli $v0, 10\nsyscall')
    m.run(100, new Set())
    expect(m.halted).toEqual({ kind: 'exit', code: null })
    m.undo()
    expect(m.halted).toBeNull()
    m.undo()
    expect(m.undo()).toEqual({ pc: 0x00400008, output: '42' })
  })
})

describe('input', () => {
  it('waits when no input is available and finishes after resolve()', () => {
    const env = new ConsoleEnv()
    env.readLine = () => null
    const { m } = machine('li $v0, 5\nsyscall\nmove $t0, $v0', env)
    m.step()
    const info = m.step()
    expect(m.state).toBe('waiting')
    expect(m.pending).toEqual({ kind: 'line', purpose: 'int' })
    expect(info.writes).toEqual([])
    expect(m.registerStatus(V0)).toBe(WRITTEN)
    m.resolve('123')
    m.step()
    expect(m.state).toBe('ready')
    expect(m.readRegister(V0)).toBe(123)
    m.step()
    expect(m.readRegister(T0)).toBe(123)
  })

  it('stops run() at a breakpoint, a sleep, and a wait', () => {
    const env = new ConsoleEnv()
    env.readLine = () => null
    const { m, program } = machine('li $a0, 1\nli $v0, 32\nsyscall\nli $t0, 1\nli $v0, 5\nsyscall', env)
    const bp = new Set([program.instructions[4]!.addr])
    expect(m.run(100, new Set()).stop).toBe('sleep')
    expect(m.run(100, bp).stop).toBe('breakpoint')
    expect(m.run(100, bp).stop).toBe('waiting')
    expect(m.readRegister(A0)).toBe(1)
  })

  it('stops at a breakpoint that falls on a slice boundary when told not to skip it', () => {
    const { m, program } = machine('li $t0, 1\nli $t0, 2\nli $t0, 3\nli $t0, 4')
    const bp = new Set([program.instructions[2]!.addr])
    expect(m.run(2, bp).stop).toBe('limit')
    expect(m.run(100, bp, false)).toEqual({ steps: 0, stop: 'breakpoint' })
    expect(m.run(100, bp).stop).toBe('halted')
  })
})
