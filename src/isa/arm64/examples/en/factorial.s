// Factorial: recursion and stack frames
// fact(n) = n × fact(n − 1). Every call leaves a frame on the stack: step through and watch the stack panel grow.

.text
.global main
main:
    stp     x29, x30, [sp, #-32]!
    mov     x29, sp
    str     x19, [sp, #16]              // x19 is callee-saved
    mov     x19, #0                     // x19 = n, from 0 to 10
1:
    mov     x0, x19
    bl      fact                        // x0 = fact(n)
    mov     x2, x0                      // argument 3 of printf: n!
    mov     x1, x19                     // argument 2: n
    adr     x0, line
    bl      printf
    add     x19, x19, #1
    cmp     x19, #10
    b.le    1b                          // 1b: the nearest label 1 before this
    mov     w0, #0
    ldr     x19, [sp, #16]
    ldp     x29, x30, [sp], #32
    ret

// fact(n): argument and result in x0
fact:
    cbz     x0, 1f                      // n = 0: jump to the next label 1 and return 1
    stp     x0, x30, [sp, #-16]!        // save n and the return address
    sub     x0, x0, #1
    bl      fact                        // x0 = fact(n − 1)
    ldp     x1, x30, [sp], #16          // get n and the return address back
    mul     x0, x0, x1                  // x0 = n × fact(n − 1)
    ret
1:
    mov     x0, #1
    ret

.section .rodata
line:   .asciz  "%2ld! = %ld\n"
