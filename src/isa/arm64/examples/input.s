// 读入：用 scanf 读数字和名字
// 运行后在终端里输入，按回车。scanf 的参数是存放结果的地址，这里用栈上的空间。

.text
.global main
main:
    stp     x29, x30, [sp, #-64]!       // 64 字节的栈帧：x29、x30，两个数，再放名字
    mov     x29, sp
    adr     x0, ask_numbers
    bl      printf
    adr     x0, two_numbers
    add     x1, sp, #16                 // 第 1 个数存到 sp + 16
    add     x2, sp, #24                 // 第 2 个数存到 sp + 24
    bl      scanf
    ldr     x1, [sp, #16]
    ldr     x2, [sp, #24]
    add     x3, x1, x2                  // 和
    mov     x4, x1
    mov     x5, x2
    mul     x6, x1, x2                  // 积
    adr     x0, results
    bl      printf
    adr     x0, ask_name
    bl      printf
    adr     x0, one_word                // %31s：最多 31 个字符，遇到空格停下
    add     x1, sp, #32                 // 名字存到 sp + 32，共 32 字节
    bl      scanf
    adr     x0, hello
    add     x1, sp, #32
    bl      printf
    mov     w0, #0
    ldp     x29, x30, [sp], #64
    ret

.section .rodata
ask_numbers:    .asciz  "Two numbers: "
two_numbers:    .asciz  "%ld %ld"
results:        .asciz  "%ld + %ld = %ld\n%ld * %ld = %ld\n"
ask_name:       .asciz  "Your name: "
one_word:       .asciz  "%31s"
hello:          .asciz  "Hello, %s!\n"
