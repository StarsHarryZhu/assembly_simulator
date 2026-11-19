# Input: type your name and age in the terminal
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
    li      $v0, 8              # syscall 8: read a line into $a0, at most $a1 - 1 characters
    la      $a0, name
    li      $a1, 32
    syscall
    li      $v0, 4
    la      $a0, ask2
    syscall
    li      $v0, 5              # syscall 5: read an integer into $v0
    syscall
    move    $s0, $v0

    li      $v0, 4
    la      $a0, hello
    syscall
    la      $a0, name           # the name still ends with the newline
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
