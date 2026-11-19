# Floating point: area of a circle in single and double precision
.data
pi:     .float  3.14159265
r:      .float  2.5
pid:    .double 3.141592653589793
rd:     .double 2.5
s1:     .asciiz "float  area = "
s2:     .asciiz "\ndouble area = "

.text
main:
    l.s     $f0, pi
    l.s     $f1, r
    mul.s   $f2, $f1, $f1
    mul.s   $f12, $f2, $f0      # syscall 2 prints $f12
    li      $v0, 4
    la      $a0, s1
    syscall
    li      $v0, 2
    syscall

    l.d     $f4, pid            # a double takes a register pair: $f4 and $f5
    l.d     $f6, rd
    mul.d   $f8, $f6, $f6
    mul.d   $f12, $f8, $f4      # syscall 3 prints $f12/$f13
    li      $v0, 4
    la      $a0, s2
    syscall
    li      $v0, 3
    syscall
    li      $v0, 11
    li      $a0, '\n'
    syscall
    li      $v0, 10
    syscall
