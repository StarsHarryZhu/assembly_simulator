// Literal pools: which constants become MOVZ, and where pool entries go.
    .text
start:
    ldr x0, =0x1234
    ldr x1, =0x12340000
    ldr x2, =0xffffffffffffffff
    ldr x3, =-2
    ldr w4, =0xffff0000
    ldr w5, =0x10001
    ldr x6, =0x5555555555555555
    ldr w7, =7
    ldr x8, =0x123400000000
    ldr x9, =0x100000000
    ldr w10, =-1
    b 1f
    .ltorg
1:  ldr x11, =0xdeadbeefcafe
    ldr w12, =0x12345678
    ldr x13, =(1 << 40) + 3
    ldr x14, =0x0000ffff00000000
    nop
    .pool
    ldr x15, =0xabcdef
    ldr w16, =0xfedc
    ret
