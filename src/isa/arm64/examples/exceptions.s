// 异常：EL1 向量表接住错误再返回
// 程序有 .ktext 段时，出错不会直接停下：处理器进入内核态（EL1），跳到向量表里的处理程序。
// 处理程序从 ESR_EL1 读出原因，把 ELR_EL1（出错指令的地址）加 4，再用 eret 回到下一条指令。

.text
.global main
main:
    stp     x29, x30, [sp, #-16]!
    mov     x29, sp
    adr     x0, value
    add     x0, x0, #1                  // 故意让地址不按 8 字节对齐
    ldxr    x1, [x0]                    // 独占加载必须对齐：对齐错误，EC = 0x24
    brk     #7                          // 断点，EC = 0x3c
    adr     x0, back
    bl      puts
    mov     w0, #0
    ldp     x29, x30, [sp], #16
    ret

.data
        .balign 16
value:  .quad   0x1122334455667788, 0
back:   .asciz  "Back in main after two exceptions."

.section .ktext, "ax"
    .balign 2048                        // 向量表要按 2 KB 对齐
vectors:
    .skip   0x400                       // 前 0x400 字节是 EL1 自己出错时的入口，这里不用
el0_sync:                               // VBAR_EL1 + 0x400：来自 EL0 的同步异常
    stp     x29, x30, [sp, #-48]!       // 这里的 sp 是内核栈 SP_EL1
    stp     x0, x1, [sp, #16]
    stp     x2, x3, [sp, #32]
    mrs     x1, esr_el1
    ubfx    x1, x1, #26, #6             // 异常类别 EC = ESR 的第 31..26 位
    mrs     x2, elr_el1                 // 出错指令的地址
    adr     x0, report
    ldr     x9, =printf                 // C 库离内核太远，bl 够不着（只有 ±128 MB）
    blr     x9                          // 所以把地址放进寄存器再调用
    mrs     x2, elr_el1
    add     x2, x2, #4                  // 跳过出错的指令
    msr     elr_el1, x2
    ldp     x2, x3, [sp, #32]
    ldp     x0, x1, [sp, #16]
    ldp     x29, x30, [sp], #48
    eret                                // 回到 EL0，从 ELR_EL1 继续

.section .kdata, "aw"
report: .asciz  "  exception: EC = 0x%lx at %p\n"
