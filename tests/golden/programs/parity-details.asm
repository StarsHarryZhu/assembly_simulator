# Small behaviours where MARS follows Java: how floats and doubles print (shortest digits that read
# back, ties to even), NaN from arithmetic made canonical while neg and abs only flip the sign bit,
# what integer and real input accepts, and strings kept one byte per character (Latin-1 out, low
# byte in). Assembler details too: a later macro with the same name wins, .eqv may repeat with the
# same text and works inside a macro, a dotted name that is not a directive is a label, an unknown
# escape drops its backslash (MARS has no \x), and sbrk rounds the heap top up to a word.
.eqv NL 10
.eqv NL 10
.macro newline
    li $a0, NL
    li $v0, 11
    syscall
.end_macro
.macro twice(%r)
    add %r, %r, %r
.end_macro
.macro twice(%r)
.eqv THREE 3
    mul %r, %r, THREE
.end_macro

.data
floats:  .float 1.0e7, 1.0e-3, 0.1, 3.4028234e38, 1.17549435e-38, 100.0, 1.4e-45, 123456.7, 9.999999e-5
         .word 1                # smallest denormal
doubles: .double 4.9e-324, 1.0e21, 1.0e-7, 2.718281828459045, 1.0e23, 9007199254740993.0, 0.001, 1.0e-4
nan1:    .word 0x7f800001       # a signalling NaN with a payload
         .align 3
nan2:    .word 1, 0x7ff00000
text:    .asciiz "caf\xe9 \q é\n"
buf:     .space 16

.text
main:
    la $s0, floats
    li $s1, 10
floats_loop:
    lwc1 $f12, 0($s0)
    li $v0, 2
    syscall
    newline
    addi $s0, $s0, 4
    addi $s1, $s1, -1
    bnez $s1, floats_loop

    la $s0, doubles
    li $s1, 8
doubles_loop:
    ldc1 $f12, 0($s0)
    li $v0, 3
    syscall
    newline
    addi $s0, $s0, 8
    addi $s1, $s1, -1
    bnez $s1, doubles_loop

    li $t0, 0x3dcccccd          # 0.1f + 0.2f
    mtc1 $t0, $f0
    li $t0, 0x3e4ccccd
    mtc1 $t0, $f1
    add.s $f12, $f0, $f1
    li $v0, 2
    syscall
    newline

    lwc1 $f0, nan1              # neg and abs keep the payload; div gives the canonical 0x7fc00000
    neg.s $f2, $f0
    abs.s $f3, $f0
    la $t0, nan2
    ldc1 $f4, 0($t0)
    neg.d $f6, $f4
    sub.s $f8, $f1, $f1
    div.s $f9, $f8, $f8

    li $v0, 5                   # Arabic-Indic digits are digits to Integer.parseInt
    syscall
    move $s2, $v0
    li $v0, 7                   # a hexadecimal double
    syscall
    mov.d $f12, $f0
    li $v0, 3
    syscall
    newline
    li $v0, 6                   # a type suffix is fine
    syscall
    mov.s $f12, $f0
    li $v0, 2
    syscall
    newline
    li $v0, 8                   # each character keeps only its low byte
    la $a0, buf
    li $a1, 16
    syscall
    li $v0, 4
    syscall
    li $v0, 12                  # read character returns the whole code
    syscall
    move $s3, $v0

    la $a0, text
    li $v0, 4
    syscall

    li $s4, 5
    twice($s4)                  # the second definition: 5 * 3
    b .L1
    li $s4, 0
.L1:
    li $a0, 5                   # sbrk rounds the heap top up to a word
    li $v0, 9
    syscall
    li $a0, 4
    li $v0, 9
    syscall
    move $s5, $v0
    li $v0, 10
    syscall
