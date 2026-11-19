# 欢迎：调用函数给数组求和
# 按“单步”（F7）一行一行执行，看右边的寄存器、栈和内存怎么变化：
# 灰色 = 还没用到，绿色 = 读过，红色 = 改过。

.data
nums:   .word   3, 1, 4, 1, 5, 9, 2, 6
count:  .word   8
total:  .word   0
msg:    .asciiz "sum = "

.text
main:
    la      $a0, nums           # 参数 1：数组地址
    lw      $a1, count          # 参数 2：元素个数
    jal     sum                 # 调用 sum，返回地址存进 $ra
    sw      $v0, total          # 结果写回内存
    move    $s0, $v0

    li      $v0, 4              # syscall 4：打印字符串
    la      $a0, msg
    syscall
    li      $v0, 1              # syscall 1：打印整数
    move    $a0, $s0
    syscall
    li      $v0, 11             # syscall 11：打印一个字符
    li      $a0, '\n'
    syscall
    li      $v0, 10             # syscall 10：结束程序
    syscall

# int sum(int *a, int n)：把要用的 $s0、$s1 先存到栈上
sum:
    addi    $sp, $sp, -8        # 栈上开 2 个 word
    sw      $s0, 0($sp)
    sw      $s1, 4($sp)
    move    $s0, $zero          # s0 = 累加和
    move    $s1, $zero          # s1 = 下标 i
loop:
    beq     $s1, $a1, done
    sll     $t0, $s1, 2         # t0 = i * 4
    addu    $t0, $a0, $t0       # t0 = &a[i]
    lw      $t1, 0($t0)
    addu    $s0, $s0, $t1
    addi    $s1, $s1, 1
    j       loop
done:
    move    $v0, $s0
    lw      $s0, 0($sp)         # 恢复调用者的 $s0、$s1
    lw      $s1, 4($sp)
    addi    $sp, $sp, 8
    jr      $ra
