# Heap: allocate memory with sbrk and build a linked list
# Each node is 8 bytes: the value, then the address of the next node
.data
arrow:  .asciiz " -> "
nil:    .asciiz "null\n"

.text
main:
    move    $s0, $zero          # list head
    li      $s1, 1              # value to insert
build:
    bgt     $s1, 4, show
    li      $v0, 9              # syscall 9: sbrk, allocate $a0 bytes, address in $v0
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
