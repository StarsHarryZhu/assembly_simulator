# Console input and output services, sbrk, seeded random streams, exit code.
.data
prompt: .asciiz "name? "
buf: .space 16
small: .space 4
nl: .asciiz "\n"
.text
main:
  li $v0, 5
  syscall
  move $s0, $v0
  li $v0, 5
  syscall
  move $s1, $v0
  add $a0, $s0, $s1
  li $v0, 1
  syscall
  li $v0, 4
  la $a0, nl
  syscall
  li $v0, 6
  syscall
  mov.s $f12, $f0
  li $v0, 2
  syscall
  li $v0, 4
  la $a0, nl
  syscall
  li $v0, 7
  syscall
  mov.d $f12, $f0
  li $v0, 3
  syscall
  li $v0, 4
  la $a0, nl
  syscall
  li $v0, 4
  la $a0, prompt
  syscall
  li $v0, 8
  la $a0, buf
  li $a1, 16
  syscall
  li $v0, 4
  la $a0, buf
  syscall
  li $v0, 8
  la $a0, small
  li $a1, 4
  syscall
  li $v0, 4
  la $a0, small
  syscall
  li $v0, 4
  la $a0, nl
  syscall
  li $v0, 12
  syscall
  move $a0, $v0
  li $v0, 11
  syscall
  li $v0, 4
  la $a0, nl
  syscall
  li $a0, 10
  li $v0, 9
  syscall
  move $s2, $v0
  li $a0, 4
  li $v0, 9
  syscall
  move $s3, $v0
  li $a0, 1
  li $a1, 42
  li $v0, 40
  syscall
  li $a0, 1
  li $v0, 41
  syscall
  move $s4, $a0
  li $a0, 1
  li $a1, 100
  li $v0, 42
  syscall
  move $s5, $a0
  li $a0, 1
  li $a1, 64
  li $v0, 42
  syscall
  move $s6, $a0
  li $a0, 1
  li $v0, 43
  syscall
  mov.s $f12, $f0
  li $v0, 2
  syscall
  li $v0, 4
  la $a0, nl
  syscall
  li $a0, 1
  li $v0, 44
  syscall
  mov.d $f12, $f0
  li $v0, 3
  syscall
  li $v0, 4
  la $a0, nl
  syscall
  li $a0, -255
  li $v0, 34
  syscall
  li $a0, 7
  li $v0, 17
  syscall
