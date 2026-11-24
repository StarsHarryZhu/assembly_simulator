// Floating point: square root by Newton's method
// Repeat x = (x + 2 / x) / 2 until x stops changing, printing every step, then compare with fsqrt.
// The FP registers are in the "FP and vector registers" bank; s0 is the low 32 bits of v0, d0 the low 64.

.text
.global main
main:
    stp     x29, x30, [sp, #-48]!
    mov     x29, sp
    stp     d8, d9, [sp, #16]           // d8–d15 are callee-saved
    str     x19, [sp, #32]
    fmov    d8, #2.0                    // d8 = a, whose square root we want
    fmov    d9, #1.0                    // d9 = x, first guess 1.0
    mov     x19, #0                     // x19 = step count
1:
    fdiv    d0, d8, d9                  // d0 = a / x
    fadd    d0, d0, d9                  // d0 = x + a / x
    fmov    d1, #0.5
    fmul    d0, d0, d1                  // d0 = the new x
    fcmp    d0, d9                      // compare new and old x; the result goes to NZCV
    fmov    d9, d0
    b.eq    2f                          // no change: converged
    add     x19, x19, #1
    mov     x1, x19                     // printf takes integers in x1…
    adr     x0, step                    // …and floating point in d0 (already x)
    bl      printf
    b       1b
2:
    fsqrt   d0, d8                      // the hardware square root
    fsub    d1, d9, d0                  // their difference
    adr     x0, check
    bl      printf
    fcvt    s0, d9                      // to single precision: about 7 significant digits
    fcvt    d0, s0                      // printf's floating-point arguments are always double
    ldr     d1, scale
    fmul    d1, d9, d1
    fcvtas  x1, d1                      // x × 10^6 rounded to an integer
    adr     x0, single
    bl      printf
    mov     w0, #0
    ldr     x19, [sp, #32]
    ldp     d8, d9, [sp, #16]
    ldp     x29, x30, [sp], #48
    ret

.section .rodata
        .p2align 3
scale:  .double 1000000.0
step:   .asciz  "step %ld: x = %.17g\n"
check:  .asciz  "fsqrt:  x = %.17g, difference %g\n"
single: .asciz  "as float: %.9g, x * 10^6 rounded: %ld\n"
