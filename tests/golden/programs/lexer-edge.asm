# golden: run
# How MARS reads words and data: "08" and "0189" are decimal (not octal), character literals with
# escapes and octal codes, a sign right after a label is the operator (first+4), labels in any script,
# bare values on a line after .word or .half continue that directive, a data label may be used before
# or after its definition, and kernel data aligns with a signed remainder (the word after one byte
# lands at 0x90000008, as in MARS).
.data
first:  .word later, first
        5, 6
        .byte 1
        .half 0x7fff
        -2
later:  .word 7
.kdata
        .byte 1
kword:  .word 2
.text
main:
    li $t0, 08
    li $t1, 0189
    li $t2, '\101'
    li $t3, '\''
    li $t4, '#'
    lw $t5, first+4
    la $t6, kword
    j 标签
    li $t7, 1
标签:
    lw $t8, first
    lh $t9, first+20
    li $v0, 10
    syscall
