# golden: norun
# Data can only go where MARS has data memory: not past 0x103fffff, not below the stack, not in text.
.data 0x103ffffc
    .word 1, 2
.data 0x7fbffffc
    .word 3
.data 0x00400000
    .asciiz "hi"
.data 0x7fc00000
    .word 4
