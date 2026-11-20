/**
 * The Format command: the house style of the example programs, applied by changing whitespace only, so every
 * program assembles exactly as before.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/isa/mips/assembler'
import { displayWidth, formatSource } from '../../src/isa/mips/format'
import { mips } from '../../src/isa/mips'

/** ⇥ marks a tab. */
const src = (s: string) => s.replaceAll('⇥', '\t')

const MESSY = src(String.raw`# 求数组之和
.eqv   N   5
.macro print_int(%r)
move $a0,%r
  li $v0,1
syscall
.end_macro

   .data
nums:.word 3,1,4,1,5
newline:  .asciiz "\n"
msg: .asciiz "和 = "   # 输出前缀
⇥.align 2
buf: .space 16

.text
main:⇥la $a0,nums   # 数组地址
  li $a1 , N
⇥  jal sum
move $s0,$v0
        # 打印结果
  li $v0,4
  la $a0, msg
  syscall
  print_int( $s0 )
  li $v0,10
  syscall

sum: move $v0,$zero
loop: beqz $a1,done      # 数完了？
  lw $t0,0( $a0 )
  add $v0,$v0,$t0
  addi $a0,$a0,4
  addi $a1,$a1,-1
  j loop
done:jr $ra`)

const TIDY = String.raw`# 求数组之和
.eqv    N 5
.macro  print_int(%r)
    move    $a0, %r
    li      $v0, 1
    syscall
.end_macro

.data
nums:       .word   3, 1, 4, 1, 5
newline:    .asciiz "\n"
msg:        .asciiz "和 = "     # 输出前缀
            .align  2
buf:        .space  16

.text
main:
    la      $a0, nums           # 数组地址
    li      $a1, N
    jal     sum
    move    $s0, $v0
    # 打印结果
    li      $v0, 4
    la      $a0, msg
    syscall
    print_int($s0)
    li      $v0, 10
    syscall

sum:
    move    $v0, $zero
loop:
    beqz    $a1, done           # 数完了？
    lw      $t0, 0($a0)
    add     $v0, $v0, $t0
    addi    $a0, $a0, 4
    addi    $a1, $a1, -1
    j       loop
done:
    jr      $ra`

const blanksRemoved = (s: string) => s.replace(/\s+/g, '')

/** What the assembler makes of a source: code, data and error codes, plus error lines when asked. */
function assembled(text: string, withLines: boolean) {
  const r = assemble({ name: 't.asm', text })
  return {
    code: r.program?.instructions.map((i) => [i.addr, i.word]) ?? null,
    data: r.program?.image.map((b) => [b.addr, [...b.bytes]]) ?? null,
    symbols: r.program?.symbols ?? null,
    errors: r.diagnostics.map((d) => (withLines ? `${d.line}:${d.code}` : d.code)),
  }
}

const GOLDEN = join(import.meta.dirname, '..', 'golden', 'programs')
const corpus: [string, string][] = [
  ...mips.examples.flatMap((e): [string, string][] => [
    [`example ${e.id} (zh)`, e.text.zh],
    [`example ${e.id} (en)`, e.text.en],
  ]),
  ...readdirSync(GOLDEN)
    .filter((f) => f.endsWith('.asm'))
    .map((f): [string, string] => [f, readFileSync(join(GOLDEN, f), 'utf8')]),
  ['messy', MESSY],
]

describe('formatSource', () => {
  it('lays out a messy program like the examples', () => {
    expect(formatSource(MESSY)).toBe(TIDY)
  })

  it('leaves every example program as it is', () => {
    for (const e of mips.examples) {
      expect(formatSource(e.text.zh), e.id).toBe(e.text.zh)
      expect(formatSource(e.text.en), e.id).toBe(e.text.en)
    }
  })

  it('changes only whitespace, is stable, and never changes what a program assembles to', () => {
    for (const [name, text] of corpus) {
      const once = formatSource(text)
      expect(blanksRemoved(once), name).toBe(blanksRemoved(text))
      expect(formatSource(once), name).toBe(once)
      const sameLines = once.split('\n').length === text.split('\n').length
      expect(assembled(once, sameLines), name).toEqual(assembled(text, sameLines))
    }
  })

  it('moves a code label off its instruction, but not off a directive', () => {
    expect(formatSource('.text\nloop: addi $t0, $t0, 1 # again')).toBe('.text\nloop:\n' + '    addi    $t0, $t0, 1'.padEnd(32) + '# again')
    // MARS reads the "b:" of "a: b: nop" as the branch b, so the line stays as written.
    expect(formatSource('.text\n  a: b:  nop  ')).toBe('.text\n  a: b:  nop')
    expect(formatSource('.text\nnop\njt: .word 1\n.align 2')).toBe('.text\n    nop\njt:     .word   1\n    .align  2')
    expect(formatSource('.data\nx:\n.word 1')).toBe('.data\nx:\n        .word   1')
  })

  it('normalises the space around commas and parentheses, and nothing else in the operands', () => {
    expect(formatSource('  lw $t0 , 4( $sp )')).toBe('    lw      $t0, 4($sp)')
    expect(formatSource('add $t0 $t1 $t2')).toBe('    add     $t0 $t1 $t2')
    expect(formatSource('lw $t0 ($t1)')).toBe('    lw      $t0 ($t1)')
    expect(formatSource('la $a0, label  +  4')).toBe('    la      $a0, label + 4')
    expect(formatSource('ADDI $T0,$T0,1')).toBe('    ADDI    $T0, $T0, 1')
    expect(formatSource('print_string_now ( $a0 )')).toBe('    print_string_now ($a0)')
    expect(formatSource('print_string_now   $a0')).toBe('    print_string_now $a0')
  })

  it('keeps quoted text, .eqv values and lines with an open quote exactly as written', () => {
    expect(formatSource('.data\ns: .asciiz  "a ,  # (b)\tc"  #  note  ')).toBe('.data\ns:      .asciiz "a ,  # (b)\tc"  #  note')
    expect(formatSource("li $a0,'#'")).toBe("    li      $a0, '#'")
    expect(formatSource('.eqv  ADDR   4( $t0 )')).toBe('.eqv    ADDR 4( $t0 )')
    expect(formatSource('.data\ns:  .asciiz "open, ')).toBe('.data\ns:  .asciiz "open,')
  })

  it('widens the label column of a data block to fit its longest label', () => {
    // "a_long_name:" takes 12 columns, so the block's label column becomes 16; the next block keeps 8.
    expect(formatSource('.data\na: .word 1\na_long_name: .byte 2\n\nb: .word 3')).toBe(
      '.data\n' + 'a:'.padEnd(16) + '.word   1\n' + 'a_long_name:'.padEnd(16) + '.byte   2\n\nb:      .word   3',
    )
  })

  it('aligns trailing comments, counting wide characters as two columns', () => {
    expect(displayWidth('和 = ')).toBe(5)
    // "你好" is 6 characters on screen with its quotes, so 22 columns of code and 10 spaces to column 32.
    expect(formatSource('.data\nm: .asciiz "你好" # x')).toBe('.data\nm:      .asciiz "你好"' + ' '.repeat(10) + '# x')
    const long = '    la      $a0, a_rather_long_label_name'
    // 41 columns of code: the comment goes to column 44.
    expect(formatSource(long + ' # c')).toBe(long + '   # c')
  })

  it('puts comment lines at the first column or at the indentation of the code after them', () => {
    expect(formatSource('.text\n# top\n  # inside\nnop\n   # before label\nl:\n   # last')).toBe('.text\n# top\n    # inside\n    nop\n# before label\nl:\n# last')
    expect(formatSource('.text\nnop\n\t# trailing')).toBe('.text\n    nop\n    # trailing')
  })

  it('removes trailing blanks and keeps blank lines', () => {
    expect(formatSource('.text  \n\n   \nnop\t')).toBe('.text\n\n\n    nop')
  })
})
