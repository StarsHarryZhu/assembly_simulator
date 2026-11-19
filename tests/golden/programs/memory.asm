# Loads and stores of every width, unaligned access helpers, ll/sc, ld/sd, and data directives.
# golden: mem=0x10010000-0x1001007c
.data
bytes: .byte 0x81, 2, 0x7f, -1
halves: .half 0x8001, 0x7fff
words: .word 0x11223344, -2, 0x80000000
str: .asciiz "MIPS"
.align 2
buf: .space 32
dbl: .word 0, 0
.text
main:
  la $s0, bytes
  lb $t0, 0($s0)
  lbu $t1, 0($s0)
  lb $t2, 3($s0)
  lbu $t3, 3($s0)
  la $s1, halves
  lh $t4, 0($s1)
  lhu $t5, 0($s1)
  lh $t6, 2($s1)
  la $s2, words
  lw $t7, 0($s2)
  lw $t8, words+4
  lw $t9, 8($s2)
  la $s3, buf
  sw $t7, 0($s3)
  sh $t7, 4($s3)
  sb $t7, 7($s3)
  # unaligned: lwl / lwr at every offset
  li $s4, 0
  lwl $s4, 1($s2)
  move $a1, $s4
  li $s4, 0
  lwr $s4, 1($s2)
  move $a2, $s4
  li $s4, -1
  lwl $s4, 3($s2)
  move $a3, $s4
  li $s4, -1
  lwr $s4, 2($s2)
  move $v1, $s4
  li $k0, 0xa1b2c3d4
  swl $k0, 9($s3)
  swr $k0, 14($s3)
  swl $k0, 16($s3)
  swr $k0, 19($s3)
  ulw $k1, 1($s2)
  usw $k1, 21($s3)
  ulh $gp, 5($s2)
  ulhu $fp, 5($s2)
  ush $k0, 26($s3)
  ll $s5, 0($s2)
  addiu $s5, $s5, 1
  sc $s5, 28($s3)
  la $s6, dbl
  li $t0, 0x01020304
  li $t1, 0x05060708
  sd $t0, 0($s6)
  ld $t2, 0($s6)
  lw $s7, str
  lbu $ra, str+3
  li $v0, 10
  syscall
