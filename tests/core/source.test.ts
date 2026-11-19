/** Source helpers: section directives in the first column, example comments following the language. */
import { describe, expect, it } from 'vitest'
import { codeOf, flushSections, sameCode, translateComments } from '../../src/core/source'
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
