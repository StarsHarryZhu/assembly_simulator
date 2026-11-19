/** The calculator's one-line path: form choice, expansion, labels and demo inputs. */
import { describe, expect, it } from 'vitest'
import { mips } from '../../src/isa/mips'
import { A0, F0, SP, V0 } from '../../src/isa/mips/registers'

const hex = (v: number) => '0x' + (v >>> 0).toString(16).padStart(8, '0')

describe('analyzeLine', () => {
  it('encodes a basic instruction and lists the registers it reads', () => {
    const a = mips.analyzeLine('add $t0, $t1, $t2')
    expect(a.ok).toBe(true)
    expect(a.entry?.key).toBe('add')
    expect(a.instructions.map((i) => hex(i.word))).toEqual(['0x012a4020'])
    expect(a.inputs.map((i) => i.id)).toEqual([9, 10])
    expect(a.operands.map((o) => o.kind)).toEqual(['reg', 'reg', 'reg'])
  })

  it('picks the pseudo form the assembler would and shows its expansion', () => {
    const a = mips.analyzeLine('addi $t1, $t2, 100000')
    expect(a.ok).toBe(true)
    expect(a.entry?.pseudo).toBe(true)
    expect(a.instructions.map((i) => i.basic)).toEqual(['lui $at, 1', 'ori $at, $at, 0x86a0', 'add $t1, $t2, $at'])
    // $at is written before it is read, so it is not a demo input
    expect(a.inputs.map((i) => i.id)).toEqual([10])
  })

  it('places label operands where asked', () => {
    const a = mips.analyzeLine('beq $t1, $t2, there', { labels: { there: 0x00400010 } })
    expect(a.ok).toBe(true)
    expect(a.labels).toEqual([{ name: 'there', addr: 0x00400010 }])
    expect(hex(a.instructions[0]!.word)).toBe('0x112a0003')
    const la = mips.analyzeLine('la $a0, msg')
    expect(la.labels[0]!.addr).toBe(0x10010000)
  })

  it('reports operand errors in the assembler words', () => {
    const a = mips.analyzeLine('sll $t0, $t1, 40')
    expect(a.ok).toBe(false)
    expect(a.error).toMatch(/范围|不对/)
    expect(mips.analyzeLine('frob $t0').error).toMatch(/不是可识别的指令/)
  })

  it('gives memory operands a usable base and syscalls a service number', () => {
    const lw = mips.analyzeLine('lw $t1, -100($t2)')
    expect(lw.inputs).toEqual([{ id: 10, value: 0x10010080 }])
    const sc = mips.analyzeLine('syscall')
    expect(sc.inputs).toEqual([
      { id: V0, value: 1 },
      { id: A0, value: 42 },
    ])
    const push = mips.analyzeLine('sw $ra, 0($sp)')
    expect(push.inputs.find((i) => i.id === SP)?.value).toBe(0x7fffeffc)
  })

  it('pairs double-precision registers', () => {
    const a = mips.analyzeLine('add.d $f2, $f4, $f6')
    expect(a.inputs.map((i) => i.id - F0)).toEqual([4, 5, 6, 7])
  })

  it('rebuilds lines from operand texts', () => {
    expect(mips.buildLine('lw', ['$t1', '-100', '$t2'])).toBe('lw $t1, -100($t2)')
    expect(mips.buildLine('syscall', [])).toBe('syscall')
  })
})
