/** The AArch64 plugin as the UI sees it: both languages, the calculator, the decoder, the formatter and the references. */
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale, type Text } from '../../src/core/i18n'
import { arm64 } from '../../src/isa/arm64'
import { formatSource } from '../../src/isa/arm64/format'
import { SYSCALLS } from '../../src/isa/arm64/linux'
import { LIBC_FUNCTIONS } from '../../src/isa/arm64/libc'
import { EC } from '../../src/isa/arm64/cpu'
import { ConsoleEnv } from '../helpers'

const CJK = /[　-鿿＀-￯]/

afterEach(() => setLocale('zh'))

function texts(value: unknown, out: Text[] = []): Text[] {
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.zh === 'string' && typeof o.en === 'string') out.push(o as unknown as Text)
    else for (const v of Object.values(o)) texts(v, out)
  }
  return out
}

describe('both languages', () => {
  it('describes every catalog entry, register, segment and reference in English and Chinese', () => {
    const all = [...arm64.catalog.map((e) => e.description), ...texts(arm64.registers), ...texts(arm64.layout.segments), ...texts(arm64.references), ...arm64.catalogGroups.map((g) => g.title)]
    expect(all.length).toBeGreaterThan(500)
    for (const t of all) {
      expect(t.zh.length, t.en).toBeGreaterThan(0)
      expect(CJK.test(t.en), t.en).toBe(false)
    }
  })

  it('names a title for every catalog group in use', () => {
    const groups = new Set(arm64.catalogGroups.map((g) => g.id))
    for (const e of arm64.catalog) expect(groups.has(e.group), e.key).toBe(true)
  })

  it('reports assembler errors, runtime errors and decoder fields in the current language', () => {
    setLocale('en')
    const bad = arm64.assemble({ name: 'x.s', text: 'add x0, x1\nfoo x0\nb nowhere\n.bogus 1\n' })
    expect(bad.diagnostics.map((d) => `${d.line}:${d.code}`)).toEqual(['1:bad-operands', '2:unknown-mnemonic', '3:undefined-symbol', '4:unknown-directive'])
    for (const d of bad.diagnostics) expect(CJK.test(d.message), d.message).toBe(false)
    const r = arm64.assemble({ name: 'x.s', text: '_start:\n mov x0, #0\n ldr x1, [x0]\n' })
    const m = arm64.createMachine(r.program!, new ConsoleEnv())
    m.run(100, new Set())
    expect(m.halted?.kind).toBe('error')
    expect(CJK.test(m.halted && m.halted.kind === 'error' ? m.halted.message : '')).toBe(false)
    const a = arm64.analyzeLine('ldr x1, [x2, #16]')
    for (const f of a.instructions[0]!.view.fields) expect(CJK.test(f.title + f.meaning), f.name).toBe(false)
    for (const o of a.operands) expect(CJK.test(o.hint)).toBe(false)
  })
})

describe('calculator', () => {
  it('encodes a line, names its operands and runs it', () => {
    const a = arm64.analyzeLine('add x0, x1, x2, lsl #3')
    expect(a.ok).toBe(true)
    expect(a.instructions.map((i) => i.word)).toEqual([0x8b020c20])
    // The shift type and amount are separate operands, so the tab offers a choice for the type.
    expect(a.operands.map((o) => o.text)).toEqual(['x0', 'x1', 'x2', 'lsl', '3'])
    expect(a.operands[3]!.options).toContain('asr')
    expect(a.inputs.map((i) => i.id)).toEqual([1, 2])
    expect(a.entry?.mnemonic).toBe('add')
  })

  it('reads register names as registers, never as labels', () => {
    const a = arm64.analyzeLine('add x0, x1, x2')
    expect(a.instructions.map((i) => i.word)).toEqual([0x8b020020])
    expect(a.labels).toEqual([])
  })

  it('places label operands where asked and points base registers at writable memory', () => {
    const b = arm64.analyzeLine('b.ne target', { at: 0x400000, labels: { target: 0x400100 } })
    expect(b.labels).toEqual([{ name: 'target', addr: 0x400100 }])
    expect(b.instructions[0]!.basic).toBe('b.ne 0x400100 <target>')
    const st = arm64.analyzeLine('str x3, [sp, #-16]!')
    expect(st.ok).toBe(true)
    const m = arm64.createMachine(st.program!, new ConsoleEnv())
    for (const i of st.inputs) m.setRegister(i.id, i.value)
    const info = m.step()
    // The store worked; the one-line program then ends.
    expect(info.memory.length).toBe(1)
    expect(m.halted).toEqual({ kind: 'dropped-off' })
  })

  it('builds a line back from operand texts', () => {
    const a = arm64.analyzeLine('ldr w0, [x1, #4]')
    expect(arm64.buildLine(a.entry!.key, a.operands.map((o) => o.text))).toBe('ldr w0, [x1, #4]')
  })

  it('reports what is wrong with a line', () => {
    expect(arm64.analyzeLine('add x0, x1').error).toBeTruthy()
    expect(arm64.analyzeLine('frob x0').error).toMatch(/frob/)
    expect(arm64.analyzeLine('').error).toBeTruthy()
  })
})

describe('decoder', () => {
  it('shows fields, the alias and branch targets', () => {
    const mov = arm64.decode(0xaa0203e1, 0x400000)
    expect(mov.text).toBe('mov x1, x2')
    expect(mov.notes.join(' ')).toMatch(/orr x1, xzr, x2/)
    expect(mov.fields.map((f) => f.hi - f.lo + 1).reduce((a, b) => a + b)).toBe(32)
    const bl = arm64.decode(0x94000003, 0x400008)
    expect(bl.text).toBe('bl 0x400014')
    expect(bl.notes.join(' ')).toMatch(/0x400014/)
    const bad = arm64.decode(0x00200000, 0x400000)
    expect(bad.ok).toBe(false)
  })

  it('decodes every sample word of the disassembler tab', () => {
    for (const ex of arm64.samples.decoderExamples) expect(arm64.decode(Number(ex.word), 0x400000).mnemonic, ex.word).toBe(ex.note)
  })
})

describe('formatter', () => {
  const MESSY = ['  .text', 'main:   mov x0,#1   // one', 'loop: subs x0 , x0, # 1', '  b.ne loop', '   .data', 'v: .quad 1,2', 'longer_name: .asciz "a  b"', '  // note', '    ret'].join('\n')

  it('lays out code and data like the examples, changing only whitespace', () => {
    const out = formatSource(MESSY)
    expect(out.split('\n')).toEqual([
      '.text',
      'main:',
      '    mov     x0, #1                      // one',
      'loop:',
      '    subs    x0, x0, # 1',
      '    b.ne    loop',
      '.data',
      'v:              .quad   1, 2',
      'longer_name:    .asciz  "a  b"',
      '                // note',
      '                ret',
    ])
    expect(formatSource(out)).toBe(out)
    expect(out.replace(/\s/g, '')).toBe(MESSY.replace(/\s/g, ''))
  })

  it('leaves block comments and joined statements as written', () => {
    const text = '/* a\n   b */\n    nop ; nop\n'
    expect(formatSource(text)).toBe(text)
  })
})

describe('references', () => {
  const table = (id: string) => arm64.references!.find((t) => t.id === id)!

  it('lists every system call the kernel answers, and every C library function', () => {
    expect(table('svc').groups.flatMap((g) => g.rows.map((r) => Number(r.key))).sort((a, b) => a - b)).toEqual(SYSCALLS.map((s) => s.nr).sort((a, b) => a - b))
    expect(table('libc').groups[0]!.rows.map((r) => r.key)).toEqual(LIBC_FUNCTIONS)
  })

  it('names the exception classes the machine raises', () => {
    const keys = table('exceptions').groups[0]!.rows.map((r) => Number(r.key))
    expect(keys.sort((a, b) => a - b)).toEqual(Object.values(EC).sort((a, b) => a - b))
  })

  it('explains every directive the assembler documents with an example that assembles', () => {
    for (const row of table('directives').groups.flatMap((g) => g.rows)) {
      if (!row.example) continue
      const text = row.example.includes('msg') && !row.example.includes('msg:') ? `${row.example}\nmsg: .asciz "x"` : row.example
      const r = arm64.assemble({ name: 'r.s', text: `${text}\n.text\ntable: dump: ret` }, { files: [{ name: 'macros.s', text: '' }] })
      const errors = r.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'user-error')
      expect(errors, row.key).toEqual([])
    }
  })
})
