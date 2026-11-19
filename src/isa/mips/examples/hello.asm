# Hello, world
.data
greet:  .asciiz "Hello, world!\n"

.text
main:
    li      $v0, 4              # syscall 4：打印 $a0 指向的字符串
    la      $a0, greet
    syscall
    li      $v0, 10             # syscall 10：结束程序
    syscall
