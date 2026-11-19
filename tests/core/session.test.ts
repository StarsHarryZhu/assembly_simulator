/** Session: the IDE's run controls, independent of the UI. Timers are faked so run/auto slices are deterministic. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../../src/core/session'
import { mips } from '../../src/isa/mips'

const example = (id: string) => mips.examples.find((e) => e.id === id)!.text.zh
const out = (s: Session) => s.console.filter((c) => c.kind === 'out' || c.kind === 'in').map((c) => c.text).join('')

describe('Session', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs to the end in slices and reports the halt', () => {
    const s = new Session(mips, { name: 'w.asm', text: example('welcome') })
    s.run()
    expect(s.mode).toBe('running')
    vi.runAllTimers()
    expect(s.mode).toBe('idle')
    expect(out(s)).toBe('sum = 31\n')
    expect(s.halted?.kind).toBe('exit')
    expect(s.console.at(-1)?.text).toContain('程序结束')
  })

  it('stops at breakpoints and continues past them', () => {
    const s = new Session(mips, { name: 'f.asm', text: example('factorial') })
    s.setBreakpoints([31]) // jal fact inside the recursion
    s.run()
    vi.runAllTimers()
    expect(s.currentLine).toBe(31)
    const first = s.machine!.steps
    s.run()
    vi.runAllTimers()
    expect(s.currentLine).toBe(31)
    expect(s.machine!.steps).toBeGreaterThan(first)
  })

  it('stops at a breakpoint inside a loop that runs over many slices', () => {
    const text = '.text\nmain:\n li $t0, 0\nloop:\n addi $t0, $t0, 1\n blt $t0, 300000, loop\n li $t1, 7\n li $v0, 10\n syscall\n'
    const s = new Session(mips, { name: 'l.asm', text })
    s.setBreakpoints([7]) // li $t1, 7, after the loop
    s.run()
    vi.runAllTimers()
    expect(s.currentLine).toBe(7)
    expect(s.machine!.readRegister(8)).toBe(300000)
    s.run()
    vi.runAllTimers()
    expect(s.halted?.kind).toBe('exit')
  })

  it('steps back, taking back register changes and output', () => {
    const s = new Session(mips, { name: 'h.asm', text: example('hello') })
    s.setGranularity('instruction')
    s.step() // li $v0, 4
    s.step() // la: lui
    s.step() // la: ori
    s.step() // syscall prints
    expect(out(s)).toBe('Hello, world!\n')
    expect(s.last?.output).toBe('Hello, world!\n')
    s.back()
    expect(out(s)).toBe('')
    expect(s.machine!.steps).toBe(3)
    s.back()
    s.back()
    expect(s.machine!.readRegister(4)).toBe(0)
  })

  it('steps a whole source line by default', () => {
    const s = new Session(mips, { name: 'h.asm', text: example('hello') })
    expect(s.granularity).toBe('line')
    s.step() // li
    s.step() // la = lui + ori
    expect(s.machine!.steps).toBe(3)
    expect(s.last?.writes.map((w) => w.id)).toEqual([1, 4]) // $at then $a0, merged
    s.back()
    expect(s.machine!.steps).toBe(1)
  })

  it('auto-steps at the interval and stops at the end', () => {
    const s = new Session(mips, { name: 'h.asm', text: example('hello') })
    s.setInterval(100)
    s.setGranularity('instruction')
    s.auto()
    expect(s.machine!.steps).toBe(1)
    vi.advanceTimersByTime(100)
    expect(s.machine!.steps).toBe(2)
    vi.runAllTimers()
    expect(s.mode).toBe('idle')
    expect(s.halted?.kind).toBe('exit')
  })

  it('waits for input while running and resumes after submit', () => {
    const s = new Session(mips, { name: 'i.asm', text: example('input') })
    s.run()
    vi.runAllTimers()
    expect(s.pending).toMatchObject({ kind: 'line', purpose: 'string' })
    s.submit('Ada')
    vi.runAllTimers()
    expect(s.pending).toMatchObject({ kind: 'line', purpose: 'int' })
    s.submit('20')
    vi.runAllTimers()
    expect(out(s)).toBe('What is your name? Ada\nHow old are you? 20\nHello, Ada\nNext year you will be 21\n')
    expect(s.mode).toBe('idle')
  })

  it('reassembles instead of stepping back after an edit', () => {
    const s = new Session(mips, { name: 'x.asm', text: example('hello') })
    s.step()
    s.step()
    s.setSource(example('hello') + '\n# edited\n')
    s.back()
    expect(s.stale).toBe(false)
    expect(s.machine!.steps).toBe(0)
  })

  it('reassembles when the source changed and reports errors with positions', () => {
    const s = new Session(mips, { name: 'x.asm', text: example('hello') })
    s.setSource('main: addi $t0, $t1\n')
    expect(s.stale).toBe(true)
    s.step()
    expect(s.machine).toBeNull()
    expect(s.messages[0]).toMatchObject({ severity: 'error', line: 1 })
  })
})
