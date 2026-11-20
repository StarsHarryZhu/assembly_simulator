/**
 * Source helpers: section directives in the first column, example comments following the language, and the
 * whitespace-only edits and session update behind the Format command.
 */
import { describe, expect, it } from 'vitest'
import { codeOf, flushSections, sameCode, translateComments, whitespaceChanges, type TextChange } from '../../src/core/source'
import { Session } from '../../src/core/session'
import { mips } from '../../src/isa/mips'

const welcome = mips.examples.find((e) => e.id === 'welcome')!
const tr = (text: string, to: 'zh' | 'en') => translateComments(text, mips.examples, to, '#')

describe('flushSections', () => {
  it('moves every section directive to the first column and nothing else', () => {
    const text = '\t.data\nx: .word 1\n    .text   # code\n        .textual\n  .ktext 0x80000180\n\tadd $t0, $t1, $t2'
    expect(flushSections(text, mips.language.sections)).toBe('.data\nx: .word 1\n.text   # code\n        .textual\n.ktext 0x80000180\n\tadd $t0, $t1, $t2')
  })
})

describe('translateComments', () => {
  it('turns an example into the other language and back', () => {
    for (const ex of mips.examples) {
      expect(tr(ex.text.zh, 'en'), ex.id).toBe(ex.text.en)
      expect(tr(ex.text.en, 'zh'), ex.id).toBe(ex.text.zh)
      expect(tr(ex.text.en, 'en'), ex.id).toBe(ex.text.en)
    }
  })

  it('keeps lines the user wrote or edited', () => {
    const zh = welcome.text.zh.split('\n')
    const i = zh.findIndex((l) => l.includes('jal'))
    zh[i] = '        jal     sum             # 我改过的注释'
    zh.push('        addi    $t9, $t9, 1     # 新加的一行')
    const en = tr(zh.join('\n'), 'en').split('\n')
    expect(en[i]).toBe(zh[i])
    expect(en.at(-1)).toBe(zh.at(-1))
    expect(en[0]).toBe(welcome.text.en.split('\n')[0])
  })

  it('finds an example again once old indented section directives are moved to the first column', () => {
    const old = welcome.text.zh.replace(/^\.(data|text)/gm, '        .$1')
    expect(tr(flushSections(old, mips.language.sections), 'en')).toBe(welcome.text.en)
  })

  it('compares code without comments, also with # inside strings', () => {
    expect(codeOf('msg: .asciiz "a # b"   # note', '#')).toBe('msg: .asciiz "a # b"')
    expect(sameCode(welcome.text.zh, welcome.text.en, '#')).toBe(true)
    expect(sameCode(welcome.text.zh, welcome.text.zh.replace('jal', 'jalr'), '#')).toBe(false)
  })
})

describe('Session.replaceComments', () => {
  it('keeps the run going when only comments change', () => {
    const s = new Session(mips, { name: 'welcome.asm', text: welcome.text.zh })
    s.step()
    s.step()
    const pc = s.machine!.programCounter
    s.replaceComments(welcome.text.en)
    expect(s.file.text).toBe(welcome.text.en)
    expect(s.stale).toBe(false)
    expect(s.machine!.programCounter).toBe(pc)
    expect(s.result!.program!.instructions[0]!.source).toBe(welcome.text.en.split('\n')[s.result!.program!.instructions[0]!.line - 1])
  })

  it('treats a change of code as an ordinary edit', () => {
    const s = new Session(mips, { name: 'welcome.asm', text: welcome.text.zh })
    s.step()
    s.replaceComments(welcome.text.zh.replace('jal', 'jalr'))
    expect(s.stale).toBe(true)
  })
})

/** Apply edits given in positions of the original text. */
function apply(text: string, changes: TextChange[]): string {
  let out = ''
  let at = 0
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert
    at = c.to
  }
  return out + text.slice(at)
}

describe('whitespaceChanges', () => {
  it('edits only the runs of blanks that differ, and only the part that differs', () => {
    expect(whitespaceChanges('a  b\tc', 'a b c')).toEqual([
      { from: 2, to: 3, insert: '' },
      { from: 4, to: 5, insert: ' ' },
    ])
    expect(whitespaceChanges('same', 'same')).toEqual([])
    for (const [a, b] of [
      ['l: nop', 'l:\n    nop'],
      ['  x\n\n', 'x'],
      ['x', '\n\tx  '],
    ]) {
      expect(apply(a!, whitespaceChanges(a!, b!)!), JSON.stringify(a)).toBe(b)
    }
  })

  it('refuses texts that differ in anything but whitespace', () => {
    expect(whitespaceChanges('a b', 'a, b')).toBeNull()
    expect(whitespaceChanges('a', 'b')).toBeNull()
    expect(whitespaceChanges('a', 'a b')).toBeNull()
  })
})

describe('Session.reformat', () => {
  const format = mips.format!
  // The welcome example with its statements indented and padded differently (no line moves).
  const messy = welcome.text.zh.replace(/^ {4}(\w+) +/gm, '\t$1 ')

  it('keeps a paused run when every line stays in place', () => {
    expect(format(messy)).toBe(welcome.text.zh)
    const s = new Session(mips, { name: 'welcome.asm', text: messy })
    s.step()
    s.step()
    const at = [s.machine!.steps, s.machine!.programCounter]
    s.reformat(format(messy))
    expect(s.file.text).toBe(welcome.text.zh)
    expect(s.stale).toBe(false)
    expect([s.machine!.steps, s.machine!.programCounter]).toEqual(at)
    s.step()
    expect(s.machine!.steps).toBeGreaterThan(at[0]!)
  })

  it('reassembles a program that has not started, so messages use the new columns', () => {
    const s = new Session(mips, { name: 'w.asm', text: '.text\n\tli $t0,99999999999\n' })
    s.assemble()
    expect(s.messages[0]!.col).toBe(9)
    s.reformat(format(s.file.text))
    expect(s.stale).toBe(false)
    expect(s.messages[0]!.col).toBe(18)
  })

  it('treats moved lines, or text that is not the formatted source, as an ordinary edit', () => {
    const s = new Session(mips, { name: 'l.asm', text: '.text\nmain: li $t0, 1\n li $t1, 2' })
    s.step()
    s.reformat(format(s.file.text))
    expect(s.file.text).toBe('.text\nmain:\n    li      $t0, 1\n    li      $t1, 2')
    expect(s.stale).toBe(true)
    const t = new Session(mips, { name: 'w.asm', text: messy })
    t.step()
    t.reformat(messy.replace('\tjal', '    jal'))
    expect(t.stale).toBe(true)
  })
})
