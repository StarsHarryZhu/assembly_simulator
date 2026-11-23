// Input: reading numbers and a name with scanf
// Type in the terminal and press Enter. scanf takes the addresses to store results at; here they are on the stack.

.text
.global main
main:
    stp     x29, x30, [sp, #-64]!       // a 64-byte frame: x29, x30, two numbers, then the name
    mov     x29, sp
    adr     x0, ask_numbers
    bl      printf
    adr     x0, two_numbers
    add     x1, sp, #16                 // the first number goes to sp + 16
    add     x2, sp, #24                 // the second to sp + 24
    bl      scanf
    ldr     x1, [sp, #16]
    ldr     x2, [sp, #24]
    add     x3, x1, x2                  // sum
    mov     x4, x1
    mov     x5, x2
    mul     x6, x1, x2                  // product
    adr     x0, results
    bl      printf
    adr     x0, ask_name
    bl      printf
    adr     x0, one_word                // %31s: up to 31 characters, stopping at a space
    add     x1, sp, #32                 // the name goes to sp + 32, 32 bytes
    bl      scanf
    adr     x0, hello
    add     x1, sp, #32
    bl      printf
    mov     w0, #0
    ldp     x29, x30, [sp], #64
    ret

.section .rodata
ask_numbers:    .asciz  "Two numbers: "
two_numbers:    .asciz  "%ld %ld"
results:        .asciz  "%ld + %ld = %ld\n%ld * %ld = %ld\n"
ask_name:       .asciz  "Your name: "
one_word:       .asciz  "%31s"
hello:          .asciz  "Hello, %s!\n"
