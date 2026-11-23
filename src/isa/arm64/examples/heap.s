// 堆：用 malloc 申请内存
// malloc 返回新内存的地址；内存面板会多出一个堆块。用完用 free 还回去。

.text
.global main
main:
    stp     x29, x30, [sp, #-32]!
    mov     x29, sp
    stp     x19, x20, [sp, #16]
    mov     x0, #10 * 8                 // 10 个 8 字节的数
    bl      malloc
    mov     x19, x0                     // x19 = 数组的地址
    mov     x20, #0                     // x20 = 下标 i
1:
    mul     x1, x20, x20                // i 的平方
    str     x1, [x19, x20, lsl #3]      // 存到 数组[i]：地址 = x19 + i × 8
    add     x20, x20, #1
    cmp     x20, #10
    b.lo    1b
    mov     x20, #0
2:
    ldr     x2, [x19, x20, lsl #3]
    mov     x1, x20
    adr     x0, item
    bl      printf
    add     x20, x20, #1
    cmp     x20, #10
    b.lo    2b
    mov     x0, x19
    bl      free                        // 还回内存，堆块从内存面板里消失
    mov     w0, #0
    ldp     x19, x20, [sp, #16]
    ldp     x29, x30, [sp], #32
    ret

.section .rodata
item:   .asciz  "%ld squared is %ld\n"
