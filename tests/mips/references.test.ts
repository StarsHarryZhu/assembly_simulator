/** The reference tables (syscall services, CP0, exceptions, FP flags, directives) match what the engine does. */
import { describe, expect, it } from 'vitest'
import type { Text } from '../../src/core/i18n'
import { mips } from '../../src/isa/mips'
import { assemble } from '../../src/isa/mips/assembler'
import { createMachine } from '../../src/isa/mips/cpu'
import { CP0_REGISTERS, DIRECTIVE_REFERENCE, EXCEPTIONS, REFERENCES, SYSCALL_SERVICES } from '../../src/isa/mips/references'
import { C0_CAUSE } from '../../src/isa/mips/registers'
import { ConsoleEnv } from '../helpers'

const CJK = /[一-鿿（），：；]/

function run(src: string, steps = 50) {
  const r = assemble({ name: 't.asm', text: src })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  const m = createMachine(r.program!, new ConsoleEnv('1\n'))
  for (let i = 0; i < steps && !m.halted && !m.pending; i++) m.step()
  return m
}

const keys = (table: typeof SYSCALL_SERVICES) => table.groups.flatMap((g) => g.rows.map((r) => r.key))

describe('reference tables', () => {
  it('list exactly the syscall services the engine handles', () => {
    const handled: number[] = []
    for (let code = 0; code <= 64; code++) {
      const m = run(`li $v0, ${code}\nsyscall`)
      const h = m.halted
      if (!(h?.kind === 'error' && h.code === 'syscall-invalid')) handled.push(code)
    }
    expect(keys(SYSCALL_SERVICES).map(Number).sort((a, b) => a - b)).toEqual(handled)
    expect(handled).toHaveLength(39)
  })

  it('list exactly the exception codes a handler receives', () => {
    const handler = '\n.ktext 0x80000180\n    mfc0 $k0, $13\n    li $v0, 10\n    syscall\n'
    const programs = [
      'lw $t0, 0($zero)',
      'sw $t0, 0($zero)',
      'li $t0, 0x10010001\nlw $t1, 0($t0)',
      'break',
      'li $t0, 0x7fffffff\naddi $t0, $t0, 1',
      'teq $zero, $zero',
    ]
    const codes = new Set<number>()
    for (const p of programs) {
      const m = run(`.text\n${p}\n${handler}`)
      expect(m.halted, p).toEqual({ kind: 'exit', code: null })
      codes.add(((m.readRegister(C0_CAUSE) as number) >> 2) & 31)
    }
    expect(keys(EXCEPTIONS).map(Number)).toEqual([...codes].sort((a, b) => a - b))
  })

  it('describe every coprocessor 0 register the machine has', () => {
    const cp0 = mips.registers.find((b) => b.id === 'cp0')!.registers.map((r) => `$${r.number}`)
    expect(keys(CP0_REGISTERS)).toEqual(cp0)
  })

  it('name only real instructions and registers', () => {
    for (const table of REFERENCES) {
      for (const m of table.mnemonics) expect([...mips.language.mnemonics, ...mips.language.directives], `${table.id}: ${m}`).toContain(m)
      for (const g of table.groups)
        for (const row of g.rows)
          for (const r of [...(row.args ?? []), ...(row.results ?? [])]) expect(mips.language.registers, `${table.id} ${row.key}: ${r.reg}`).toContain(r.reg)
    }
  })

  it('explain every directive the assembler knows, with examples that assemble', () => {
    expect([...keys(DIRECTIVE_REFERENCE)].sort()).toEqual([...mips.language.directives].sort())
    const data = new Set(['.word', '.half', '.byte', '.float', '.double', '.ascii', '.asciiz', '.space', '.align'])
    for (const g of DIRECTIVE_REFERENCE.groups) {
      for (const row of g.rows) {
        const text = (data.has(row.key) ? '.data\n' : '') + row.example!
        const r = assemble({ name: 't.asm', text }, { files: [{ name: 'macros.asm', text: 'nop\n' }] })
        expect(r.diagnostics.filter((d) => d.severity === 'error'), `${row.key}: ${row.example}`).toEqual([])
        expect(row.example, row.key).toContain(row.key)
      }
    }
  })

  it('are complete in both languages', () => {
    const texts: Text[] = []
    for (const table of REFERENCES) {
      texts.push(table.title, table.intro, table.keyTitle)
      for (const g of table.groups) {
        if (g.title) texts.push(g.title)
        for (const row of g.rows) {
          texts.push(row.title, ...(row.text ? [row.text] : []), ...(row.note ? [row.note] : []))
          for (const r of [...(row.args ?? []), ...(row.results ?? [])]) texts.push(r.text)
        }
      }
    }
    for (const t of texts) {
      expect(t.zh.trim(), t.en).not.toBe('')
      expect(t.en.trim(), t.zh).not.toBe('')
      expect(CJK.test(t.en), t.en).toBe(false)
    }
  })
})
