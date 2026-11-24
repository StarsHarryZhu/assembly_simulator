// SVE: a loop independent of the vector length
// whilelo works out which elements this round handles, and the last round takes only those left, so the same code is right at any vector length.
// Pick another vector length in the settings (128 to 2048 bits) and run again: the result stays, only the number of rounds changes.
// The SVE group of the register panel shows z0–z3 and the predicate p0.

.text
.global main
main:
    stp     x29, x30, [sp, #-16]!
    mov     x29, sp
    adr     x0, xs
    adr     x1, ys
    mov     x2, #0                      // i: the next element
    mov     x3, #19                     // n: the element count, not a multiple of the vector length
    mov     x4, #0                      // rounds
    fmov    z2.s, #2.0                  // every element of z2 is a = 2.0
    mov     z3.s, #0                    // z3: partial sums per lane
    whilelo p0.s, x2, x3                // p0: the elements from i on that are below n
1:
    ld1w    {z0.s}, p0/z, [x0, x2, lsl #2]
    ld1w    {z1.s}, p0/z, [x1, x2, lsl #2]
    fmla    z1.s, p0/m, z0.s, z2.s      // y += a × x, only for the elements p0 selects
    st1w    {z1.s}, p0, [x1, x2, lsl #2]
    fadd    z3.s, p0/m, z3.s, z1.s      // add them up as we go
    incw    x2                          // i += the number of singles in a vector
    add     x4, x4, #1
    whilelo p0.s, x2, x3
    b.first 1b                          // the first element of p0 is true: not done yet
    ptrue   p1.s
    faddv   s0, p1, z3.s                // add the lanes' partial sums
    fcvt    d0, s0                      // printf wants a double
    cntb    x1                          // bytes in a vector
    lsl     x1, x1, #3                  // as bits
    mov     x2, x4
    adr     x0, msg
    bl      printf
    mov     w0, #0
    ldp     x29, x30, [sp], #16
    ret

.data
xs:     .float  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19
ys:     .float  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
msg:    .asciz  "sum of a*x + y = %g, VL = %d bits, %d rounds\n"
