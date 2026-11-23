// Hello: calling printf and puts from the C library
// printf takes the format string in x0 and the values to print in x1–x7.
// printf and puts are built into the simulator and work as the C library gcc links on Linux.

.text
.global main
main:
    stp     x29, x30, [sp, #-16]!       // bl overwrites x30, so save it on the stack first
    mov     x29, sp
    adr     x0, greeting
    bl      puts                        // puts prints the string and a newline
    adr     x0, format
    mov     x1, #42                     // %ld: decimal
    mov     x2, #255                    // %lx: hexadecimal
    mov     x3, #-7                     // negative numbers print too
    adr     x4, word                    // %s: address of a string
    mov     w5, #'A'                    // %c: one character
    bl      printf
    mov     w0, #0
    ldp     x29, x30, [sp], #16
    ret

.section .rodata
greeting:   .asciz  "Hello from printf!"
format:     .asciz  "dec %ld, hex %lx, negative %ld, string %s, char %c\n"
word:       .asciz  "arm"
