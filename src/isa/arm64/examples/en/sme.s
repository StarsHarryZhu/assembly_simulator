// SME: matrix multiply with outer products
// C = A × B, with A 4 × 3 and B 3 × 4. fmopa adds the outer product of a column of A and a row of B
// to the tile za0.s; one per k, and together they make the whole product. A is stored by columns.
// B is the identity with a column of ones added: C repeats A and ends with the sum of each row of A.
// Step through, click za in the SME bank of the register panel and pick za0.s to watch each fmopa build C
// (smstop clears ZA). Another SVL in the toolbar gives the same C.

.text
.global main
main:
    stp     x29, x30, [sp, #-32]!
    stp     x19, x20, [sp, #16]
    mov     x29, sp
    smstart                             // enter Streaming SVE mode and enable ZA
    mov     x9, #4                      // M = N = 4
    whilelo p0.s, xzr, x9               // p0: the 4 rows of C
    whilelo p1.s, xzr, x9               // p1: the 4 columns of C
    zero    {za}                        // C = 0
    adr     x0, a_cols
    adr     x1, b_rows
    mov     x2, #3                      // K = 3: the number of outer products
1:
    ld1w    {z0.s}, p0/z, [x0]          // column k of A
    ld1w    {z1.s}, p1/z, [x1]          // row k of B
    fmopa   za0.s, p0/m, p1/m, z0.s, z1.s   // za0.s[i][j] += z0[i] × z1[j]
    add     x0, x0, #16                 // next column (4 floats)
    add     x1, x1, #16                 // next row
    subs    x2, x2, #1
    b.ne    1b
    adr     x3, c
    mov     w12, #0                     // row i: a horizontal slice of za0.s
2:
    st1w    {za0h.s[w12, 0]}, p1, [x3]  // store row i of C
    add     x3, x3, #16
    add     w12, w12, #1
    cmp     w12, #4
    b.ne    2b
    smstop                              // leave streaming mode before calling printf
    adr     x19, c
    mov     x20, #4
3:
    ldp     s0, s1, [x19]               // four numbers of a row; printf wants doubles
    ldp     s2, s3, [x19, #8]
    fcvt    d0, s0
    fcvt    d1, s1
    fcvt    d2, s2
    fcvt    d3, s3
    adr     x0, row
    bl      printf
    add     x19, x19, #16
    subs    x20, x20, #1
    b.ne    3b
    rdsvl   x1, #1                      // SVL in bytes, readable in any mode
    lsr     x2, x1, #2                  // floats along each side of za0.s
    mov     x3, x2                      // square: both sides alike
    lsl     x1, x1, #3                  // in bits
    adr     x0, msg
    bl      printf
    mov     w0, #0
    ldp     x19, x20, [sp, #16]
    ldp     x29, x30, [sp], #32
    ret

.data
a_cols: .float  1, 4, 7, 10             // column 0 of A
        .float  2, 5, 8, 11             // column 1
        .float  3, 6, 9, 12             // column 2
b_rows: .float  1, 0, 0, 1              // row 0 of B
        .float  0, 1, 0, 1
        .float  0, 0, 1, 1
c:      .space  64                      // C: 4 rows of 4 floats
row:    .asciz  "%5g%5g%5g%5g\n"
msg:    .asciz  "SVL = %d bits, za0.s is %d x %d floats\n"
