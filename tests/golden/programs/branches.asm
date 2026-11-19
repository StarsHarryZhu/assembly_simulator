# Branches, jumps and links; pseudo branches against registers and immediates; a recursive call.
.data
nl: .asciiz "\n"
.text
.macro out(%c)
  li $a0, %c
  li $v0, 11
  syscall
.end_macro
main:
  li $t0, -5
  li $t1, 7
  beq $t0, $t0, b1
  out('X')
b1: bne $t0, $t1, b2
  out('X')
b2: bgez $t1, b3
  out('X')
b3: bltz $t0, b4
  out('X')
b4: blez $zero, b5
  out('X')
b5: bgtz $t0, bad
  out('a')
  bgezal $t0, bad
  out('b')
  bltzal $t1, bad
  out('c')
  li $ra, 0
  bltzal $t0, sub1
  out('d')
  bgezal $t1, sub1
  out('e')
  blt $t0, $t1, c1
  out('X')
c1: bgt $t1, $t0, c2
  out('X')
c2: ble $t0, -5, c3
  out('X')
c3: bge $t1, 7, c4
  out('X')
c4: bltu $t1, $t0, c5
  out('X')
c5: bgtu $t0, 100000, c6
  out('X')
c6: bleu $t1, 7, c7
  out('X')
c7: bgeu $t0, -6, c8
  out('X')
c8: beq $t1, 7, c9
  out('X')
c9: bne $t0, 100000, c10
  out('X')
c10: beqz $zero, c11
  out('X')
c11: bnez $t0, c12
  out('X')
c12: b c13
  out('X')
c13: bgt $t1, 100000, bad
  ble $t1, 6, bad
  ble $t1, 100000, c14
  out('X')
c14: blt $t1, -100, bad
  out('f')
  jal sub2
  out('g')
  la $t2, sub2
  jalr $t2
  out('h')
  la $t3, sub3
  jalr $s7, $t3
  move $a0, $s7
  li $v0, 34
  syscall
  li $a0, 6
  jal fact
  move $a0, $v0
  li $v0, 1
  syscall
  la $t3, done
  jr $t3
bad: out('!')
done:
  li $v0, 4
  la $a0, nl
  syscall
  li $v0, 10
  syscall
sub1:
  out('s')
  jr $ra
sub2:
  out('t')
  jr $ra
sub3:
  out('u')
  jr $s7
fact:
  bgt $a0, 1, recurse
  li $v0, 1
  jr $ra
recurse:
  addi $sp, $sp, -8
  sw $ra, 4($sp)
  sw $a0, 0($sp)
  addi $a0, $a0, -1
  jal fact
  lw $a0, 0($sp)
  lw $ra, 4($sp)
  addi $sp, $sp, 8
  mul $v0, $v0, $a0
  jr $ra
