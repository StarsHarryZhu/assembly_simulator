# The heap ends where MARS's 4 MB data segment does (0x10400000); a bigger sbrk request fails.
.text
    li $a0, 0x00400000
    li $v0, 9
    syscall
