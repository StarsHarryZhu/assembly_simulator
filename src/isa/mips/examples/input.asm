# 读入：在终端里输入名字和年龄
.data
ask1:   .asciiz "What is your name? "
ask2:   .asciiz "How old are you? "
hello:  .asciiz "Hello, "
later:  .asciiz "Next year you will be "
name:   .space  32

.text
main:
    li      $v0, 4
    la      $a0, ask1
    syscall
    li      $v0, 8              # syscall 8：读一行字符串到 $a0，最多 $a1 - 1 个字符
    la      $a0, name
    li      $a1, 32
    syscall
    li      $v0, 4
    la      $a0, ask2
    syscall
    li      $v0, 5              # syscall 5：读一个整数到 $v0
    syscall
    move    $s0, $v0

    li      $v0, 4
    la      $a0, hello
    syscall
    la      $a0, name           # 读到的名字末尾带着换行
    syscall
    la      $a0, later
    syscall
    addi    $a0, $s0, 1
    li      $v0, 1
    syscall
    li      $v0, 11
    li      $a0, '\n'
    syscall
    li      $v0, 10
    syscall
