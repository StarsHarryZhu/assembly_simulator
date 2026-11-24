// 浮点：牛顿法求 √2
// 反复做 x = (x + 2 / x) / 2，直到 x 不再变化，每步打印一次，最后和 fsqrt 的结果比较。
// 浮点寄存器在寄存器面板的“浮点和向量寄存器”一组；s0 是 v0 的低 32 位，d0 是低 64 位。

.text
.global main
main:
    stp     x29, x30, [sp, #-48]!
    mov     x29, sp
    stp     d8, d9, [sp, #16]           // d8–d15 归被调用者保存
    str     x19, [sp, #32]
    fmov    d8, #2.0                    // d8 = a，要求它的平方根
    fmov    d9, #1.0                    // d9 = x，先猜 1.0
    mov     x19, #0                     // x19 = 步数
1:
    fdiv    d0, d8, d9                  // d0 = a / x
    fadd    d0, d0, d9                  // d0 = x + a / x
    fmov    d1, #0.5
    fmul    d0, d0, d1                  // d0 = 新的 x
    fcmp    d0, d9                      // 比较新旧两个 x，结果在 NZCV
    fmov    d9, d0
    b.eq    2f                          // 不再变化：收敛了
    add     x19, x19, #1
    mov     x1, x19                     // printf 的整数参数放 x1…
    adr     x0, step                    // …浮点参数放 d0（已经是 x）
    bl      printf
    b       1b
2:
    fsqrt   d0, d8                      // 硬件平方根
    fsub    d1, d9, d0                  // 两者之差
    adr     x0, check
    bl      printf
    fcvt    s0, d9                      // 转成单精度：只有约 7 位有效数字
    fcvt    d0, s0                      // printf 的浮点参数总是 double
    ldr     d1, scale
    fmul    d1, d9, d1
    fcvtas  x1, d1                      // x × 10^6 四舍五入成整数
    adr     x0, single
    bl      printf
    mov     w0, #0
    ldr     x19, [sp, #32]
    ldp     d8, d9, [sp, #16]
    ldp     x29, x30, [sp], #48
    ret

.section .rodata
        .p2align 3
scale:  .double 1000000.0
step:   .asciz  "step %ld: x = %.17g\n"
check:  .asciz  "fsqrt:  x = %.17g, difference %g\n"
single: .asciz  "as float: %.9g, x * 10^6 rounded: %ld\n"
