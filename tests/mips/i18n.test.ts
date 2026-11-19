/** Both languages are complete: every description has English, and English examples have the same code on every line. */
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/core/i18n'
import { mips } from '../../src/isa/mips'
import { BASIC } from '../../src/isa/mips/instructions'
import { EN_DESC } from '../../src/isa/mips/instructions/en'

const CJK = /[一-鿿（），：；]/
const code = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trimEnd())
    .join('\n')

describe('English text', () => {
  afterEach(() => setLocale('zh'))

  it('covers every basic instruction description', () => {
    for (const d of BASIC) {
      expect(EN_DESC[d.desc.zh], `${d.name}: ${d.desc.zh}`).toBeTruthy()
      expect(CJK.test(d.desc.en), `${d.name}: ${d.desc.en}`).toBe(false)
    }
  })

  it('covers every catalog entry, group, register and segment', () => {
    for (const e of mips.catalog) expect(CJK.test(e.description.en), `${e.key}: ${e.description.en}`).toBe(false)
    for (const g of mips.catalogGroups) expect(CJK.test(g.title.en)).toBe(false)
    for (const b of mips.registers) {
      expect(CJK.test(b.title.en)).toBe(false)
      for (const r of b.registers) expect(CJK.test(r.note?.en ?? ''), r.name).toBe(false)
    }
    for (const s of mips.layout.segments) expect(CJK.test(s.title.en)).toBe(false)
  })

  it('has an English version of every example with identical code', () => {
    for (const ex of mips.examples) {
      expect(ex.text.en, ex.id).not.toBe(ex.text.zh)
      expect(code(ex.text.en), ex.id).toBe(code(ex.text.zh))
      expect(CJK.test(ex.text.en), ex.id).toBe(false)
    }
  })

  it('reports assembler and runtime errors in the current language', () => {
    setLocale('en')
    const bad = mips.assemble({ name: 'x.asm', text: 'addi $t0, $t1\nfoo $t0\n' })
    for (const d of bad.diagnostics) expect(CJK.test(d.message), d.message).toBe(false)
    expect(bad.diagnostics.map((d) => d.code)).toEqual(['too-few', 'unknown-op'])
    const a = mips.analyzeLine('lw $t1, -100($t2)')
    for (const f of a.instructions[0]!.view.fields) expect(CJK.test(f.title + f.meaning), f.name).toBe(false)
    for (const o of a.operands) expect(CJK.test(o.hint)).toBe(false)
    setLocale('zh')
    expect(mips.assemble({ name: 'x.asm', text: 'foo $t0\n' }).diagnostics[0]!.message).toMatch(/不是可识别的指令/)
  })
})
