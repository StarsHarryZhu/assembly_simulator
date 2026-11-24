// Neon: vector dot product
// One fmla works on 4 lanes at once: v0[i] += a[i] × b[i]. 16 elements take 4 rounds; faddp then adds the 4 partial sums.
// Click v0 in the register panel and pick S lanes shown as Float to see the 4 partial sums.

.text
.global main
main:
    stp     x29, x30, [sp, #-16]!
    mov     x29, sp
    adr     x0, vec_a
    adr     x1, vec_b
    mov     x2, #16                     // number of elements
    movi    v0.4s, #0                   // v0 = 4 partial sums
1:
    ld1     {v1.4s}, [x0], #16          // load 4 elements of a, then x0 += 16
    ld1     {v2.4s}, [x1], #16
    fmla    v0.4s, v1.4s, v2.4s         // multiply-add in 4 lanes at once
    subs    x2, x2, #4
    b.ne    1b
    faddp   v0.4s, v0.4s, v0.4s         // add neighbours: the first two lanes hold two sums
    faddp   s0, v0.2s                   // once more: the total
    fcvt    d0, s0                      // printf wants a double
    adr     x0, fdot
    bl      printf
    adr     x0, bytes                   // integers: udot does 4 dot products of 4 bytes each
    ld1     {v1.16b}, [x0]
    movi    v0.4s, #0
    udot    v0.4s, v1.16b, v1.16b       // v0[i] = sum of squares of the 4 bytes of group i
    addv    s0, v0.4s                   // add the 4 lanes
    fmov    w1, s0                      // the integer result goes to w1 for printf
    adr     x0, idot
    bl      printf
    mov     w0, #0
    ldp     x29, x30, [sp], #16
    ret

.data
vec_a:  .float  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
vec_b:  .float  16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
bytes:  .byte   1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
fdot:   .asciz  "a . b = %g\n"
idot:   .asciz  "1^2 + 2^2 + ... + 16^2 = %d\n"
