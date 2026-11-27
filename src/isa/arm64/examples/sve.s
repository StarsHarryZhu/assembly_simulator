// SVE：和向量长度无关的循环
// whilelo 算出这一轮要处理哪些元素，最后一轮只处理剩下的几个，所以同一段代码在任何向量长度下都对。
// 在设置里换一个向量长度（128 到 2048 位）再运行：结果不变，只有轮数变了。
// 寄存器面板的 SVE 分组里可以看 z0–z3 和谓词 p0。

.text
.global main
main:
    stp     x29, x30, [sp, #-16]!
    mov     x29, sp
    adr     x0, xs
    adr     x1, ys
    mov     x2, #0                      // i：下一个元素
    mov     x3, #19                     // n：元素个数，不是向量长度的倍数
    mov     x4, #0                      // 轮数
    fmov    z2.s, #2.0                  // z2 的每个元素都是 a = 2.0
    mov     z3.s, #0                    // z3：各通道的部分和
    whilelo p0.s, x2, x3                // p0：从第 i 个开始、不超过 n 的元素
1:
    ld1w    {z0.s}, p0/z, [x0, x2, lsl #2]
    ld1w    {z1.s}, p0/z, [x1, x2, lsl #2]
    fmla    z1.s, p0/m, z0.s, z2.s      // y += a × x，只算 p0 选中的元素
    st1w    {z1.s}, p0, [x1, x2, lsl #2]
    fadd    z3.s, p0/m, z3.s, z1.s      // 顺便累加
    incw    x2                          // i += 一个向量里单精度数的个数
    add     x4, x4, #1
    whilelo p0.s, x2, x3
    b.first 1b                          // p0 的第一个元素为真：还没算完
    ptrue   p1.s
    faddv   s0, p1, z3.s                // 把各通道的部分和加起来
    fcvt    d0, s0                      // printf 要 double
    cntb    x1                          // 一个向量的字节数
    lsl     x1, x1, #3                  // 换成位数
    mov     x2, x4
    adr     x0, msg
    bl      printf
    mov     w0, #0
    ldp     x29, x30, [sp], #16
    ret

.data
xs:     .float  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19
ys:     .float  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
msg:    .asciz  "sum of a*x + y = %g, VL = %d bits, %d rounds\n"
