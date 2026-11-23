// 你好：调用 C 库的 printf 和 puts
// printf 的格式字符串放 x0，要输出的值依次放 x1–x7。
// 这里的 printf、puts 是模拟器内置的，用法和 Linux 上 gcc 链接的 C 库一样。

.text
.global main
main:
    stp     x29, x30, [sp, #-16]!       // bl 会改写 x30，所以先把它存到栈上
    mov     x29, sp
    adr     x0, greeting
    bl      puts                        // puts 输出字符串，再输出换行
    adr     x0, format
    mov     x1, #42                     // %ld：十进制
    mov     x2, #255                    // %lx：十六进制
    mov     x3, #-7                     // 负数照样输出
    adr     x4, word                    // %s：字符串的地址
    mov     w5, #'A'                    // %c：一个字符
    bl      printf
    mov     w0, #0
    ldp     x29, x30, [sp], #16
    ret

.section .rodata
greeting:   .asciz  "Hello from printf!"
format:     .asciz  "dec %ld, hex %lx, negative %ld, string %s, char %c\n"
word:       .asciz  "arm"
