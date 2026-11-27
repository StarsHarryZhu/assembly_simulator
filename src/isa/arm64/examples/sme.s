// SME：用外积做矩阵乘法
// C = A × B，A 是 4 × 3，B 是 3 × 4。fmopa 把 A 的一列和 B 的一行的外积加到 tile za0.s 上，
// 对每个 k 做一次，加起来就是整个乘积。A 按列存放，所以每一列是连续的。
// B 的前三列是单位阵、最后一列全是 1：C 的前三列就是 A，最后一列是 A 每行的和。
// 单步执行，在寄存器面板的 SME 分组里点 za、选 za0.s，看每个 fmopa 怎样把 C 加出来（smstop 会把 ZA 清零）。
// 在工具栏里换一个 SVL 再运行，结果不变。

.text
.global main
main:
    stp     x29, x30, [sp, #-32]!
    stp     x19, x20, [sp, #16]
    mov     x29, sp
    smstart                             // 进入流式 SVE 模式，并打开 ZA
    mov     x9, #4                      // M = N = 4
    whilelo p0.s, xzr, x9               // p0：C 的 4 行
    whilelo p1.s, xzr, x9               // p1：C 的 4 列
    zero    {za}                        // C = 0
    adr     x0, a_cols
    adr     x1, b_rows
    mov     x2, #3                      // K = 3：外积的个数
1:
    ld1w    {z0.s}, p0/z, [x0]          // A 的第 k 列
    ld1w    {z1.s}, p1/z, [x1]          // B 的第 k 行
    fmopa   za0.s, p0/m, p1/m, z0.s, z1.s   // za0.s[i][j] += z0[i] × z1[j]
    add     x0, x0, #16                 // 下一列（4 个单精度数）
    add     x1, x1, #16                 // 下一行
    subs    x2, x2, #1
    b.ne    1b
    adr     x3, c
    mov     w12, #0                     // 第 i 行：za0.s 的水平切片
2:
    st1w    {za0h.s[w12, 0]}, p1, [x3]  // 存 C 的第 i 行
    add     x3, x3, #16
    add     w12, w12, #1
    cmp     w12, #4
    b.ne    2b
    smstop                              // 调用 printf 之前退出流式模式
    adr     x19, c
    mov     x20, #4
3:
    ldp     s0, s1, [x19]               // 一行的四个数，printf 要 double
    ldp     s2, s3, [x19, #8]
    fcvt    d0, s0
    fcvt    d1, s1
    fcvt    d2, s2
    fcvt    d3, s3
    adr     x0, row
    bl      printf
    add     x19, x19, #16
    subs    x20, x20, #1
    b.ne    3b
    rdsvl   x1, #1                      // SVL 的字节数，在哪种模式下都能读
    lsr     x2, x1, #2                  // za0.s 每边的单精度数
    mov     x3, x2                      // 方阵：两边一样长
    lsl     x1, x1, #3                  // 换成位数
    adr     x0, msg
    bl      printf
    mov     w0, #0
    ldp     x19, x20, [sp, #16]
    ldp     x29, x30, [sp], #32
    ret

.data
a_cols: .float  1, 4, 7, 10             // A 的第 0 列
        .float  2, 5, 8, 11             // 第 1 列
        .float  3, 6, 9, 12             // 第 2 列
b_rows: .float  1, 0, 0, 1              // B 的第 0 行
        .float  0, 1, 0, 1
        .float  0, 0, 1, 1
c:      .space  64                      // C：4 行 × 4 个单精度数
row:    .asciz  "%5g%5g%5g%5g\n"
msg:    .asciz  "SVL = %d bits, za0.s is %d x %d floats\n"
