// Welcome: a first look at AArch64
// This is AArch64, the 64-bit instruction set of ARMv9-A, written as for GNU as (the assembler gcc uses).
// Press Step to run it line by line and watch the registers: grey unused, green read, red written.
// The program starts at main, like a C program: arguments in x0–x7, the result in x0, the return address in x30 (lr).

.text
.global main
main:
    stp     x29, x30, [sp, #-32]!       // reserve 32 bytes; save frame pointer and return address
    mov     x29, sp                     // the frame pointer marks this frame
    stp     x19, x20, [sp, #16]         // x19 and x20 are callee-saved: keep them
    mov     x19, #0                     // x19 = sum
    mov     x20, #1                     // x20 = i
loop:
    add     x19, x19, x20               // sum += i
    add     x20, x20, #1                // i += 1
    cmp     x20, #10                    // compare i with 10; the result goes to NZCV
    b.le    loop                        // back to loop while i <= 10
    adr     x0, msg                     // argument 1: address of the format string
    mov     x1, x19                     // argument 2: the sum
    bl      printf                      // call the built-in printf; x30 gets the return address
    mov     w0, #0                      // main returns 0
    ldp     x19, x20, [sp, #16]         // restore x19 and x20
    ldp     x29, x30, [sp], #32         // restore fp and lr, free the frame
    ret                                 // return to the address in x30

.section .rodata
msg:    .asciz  "1 + 2 + ... + 10 = %ld\n"
