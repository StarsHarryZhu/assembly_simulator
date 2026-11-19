/**
 * Rules found by comparing with MARS 4.5 that the golden programs cannot pin down on their own: errors
 * whose MARS wording maps to more than one of our codes, cases where we are deliberately stricter than
 * MARS, and the file-descriptor rules (golden runs have no files).
 */
import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/isa/mips/assembler'
import { createMachine } from '../../src/isa/mips/cpu'
import { ConsoleEnv } from '../helpers'
import { S0, S1, S2, V0 } from './regs'

/** Error codes as "line:code", or [] when the source assembles. */
function errors(text: string): string[] {
  return assemble({ name: 't.asm', text })
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.line}:${d.code}`)
}

function run(text: string, env = new ConsoleEnv()) {
  const r = assemble({ name: 't.asm', text })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  const m = createMachine(r.program!, env)
  m.run(100_000, new Set())
  return { m, env }
}

describe('.eqv', () => {
  it('may repeat a name only with the same text', () => {
    expect(errors('.eqv R $t0\n.eqv R   $t0\n.text\n    li R, 1')).toEqual([])
    expect(errors('.eqv N 10\n.eqv N 20')).toEqual(['2:bad-eqv'])
    // The comparison is on the text as written, so different spacing inside the value counts.
    expect(errors('.eqv N 4($t0)\n.eqv N 4( $t0 )')).toEqual(['2:bad-eqv'])
  })

  it('takes effect inside a macro body when the macro is defined', () => {
    const src = '.macro m\n.eqv K 3\n    li $t0, K\n.end_macro\n.text\n    m\n    m\n    li $t1, K'
    expect(errors(src)).toEqual([])
    expect(errors(src + '\n.eqv K 4')).toEqual(['9:bad-eqv'])
  })

  it('rejects macro parameters and stray tokens in the value', () => {
    expect(errors('.macro m(%v)\n.eqv K %v\n.end_macro')).toEqual(['2:bad-eqv'])
    expect(errors('.eqv X 4 @')).toEqual(['1:bad-eqv'])
  })
})

describe('macros', () => {
  it('use the latest definition with that name and parameter count', () => {
    const r = assemble({ name: 't.asm', text: '.macro m\n    addi $t0, $t0, 1\n.end_macro\n.text\n    m\n.macro m\n    addi $t0, $t0, 2\n.end_macro\n    m' })
    expect(r.program!.instructions.map((i) => i.word >>> 0)).toEqual([0x21080001, 0x21080002])
  })

  it('reject recursion, direct or through another macro', () => {
    expect(errors('.macro rec\n    rec\n.end_macro\n.text\n    rec')).toEqual(['5:macro-loop'])
  })
})

describe('assembler rules', () => {
  it('places instructions only at word-aligned addresses inside a 4 MB text segment', () => {
    expect(errors('.text 0x007ffffc\n    nop')).toEqual([])
    expect(errors('.text 0x007ffffc\n    nop\n    nop')).toEqual(['3:bad-text-addr'])
    expect(errors('.text 0x00400001\n    nop')).toEqual(['2:bad-text-addr'])
    expect(errors('.text 0x10010000\n    nop')).toEqual(['2:bad-text-addr'])
    // Either text directive accepts either text segment.
    expect(errors('.text 0x80000000\n    nop\n.ktext 0x00400000\n    nop')).toEqual([])
    expect(errors('.text\n    nop\n.text 0x00400000\n    nop')).toEqual(['4:duplicate-text-addr'])
  })

  it('writes data only where MARS has data memory', () => {
    expect(errors('.data 0x103ffffc\n.word 1\n.data 0x7fc00000\n.word 2\n.kdata 0x903ffffc\n.word 3\n.data 0xffff0000\n.word 4')).toEqual([])
    expect(errors('.data 0x103ffffc\n.word 1, 2')).toEqual(['2:bad-data-addr'])
    expect(errors('.data 0x7fbffffc\n.word 1')).toEqual(['2:bad-data-addr'])
    expect(errors('.data 0xffffffff\n.byte 1')).toEqual(['2:bad-data-addr'])
    // .space only moves the address; the next item is what lands outside.
    expect(errors('.data 0x10000000\n.space 0x400000\n.word 1')).toEqual(['3:bad-data-addr'])
  })

  it('keeps the other MARS limits', () => {
    expect(errors('.text\n    j kt\n.ktext\nkt: nop')).toEqual(['2:jump-range'])
    expect(errors('.text\n    mfc1.d $t0, $f31')).toEqual(['2:undefined-symbol'])
    expect(errors('.text\n    swr $t1, 40000')).toEqual(['2:mars-cannot'])
    expect(errors('.data\n.space 4, 8')).toEqual(['2:bad-space'])
    expect(errors('.globl nowhere\n.text\n    nop')).toEqual(['1:bad-globl'])
    expect(errors('.data\n.word 1, 0:4')).toEqual(['2:bad-data-value'])
    expect(errors('.data\n.word 0:4')).toEqual([])
  })

  it('is stricter than MARS where MARS would quietly garble the program', () => {
    // MARS drops the last character of an unterminated string.
    expect(errors('.data\ns: .asciiz "abc')).toEqual(['2:bad-string'])
  })
})

describe('memory and heap', () => {
  it('stores into kernel data and memory-mapped I/O without stalling', () => {
    const { m } = run('.text\n    li $t0, 0x90000000\n    li $t1, 7\n    sw $t1, 0($t0)\n    lw $s0, 0($t0)\n    li $t0, 0xfffffffc\n    sw $t1, 0($t0)\n    lw $s1, 0($t0)')
    expect(m.halted?.kind).toBe('dropped-off')
    expect([m.readRegister(S0), m.readRegister(S1)]).toEqual([7, 7])
  })

  it('refuses a heap request that wraps around, which MARS lets through', () => {
    const { m } = run('.text\n    li $a0, 0x7fffffff\n    li $v0, 9\n    syscall')
    expect(m.halted).toMatchObject({ kind: 'error', code: 'sbrk-full' })
  })
})

describe('files', () => {
  it('gives each open name one descriptor and keeps a failed read-open until it is closed', () => {
    const env = new ConsoleEnv()
    env.files.write('a.txt', new TextEncoder().encode('hi'))
    const open = (label: string, flags: number) => `    la $a0, ${label}\n    li $a1, ${flags}\n    li $v0, 13\n    syscall\n`
    const { m } = run(
      '.data\na: .asciiz "a.txt"\nmissing: .asciiz "none.txt"\n.text\n' +
        open('missing', 0) + // -1, but descriptor 3 stays taken by "none.txt"
        open('a', 0) +
        '    move $s0, $v0\n' +
        open('a', 0) + // already open: -1
        '    move $s1, $v0\n' +
        '    li $a0, 3\n    la $a1, a\n    li $a2, 4\n    li $v0, 14\n    syscall\n' + // reading the failed descriptor: -1
        '    move $s2, $v0\n',
      env,
    )
    expect([m.readRegister(S0), m.readRegister(S1), m.readRegister(S2)]).toEqual([4, -1, -1])
    expect(m.readRegister(V0)).toBe(-1)
  })
})
