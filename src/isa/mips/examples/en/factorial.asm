# Recursive factorial: watch the stack grow and shrink
.data
prompt: .asciiz "10! = "

.text
main:
    li      $a0, 10
    jal     fact
    move    $s0, $v0
    li      $v0, 4
    la      $a0, prompt
    syscall
    li      $v0, 1
    move    $a0, $s0
    syscall
    li      $v0, 10
    syscall

# int fact(int n)
fact:
    addi    $sp, $sp, -8        # save the return address and the argument
    sw      $ra, 4($sp)
    sw      $a0, 0($sp)
    slti    $t0, $a0, 2         # n < 2 ?
    beq     $t0, $zero, recurse
    li      $v0, 1
    addi    $sp, $sp, 8
    jr      $ra
recurse:
    addi    $a0, $a0, -1
    jal     fact                # v0 = fact(n - 1)
    lw      $a0, 0($sp)
    lw      $ra, 4($sp)
    addi    $sp, $sp, 8
    mul     $v0, $a0, $v0       # v0 = n * fact(n - 1)
    jr      $ra
