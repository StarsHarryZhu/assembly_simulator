# A kernel exception handler that skips the faulting instruction and counts exceptions.
.data
count: .word 0
.text
main:
  li $t0, 0x7fffffff
  addi $t1, $t0, 1
  lw $t2, 1($zero)
  teqi $zero, 0
  break 3
  lw $s0, count
  li $v0, 10
  syscall
.ktext 0x80000180
  mfc0 $k0, $14
  mfc0 $k1, $13
  mfc0 $s1, $8
  addi $k0, $k0, 4
  mtc0 $k0, $14
  lw $k1, count
  addi $k1, $k1, 1
  sw $k1, count
  eret
