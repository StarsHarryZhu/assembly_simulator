# Data directives, auto-alignment, .align 0, repetition, strings with escapes, .eqv and macros.
# golden: mem=0x10010000-0x1001004c
.eqv COUNT 5
.eqv REG $t3
.macro push(%r)
  addi $sp,$sp,-4
  sw %r,0($sp)
.end_macro
.macro done
  li $v0,10
  syscall
.end_macro
.macro twice(%a, %b)
  add %a, %a, %b
loop: add %a, %a, %b
  beq %a, $zero, loop
.end_macro
.data
b1: .byte 1
h1: .half 2
w1: .word 3
b2: .byte 4, 5, 'A', '\n'
arr: .word 0:3
s1: .asciiz "hi\t\"x\"\n", "yo"
s2: .ascii "ab"
sp1: .space 3
d1: .double 1.5
f1: .float 2.25, -0.0
w2: .word w1, b2
.align 0
h2: .half 7
w3: .word 9
.text
main:
  li $t0, 010
  li $t1, COUNT
  move REG, $t1
  push($t0)
  push $t1
  la $t2, w2
  lw $t3, 4($t2)
  li $t4, 'z'
  li $t5, '\n'
  twice($t4, $t5)
  twice($t4, $t5)
  done
