# Exceptions: an overflow caught by the handler in .ktext
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
    add     $t2, $t0, $t1       # signed overflow: jumps to 0x80000180
    li      $v0, 4
    la      $a0, after
    syscall
    li      $v0, 10
    syscall

.kdata
kmsg:   .asciiz "  [handler] exception code = "

.ktext  0x80000180
    move    $k1, $at            # save $at first (pseudo-instructions use it)
    mfc0    $k0, $13            # Cause register
    srl     $s7, $k0, 2
    andi    $s7, $s7, 31        # exception code: 12 = overflow
    li      $v0, 4
    la      $a0, kmsg
    syscall
    li      $v0, 1
    move    $a0, $s7
    syscall
    li      $v0, 11
    li      $a0, '\n'
    syscall
    mfc0    $k0, $14            # EPC: address of the faulting instruction
    addi    $k0, $k0, 4         # skip that instruction
    mtc0    $k0, $14
    move    $at, $k1
    eret
