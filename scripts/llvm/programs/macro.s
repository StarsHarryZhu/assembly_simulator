// Macros, repetition, conditions, local labels, statement separators and comments.
    .text
    .macro push2 a, b
    stp \a, \b, [sp, #-16]!
    .endm
    .macro pop2 a, b
    ldp \a, \b, [sp], #16
    .endm
    .macro addk reg, k=1
    add \reg, \reg, #\k
    .endm
    .macro tag
    b 1f
1:  nop
    .endm
start:
    push2 x29, x30
    addk x0
    addk x1, 5
    addk x2 k=9
    tag
    tag
    .rept 3
    add x3, x3, #1
    .endr
    .irp r, x4, x5, x6
    mov \r, #2
    .endr
    .irpc n, 789
    mov x\n, #\n
    .endr
COUNT = 2
    .if COUNT > 1
    mov x10, #1
    .elseif COUNT == 1
    mov x10, #2
    .else
    mov x10, #3
    .endif
    .ifdef COUNT
    mov x11, #COUNT
    .endif
    .ifndef MISSING
    mov x12, #12
    .endif
    .ifeq COUNT - 2
    mov x13, #13
    .endif
1:  subs x0, x0, #1
    b.ne 1b
    cbz x0, 2f
    nop
2:  nop ; nop ; add x1, x1, x1   // two NOPs and an ADD
    /* a comment
       across lines */ mov x14, #14
# a whole-line comment
    mov x15, #0x15 /* inline */ ; mov x16, #16
    pop2 x29, x30
    ret
