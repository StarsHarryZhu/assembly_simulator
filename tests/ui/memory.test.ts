/** The memory panel's entries stay cheap and correct for kernel addresses and large buffers. */
import { describe, expect, it } from 'vitest'
import { Session } from '../../src/core/session'
import { mips } from '../../src/isa/mips'
import { memoryEntries } from '../../src/ui/ide/memoryEntries'

const exceptions = mips.examples.find((e) => e.id === 'exceptions')!.text.en

function entries(s: Session) {
  return memoryEntries(s.machine!, s.result!.program!, mips, s.file.name, s.last?.memory ?? [])
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
})
