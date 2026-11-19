# Floating point: arithmetic, conversions and rounding (ties, negatives, NaN, out of range), compares, moves.
.data
nl: .asciiz "\n"
sp: .asciiz " "
vals: .float 2.5, -2.5, 3.5, -0.5, 1.75, -1.75, 3e9, -3e9
dvals: .double 2.5, -3.5, 0.1, 1e300
one: .float 1.0
.text
.macro pf(%f)
  mov.s $f12, %f
  li $v0, 2
  syscall
  li $v0, 4
  la $a0, sp
  syscall
.end_macro
.macro pd(%f)
  mov.d $f12, %f
  li $v0, 3
  syscall
  li $v0, 4
  la $a0, sp
  syscall
.end_macro
.macro pi(%f)
  mfc1 $a0, %f
  li $v0, 1
  syscall
  li $v0, 4
  la $a0, sp
  syscall
.end_macro
main:
  la $s0, vals
  li $s1, 0
loop:
  lwc1 $f0, 0($s0)
  floor.w.s $f2, $f0
  pi($f2)
  ceil.w.s $f2, $f0
  pi($f2)
  round.w.s $f2, $f0
  pi($f2)
  trunc.w.s $f2, $f0
  pi($f2)
  cvt.w.s $f2, $f0
  pi($f2)
  addi $s0, $s0, 4
  addi $s1, $s1, 1
  blt $s1, 8, loop
  li $v0, 4
  la $a0, nl
  syscall
  l.s $f4, vals
  l.s $f6, vals+8
  add.s $f8, $f4, $f6
  pf($f8)
  sub.s $f8, $f4, $f6
  pf($f8)
  mul.s $f8, $f4, $f6
  pf($f8)
  div.s $f8, $f4, $f6
  pf($f8)
  sqrt.s $f8, $f6
  pf($f8)
  abs.s $f8, $f4
  pf($f8)
  neg.s $f8, $f4
  pf($f8)
  l.s $f10, vals+4
  sqrt.s $f8, $f10
  pf($f8)
  mtc1 $zero, $f14
  div.s $f8, $f4, $f14
  pf($f8)
  div.s $f8, $f14, $f14
  pf($f8)
  floor.w.s $f9, $f8
  pi($f9)
  li $v0, 4
  la $a0, nl
  syscall
  l.d $f20, dvals
  l.d $f22, dvals+8
  add.d $f24, $f20, $f22
  pd($f24)
  sub.d $f24, $f20, $f22
  pd($f24)
  mul.d $f24, $f20, $f22
  pd($f24)
  div.d $f24, $f20, $f22
  pd($f24)
  l.d $f26, dvals+16
  pd($f26)
  sqrt.d $f24, $f26
  pd($f24)
  l.d $f28, dvals+24
  pd($f28)
  cvt.s.d $f30, $f28
  pf($f30)
  cvt.s.d $f30, $f26
  pf($f30)
  cvt.d.s $f24, $f6
  pd($f24)
  li $t0, -123456789
  mtc1 $t0, $f16
  cvt.s.w $f17, $f16
  pf($f17)
  cvt.d.w $f24, $f16
  pd($f24)
  round.w.d $f17, $f20
  pi($f17)
  round.w.d $f17, $f22
  pi($f17)
  floor.w.d $f17, $f22
  pi($f17)
  ceil.w.d $f17, $f22
  pi($f17)
  trunc.w.d $f17, $f28
  pi($f17)
  cvt.w.d $f17, $f28
  pi($f17)
  abs.d $f24, $f22
  pd($f24)
  neg.d $f24, $f22
  pd($f24)
  li $v0, 4
  la $a0, nl
  syscall
  c.lt.s $f4, $f6
  bc1t t1
  li $a0, 'X'
  li $v0, 11
  syscall
t1:
  c.eq.s 3, $f4, $f6
  bc1f 3, t2
  li $a0, 'X'
  li $v0, 11
  syscall
t2:
  c.le.d 5, $f22, $f20
  bc1t 5, t3
  li $a0, 'X'
  li $v0, 11
  syscall
t3:
  c.eq.d $f20, $f20
  li $t1, 5
  li $t2, 9
  movt $t1, $t2
  movf $t2, $zero, 3
  movt $t3, $t2, 5
  movf.s $f1, $f4, 3
  movt.s $f3, $f6
  movt.d $f12, $f22, 5
  movn.s $f5, $f6, $t1
  movz.d $f14, $f20, $zero
  mfc1.d $t4, $f20
  mtc1.d $t4, $f18
  li $v0, 4
  la $a0, nl
  syscall
  la $s2, dvals
  ldc1 $f0, 8($s2)
  sdc1 $f0, 16($s2)
  lwc1 $f2, one
  swc1 $f2, 24($s2)
  ldc1 $f8, 16($s2)
  lwc1 $f10, 24($s2)
  li $v0, 10
  syscall
