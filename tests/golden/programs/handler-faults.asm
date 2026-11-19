# Faults that MARS hands to a .ktext handler: failed system calls (cause 8), loads from either text
# segment or past the 4 MB that each segment really has (cause 4), and stores outside mapped memory
# (cause 5). The handler logs every cause and bad address in kernel data, which is also where it keeps
# its counter (a store above 0x80000000 must work).
# golden: mem=0x90000000-0x9000005c
.text
main:
    li $v0, 99          # no such service
    syscall
    li $v0, 5           # "abc" is not an integer
    syscall
    li $v0, 42          # random int with upper bound 0
    li $a0, 0
    li $a1, 0
    syscall
    li $v0, 9           # negative sbrk
    li $a0, -4
    syscall
    li $v0, 9           # more heap than the data segment holds
    li $a0, 0x003c0000
    syscall
    li $t0, 0x00400000  # the text segment
    lw $t1, 0($t0)
    li $t0, 0x80000184  # the kernel text segment
    lb $t1, 0($t0)
    li $t0, 0x10400000  # just past data memory
    lw $t1, 0($t0)
    li $t0, 0x7fbffffc  # just below the stack
    sw $t1, 0($t0)
    li $t0, 0x90400000  # just past kernel data
    sw $t1, 0($t0)
    li $t1, 41
    li $t0, 0x7fc00000  # the lowest stack word is fine
    sw $t1, 0($t0)
    lw $s2, 0($t0)
    li $t0, 0x903ffffc  # so is the last kernel data word
    sw $t1, 0($t0)
    lw $s3, 0($t0)
    li $a0, 0x003bfffc  # the largest heap that still fits
    li $v0, 9
    syscall
    move $s4, $v0
    li $v0, 10
    syscall

.kdata
count: .word 0          # 0x90000000; entry n (from 1) is at 0x90000000 + 8n: cause, BadVAddr
log: .space 96

.ktext 0x80000180
    lui $k1, 0x9000
    lw $k0, 0($k1)
    addi $k0, $k0, 1
    sw $k0, 0($k1)
    sll $k0, $k0, 3
    addu $k1, $k1, $k0
    mfc0 $k0, $13
    srl $k0, $k0, 2
    andi $k0, $k0, 31
    sw $k0, 0($k1)
    mfc0 $k0, $8
    sw $k0, 4($k1)
    mfc0 $k0, $14
    addi $k0, $k0, 4
    mtc0 $k0, $14
    eret
