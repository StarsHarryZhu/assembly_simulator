// 阶乘：递归调用和栈帧
// fact(n) = n × fact(n − 1)。每次调用都在栈上留一帧，单步时看栈面板一层层变深。

.text
.global main
main:
    stp     x29, x30, [sp, #-32]!
    mov     x29, sp
    str     x19, [sp, #16]              // x19 归被调用者保存
    mov     x19, #0                     // x19 = n，从 0 算到 10
1:
    mov     x0, x19
    bl      fact                        // x0 = fact(n)
    mov     x2, x0                      // printf 的第 3 个参数：n!
    mov     x1, x19                     // 第 2 个参数：n
    adr     x0, line
    bl      printf
    add     x19, x19, #1
    cmp     x19, #10
    b.le    1b                          // 1b：往回找最近的标签 1
    mov     w0, #0
    ldr     x19, [sp, #16]
    ldp     x29, x30, [sp], #32
    ret

// fact(n)：参数和返回值都在 x0
fact:
    cbz     x0, 1f                      // n = 0 时跳到后面的标签 1，返回 1
    stp     x0, x30, [sp, #-16]!        // 保存 n 和返回地址
    sub     x0, x0, #1
    bl      fact                        // x0 = fact(n − 1)
    ldp     x1, x30, [sp], #16          // 取回 n 和返回地址
    mul     x0, x0, x1                  // x0 = n × fact(n − 1)
    ret
1:
    mov     x0, #1
    ret

.section .rodata
line:   .asciz  "%2ld! = %ld\n"
