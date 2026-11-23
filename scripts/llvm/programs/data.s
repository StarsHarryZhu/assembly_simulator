// Data directives, expressions and alignment.
    .data
bytes:  .byte 1, 2, 0xff, -1, 'b', 0b101, 017, 255
halves: .hword 0x1234, -2
        .short 7
        .2byte 8
words:  .word 0x12345678, -1, words - bytes
        .long 1 << 20
        .int 5 * 3 + 2
        .4byte (1 + 2) * 3
quads:  .quad 0x123456789abcdef0, -3
        .xword 1
        .dword 2
        .8byte 3
text:   .ascii "ab\n\t\"\\", "c"
        .asciz "x\101\x42"
        .string "yz"
len = . - text
        .byte len
        .equ TEN, 10
        .set TWENTY, TEN * 2
        .byte TEN, TWENTY, TWENTY / 3, TWENTY % 3, -TEN & 0xff, ~0 & 0xff, 1 | 6, 6 ^ 3
        .byte (3 > 2), (3 < 2), (3 == 3) & 1, 2 != 2, 5 >= 5, 4 <= 3, 1 && 0, 1 || 0
        .byte 100 >> 2, 0x80 >> 7, -8 >> 1 & 0xff
        .align 3
aligned: .quad 1
        .p2align 2, 0xee
        .byte 9
        .balign 8, 0xcc
        .word 0x11
        .skip 3
        .space 2, 0xaa
        .zero 2
        .fill 3, 2, 0x0102
        .fill 2, 1, 7
        .float 1.5, -0.25
        .double 3.25, 1e10
        .single 2.0
        .balign 4
end:    .word end - bytes
    .text
    nop
    .balign 16
    add x0, x0, #1
    .p2align 3
    ret
    .inst 0xd503201f, 0x8b020020
    .word 0x12345678
    .align 2
    nop
