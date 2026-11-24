// Neon：向量点积
// 一条 fmla 同时算 4 个通道：v0[i] += a[i] × b[i]。16 个元素 4 次就算完，最后用 faddp 把 4 个部分和加起来。
// 点寄存器面板里的 v0，选“按 S”和“浮点”，就能看到 4 个通道各自的部分和。

.text
.global main
main:
    stp     x29, x30, [sp, #-16]!
    mov     x29, sp
    adr     x0, vec_a
    adr     x1, vec_b
    mov     x2, #16                     // 元素个数
    movi    v0.4s, #0                   // v0 = 4 个部分和
1:
    ld1     {v1.4s}, [x0], #16          // 读 a 的 4 个元素，然后 x0 += 16
    ld1     {v2.4s}, [x1], #16
    fmla    v0.4s, v1.4s, v2.4s         // 4 个通道同时乘加
    subs    x2, x2, #4
    b.ne    1b
    faddp   v0.4s, v0.4s, v0.4s         // 相邻两两相加：前两个通道是两组和
    faddp   s0, v0.2s                   // 再加一次：总和
    fcvt    d0, s0                      // printf 要 double
    adr     x0, fdot
    bl      printf
    adr     x0, bytes                   // 整数：udot 一次算 4 组、每组 4 个字节的点积
    ld1     {v1.16b}, [x0]
    movi    v0.4s, #0
    udot    v0.4s, v1.16b, v1.16b       // v0[i] = 第 i 组 4 个字节的平方和
    addv    s0, v0.4s                   // 4 个通道相加
    fmov    w1, s0                      // 整数结果放 w1 给 printf
    adr     x0, idot
    bl      printf
    mov     w0, #0
    ldp     x29, x30, [sp], #16
    ret

.data
vec_a:  .float  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
vec_b:  .float  16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
bytes:  .byte   1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
fdot:   .asciz  "a . b = %g\n"
idot:   .asciz  "1^2 + 2^2 + ... + 16^2 = %d\n"
