# 堆：用 sbrk 申请内存，建一个链表
# 每个节点 8 字节：值、下一个节点的地址
.data
arrow:  .asciiz " -> "
nil:    .asciiz "null\n"

.text
main:
    move    $s0, $zero          # 链表头
    li      $s1, 1              # 要插入的值
build:
    bgt     $s1, 4, show
    li      $v0, 9              # syscall 9：sbrk，申请 $a0 字节，地址放进 $v0
    li      $a0, 8
    syscall
    sw      $s1, 0($v0)         # node.value = s1
    sw      $s0, 4($v0)         # node.next = head
    move    $s0, $v0            # head = node
    addi    $s1, $s1, 1
    j       build

show:
    move    $t0, $s0
walk:
    beqz    $t0, done
    lw      $a0, 0($t0)
    li      $v0, 1
    syscall
    li      $v0, 4
    la      $a0, arrow
    syscall
    lw      $t0, 4($t0)
    j       walk
done:
    li      $v0, 4
    la      $a0, nil
    syscall
    li      $v0, 10
    syscall
