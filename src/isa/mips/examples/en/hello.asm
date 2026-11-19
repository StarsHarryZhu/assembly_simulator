# Hello, world
.data
greet:  .asciiz "Hello, world!\n"

.text
main:
    li      $v0, 4              # syscall 4: print the string $a0 points to
    la      $a0, greet
    syscall
    li      $v0, 10             # syscall 10: exit
    syscall
