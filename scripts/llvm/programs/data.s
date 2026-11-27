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
// Character constants and string escapes as LLVM reads them, symbol values per definition, operators,
// float spellings, wide data, alignment with value sizes and .org.
    .data
chars:  .byte '\0', 'a', '\'', '\t', '\n', '\\', '"'
        .ascii "\x41\x4a42\101\0\177" "juxt"
        .ascii ""
        .byte
        .quad 5 ! 2, 1 << 65, -1 >> 60, -16 >> 2
X = 1
        .byte X
X = X + 1
        .byte X, Y
Y = 7
        .float nan, inf, -infinity, 010, .5, 0x1.8p1, 1.00000005960464477539062500000001
        .double nan, -0x1p-1074, 1e-320
        .octa 0x0123456789abcdef0123456789abcdef, 0x1
        .value 0x1234
        .balign 2
        .balignw 8, 0x1234
        .p2alignl 4, 0xa1b2c3d4
        .balign 0
        .balign 16, 0x55, 3
        .p2align 0
        .byte 0xee
        .balign 8, 0x77, 7
        .org . + 3, 0x99
        .word . - chars, chars - .
        .fill 2, 4, 0x01020304
