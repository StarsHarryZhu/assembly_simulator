# Integer arithmetic, logic, shifts, HI/LO, SPECIAL2 and conditional moves; prints every result.
.data
nl: .asciiz "\n"
sp: .asciiz " "
.text
.macro show(%r)
  move $a0, %r
  li $v0, 1
  syscall
  li $v0, 4
  la $a0, sp
  syscall
.end_macro
.macro hex(%r)
  move $a0, %r
  li $v0, 34
  syscall
  li $v0, 4
  la $a0, sp
  syscall
.end_macro
main:
  li $t0, 0x7ffffff0
  li $t1, -7
  addu $t2, $t0, $t1
  show($t2)
  subu $t2, $t1, $t0
  show($t2)
  addiu $t2, $t1, -32768
  show($t2)
  and $t3, $t0, $t1
  hex($t3)
  or $t3, $t0, $t1
  hex($t3)
  xor $t3, $t0, $t1
  hex($t3)
  nor $t3, $t0, $t1
  hex($t3)
  andi $t3, $t1, 0xff0f
  hex($t3)
  ori $t3, $zero, 0xbeef
  hex($t3)
  xori $t3, $t1, 0x8000
  hex($t3)
  lui $t3, 0xabcd
  hex($t3)
  sll $t4, $t1, 4
  hex($t4)
  srl $t4, $t1, 4
  hex($t4)
  sra $t4, $t1, 4
  hex($t4)
  li $t5, 35
  sllv $t4, $t1, $t5
  hex($t4)
  srlv $t4, $t1, $t5
  hex($t4)
  srav $t4, $t1, $t5
  hex($t4)
  slt $t6, $t1, $t0
  show($t6)
  sltu $t6, $t1, $t0
  show($t6)
  slti $t6, $t1, -6
  show($t6)
  sltiu $t6, $t0, -1
  show($t6)
  mult $t0, $t1
  mfhi $s0
  mflo $s1
  hex($s0)
  hex($s1)
  multu $t0, $t1
  mfhi $s0
  mflo $s1
  hex($s0)
  hex($s1)
  li $t7, 1000
  li $t8, -7
  div $t7, $t8
  mfhi $s0
  mflo $s1
  show($s0)
  show($s1)
  divu $t7, $t8
  mfhi $s0
  mflo $s1
  show($s0)
  show($s1)
  li $t9, 0x80000000
  li $s2, -1
  div $t9, $s2
  mfhi $s0
  mflo $s1
  hex($s0)
  hex($s1)
  div $t7, $zero
  mfhi $s0
  mflo $s1
  hex($s0)
  hex($s1)
  mul $s3, $t0, $t1
  hex($s3)
  mfhi $s0
  hex($s0)
  mthi $t7
  mtlo $t8
  madd $t0, $t1
  mfhi $s0
  mflo $s1
  hex($s0)
  hex($s1)
  maddu $t0, $t1
  mfhi $s0
  mflo $s1
  hex($s0)
  hex($s1)
  msub $t1, $t1
  mfhi $s0
  mflo $s1
  hex($s0)
  hex($s1)
  msubu $t0, $t0
  mfhi $s0
  mflo $s1
  hex($s0)
  hex($s1)
  clz $s4, $t0
  show($s4)
  clz $s4, $zero
  show($s4)
  clo $s4, $t1
  show($s4)
  clo $s4, $zero
  show($s4)
  li $s5, 11
  movn $s5, $t0, $zero
  show($s5)
  movn $s5, $t1, $t0
  show($s5)
  movz $s5, $t7, $zero
  show($s5)
  movz $s5, $t0, $t7
  show($s5)
  li $a0, -1
  li $v0, 36
  syscall
  li $v0, 4
  la $a0, sp
  syscall
  li $a0, 0x5a5a
  li $v0, 35
  syscall
  li $v0, 4
  la $a0, nl
  syscall
  # pseudo-instructions over the same values
  abs $s6, $t1
  show($s6)
  neg $s6, $t1
  show($s6)
  negu $s6, $t0
  show($s6)
  not $s6, $t1
  hex($s6)
  rol $s6, $t0, 8
  hex($s6)
  ror $s6, $t0, 8
  hex($s6)
  rol $s6, $t0, $t5
  hex($s6)
  ror $s6, $t0, $t5
  hex($s6)
  seq $s7, $t1, -7
  sne $k0, $t1, 100000
  sge $k1, $t1, $t0
  sgeu $gp, $t1, $t0
  show($s7)
  show($k0)
  show($k1)
  show($gp)
  sgt $s7, $t1, -8
  sgtu $k0, $t1, 5
  sle $k1, $t0, 0x7ffffff0
  sleu $s0, $t0, -1
  show($s7)
  show($k0)
  show($k1)
  show($s0)
  mulu $s1, $t0, 3
  hex($s1)
  div $s1, $t7, 7
  rem $s2, $t7, -7
  divu $s3, $t7, 7
  remu $s4, $t8, 100000
  show($s1)
  show($s2)
  show($s3)
  show($s4)
  li $v0, 10
  syscall
