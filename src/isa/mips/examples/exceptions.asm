# 异常：溢出被 .ktext 里的异常处理程序接住
.data
before: .asciiz "Adding two big numbers...\n"
after:  .asciiz "Back in main.\n"

.text
main:
    li      $v0, 4
    la      $a0, before
    syscall
    li      $t0, 0x7fffffff
    li      $t1, 1
    add     $t2, $t0, $t1       # 有符号溢出：跳到 0x80000180
    li      $v0, 4
    la      $a0, after
    syscall
    li      $v0, 10
    syscall

.kdata
kmsg:   .asciiz "  [handler] exception code = "

.ktext  0x80000180
    move    $k1, $at            # 先保存 $at（伪指令会用到它）
    mfc0    $k0, $13            # Cause 寄存器
    srl     $s7, $k0, 2
    andi    $s7, $s7, 31        # 异常代码：12 = 溢出
    li      $v0, 4
    la      $a0, kmsg
    syscall
    li      $v0, 1
    move    $a0, $s7
    syscall
    li      $v0, 11
    li      $a0, '\n'
    syscall
    mfc0    $k0, $14            # EPC：出错指令的地址
    addi    $k0, $k0, 4         # 跳过那条指令
    mtc0    $k0, $14
    move    $at, $k1
    eret
