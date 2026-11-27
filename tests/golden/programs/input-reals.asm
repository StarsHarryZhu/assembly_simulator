# golden: run
# Reading reals (syscalls 6 and 7) as MARS does with Java's Float.parseFloat and Double.parseDouble:
# a float is rounded once, straight from the decimal text (not through a double first), so a value just
# above the halfway point between two floats rounds up; spaces around the number are ignored, a
# too-large float becomes Infinity, and NaN, Infinity and f/d suffixes are accepted. Each float is
# printed as its bit pattern, each double as a number.
.text
main:
    li $s0, 6
floats:
    li $v0, 6
    syscall
    mfc1 $a0, $f0
    li $v0, 34
    syscall
    li $a0, 10
    li $v0, 11
    syscall
    addi $s0, $s0, -1
    bgtz $s0, floats
    li $s0, 3
doubles:
    li $v0, 7
    syscall
    mov.d $f12, $f0
    li $v0, 3
    syscall
    li $a0, 10
    li $v0, 11
    syscall
    addi $s0, $s0, -1
    bgtz $s0, doubles
    li $v0, 10
    syscall
