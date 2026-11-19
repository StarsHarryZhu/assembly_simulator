# Welcome: call a function that sums an array
# Press Step (F7) to run one line at a time and watch the registers, stack and memory on the right:
# grey = not used yet, green = read, red = written.

.data
nums:   .word   3, 1, 4, 1, 5, 9, 2, 6
count:  .word   8
total:  .word   0
msg:    .asciiz "sum = "

.text
main:
    la      $a0, nums           # argument 1: array address
    lw      $a1, count          # argument 2: element count
    jal     sum                 # call sum; the return address goes into $ra
    sw      $v0, total          # store the result in memory
    move    $s0, $v0

    li      $v0, 4              # syscall 4: print a string
    la      $a0, msg
    syscall
    li      $v0, 1              # syscall 1: print an integer
    move    $a0, $s0
    syscall
    li      $v0, 11             # syscall 11: print a character
    li      $a0, '\n'
    syscall
    li      $v0, 10             # syscall 10: exit
    syscall

# int sum(int *a, int n): saves $s0 and $s1 on the stack before using them
sum:
    addi    $sp, $sp, -8        # make room for 2 words on the stack
    sw      $s0, 0($sp)
    sw      $s1, 4($sp)
    move    $s0, $zero          # s0 = running total
    move    $s1, $zero          # s1 = index i
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
    lw      $s0, 0($sp)         # restore the caller's $s0 and $s1
    lw      $s1, 4($sp)
    addi    $sp, $sp, 8
    jr      $ra
