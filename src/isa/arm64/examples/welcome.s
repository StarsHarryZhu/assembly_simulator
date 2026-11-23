// 欢迎：AArch64 汇编入门
// 这是 ARMv9-A 的 64 位指令集 AArch64，写法和 GNU as（gcc 用的汇编器）一样。
// 点“单步”一行一行地执行，看寄存器怎样变色：灰色没用过，绿色读过，红色写过。
// 程序从 main 开始，像 C 程序一样：参数在 x0–x7，返回值在 x0，返回地址在 x30（lr）。

.text
.global main
main:
    stp     x29, x30, [sp, #-32]!       // 在栈上留 32 字节，存帧指针和返回地址
    mov     x29, sp                     // 帧指针指向这一帧
    stp     x19, x20, [sp, #16]         // x19、x20 归被调用者保存，先存起来
    mov     x19, #0                     // x19 = 和
    mov     x20, #1                     // x20 = i
loop:
    add     x19, x19, x20               // 和 += i
    add     x20, x20, #1                // i += 1
    cmp     x20, #10                    // 比较 i 和 10，结果放进 NZCV 标志
    b.le    loop                        // i <= 10 就回到 loop
    adr     x0, msg                     // 第 1 个参数：格式字符串的地址
    mov     x1, x19                     // 第 2 个参数：和
    bl      printf                      // 调用内置的 printf，返回地址放进 x30
    mov     w0, #0                      // main 返回 0
    ldp     x19, x20, [sp, #16]         // 恢复 x19、x20
    ldp     x29, x30, [sp], #32         // 恢复帧指针和返回地址，释放这一帧
    ret                                 // 回到 x30 指向的地方

.section .rodata
msg:    .asciz  "1 + 2 + ... + 10 = %ld\n"
