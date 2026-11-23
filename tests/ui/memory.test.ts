/** The memory panel's entries stay cheap and correct for kernel addresses and large buffers. */
import { describe, expect, it } from 'vitest'
import { Session } from '../../src/core/session'
import { mips } from '../../src/isa/mips'
import type { DataKind } from '../../src/core/isa'
import { charOf } from '../../src/core/format'
import { elementCount, elementText, kindTitle, memoryEntries } from '../../src/ui/ide/memoryEntries'

const exceptions = mips.examples.find((e) => e.id === 'exceptions')!.text.en

function entries(s: Session, views?: Map<string, DataKind>) {
  return memoryEntries(s.machine!, s.result!.program!, mips, s.file.name, s.last?.memory ?? [], views)
}

function assembled(text: string) {
  const s = new Session(mips, { name: 'm.asm', text })
  s.assemble()
  return s
}

describe('memoryEntries', () => {
  it('handles .kdata above 0x80000000 quickly (it used to scan half the address space)', () => {
    const s = new Session(mips, { name: 'x.asm', text: exceptions })
    for (let i = 0; i < 5; i++) s.step()
    const t0 = performance.now()
    const list = entries(s)
    expect(performance.now() - t0).toBeLessThan(50)
    const k = list.find((e) => e.title === 'kmsg')!
    expect(k.addr).toBe(0x90000000)
    expect(k.note).toBe('.kdata')
    expect(k.ever).toBe(false)
  })

  it('summarizes a large .space by its written words only', () => {
    const text = '.data\nbuf: .space 0x400000\n.text\n la $t0, buf\n li $t1, 7\n sw $t1, 0x1000($t0)\n li $v0, 10\n syscall\n'
    const s = new Session(mips, { name: 'b.asm', text })
    s.assemble()
    const before = entries(s).find((e) => e.title === 'buf')!
    expect(before.summary).toContain('all zero')
    s.setGranularity('instruction')
    for (let i = 0; i < 4; i++) s.step()
    const t0 = performance.now()
    const after = entries(s).find((e) => e.title === 'buf')!
    expect(performance.now() - t0).toBeLessThan(50)
    expect(after.ever).toBe(true)
    expect(after.flash).toBe(true)
    expect(after.summary).not.toContain('all zero')
  })

  it('groups undeclared writes into runs', () => {
    const text = '.text\n li $t0, 0x10020000\n sw $t0, 0($t0)\n sw $t0, 4($t0)\n sw $t0, 12($t0)\n li $v0, 10\n syscall\n'
    const s = new Session(mips, { name: 'w.asm', text })
    s.run()
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const others = entries(s).filter((e) => e.key.startsWith('w'))
        expect(others.map((e) => [e.addr, e.count])).toEqual([
          [0x10020000, 2],
          [0x1002000c, 1],
        ])
        resolve()
      }, 50)
    })
  })

  it('puts unlabelled declarations under the label above: the same kind joins it, any other is named by its offset', () => {
    const text = [
      '.data',
      '.word 0',
      'A: .word 1, 2, 3, 4',
      '   .word 5, 6, 7, 8',
      'msg: .ascii "Hello, "',
      '     .asciiz "world"',
      'B: .word 9',
      '   .byte 1, 2',
      '   .word 3',
      'x: .byte 1',
      '   .align 3',
      '   .byte 2',
      '.data 0x10010100',
      '   .word 4',
      '.text',
      'nop',
    ].join('\n')
    const list = entries(assembled(text))
    expect(list.map((e) => [e.title, e.kind, e.count])).toEqual([
      ['(no label)', 'word', 1],
      ['A', 'word', 8],
      ['msg', 'asciiz', 13],
      ['B', 'word', 1],
      ['B+4', 'byte', 2],
      ['B+8', 'word', 1],
      ['x', 'byte', 1],
      ['x+8', 'byte', 1],
      ['(no label)', 'word', 1],
    ])
    expect(list[1]!.summary).toBe('[1, 2, 3, 4, 5, 6, 7, 8]')
    expect(list[1]!.size).toBe(32)
    expect(list[2]!.summary).toBe('"Hello, world"')
  })

  it('reads an entry as another kind, keyed by its label so the choice survives moved lines', () => {
    const text = '.data\nbuf: .space 10\nw: .word 0x12345678\n.text\n la $t0, buf\n li $t1, 0x64636261\n sw $t1, 0($t0)\n li $t1, 5\n sw $t1, 4($t0)\n'
    const s = assembled(text)
    for (let i = 0; i < 5; i++) s.step()
    const views = new Map<string, DataKind>([
      ['lbuf', 'word'],
      ['lw', 'space'],
    ])
    const [buf, w] = entries(s, views)
    expect([buf!.view, buf!.summary]).toEqual(['word', '[1684234849, 5]'])
    expect(elementCount(buf!, 'word')).toBe(2)
    expect(elementCount(buf!, 'double')).toBe(1)
    // A word's bytes, lowest address first: MIPS in MARS is little-endian.
    expect([w!.view, w!.summary]).toEqual(['space', '[78 56 34 12]'])
    views.set('lbuf', 'asciiz')
    expect(entries(s, views)[0]!.summary).toBe(`"abcd${charOf(5)}"`)
    views.set('lbuf', 'byte')
    expect(entries(s, views)[0]!.summary).toBe('[97, 98, 99, 100, 5, 0, 0, 0, 0, 0]')
    // Without a choice, an entry is read as its own kind; a label keeps its choice when lines move.
    expect(entries(s)[0]!.view).toBe('space')
    expect(entries(assembled('\n\n' + text), new Map([['lbuf', 'word']]))[0]!.view).toBe('word')
  })

  it('still says an untouched .space is all zero, whatever it is read as', () => {
    const s = assembled('.data\nbuf: .space 64\n.text\nnop\n')
    for (const view of ['space', 'word', 'asciiz', 'double'] as DataKind[]) expect(entries(s, new Map([['lbuf', view]]))[0]!.summary).toBe('64 bytes, all zero')
  })

  it('reads 8-byte integers, and names kinds with the directives of the ISA', () => {
    const s = assembled('.data\nw: .word 0xfffffffe, 0xffffffff, 7, 0\n.text\nnop\n')
    const at = s.result!.program!.symbols['w']!
    expect(elementText(mips, s.machine!, 'dword', at)).toEqual({ hex: '0xfffffffffffffffe', value: '-2' })
    expect(elementText(mips, s.machine!, 'dword', at + 8).value).toBe('7')
    expect(kindTitle(mips, 'half')).toBe('.half')
    const gas = { ...mips, language: { ...mips.language, dataDirectives: { half: '.hword', dword: '.quad' } } }
    expect([kindTitle(gas, 'half'), kindTitle(gas, 'dword'), kindTitle(gas, 'word')]).toEqual(['.hword', '.quad', '.word'])
  })
})
