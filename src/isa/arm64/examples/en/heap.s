// Heap: memory from malloc
// malloc returns the address of new memory; the memory panel shows a new heap block. free gives it back.

.text
.global main
main:
    stp     x29, x30, [sp, #-32]!
    mov     x29, sp
    stp     x19, x20, [sp, #16]
    mov     x0, #10 * 8                 // ten 8-byte numbers
    bl      malloc
    mov     x19, x0                     // x19 = address of the array
    mov     x20, #0                     // x20 = index i
1:
    mul     x1, x20, x20                // i squared
    str     x1, [x19, x20, lsl #3]      // store to array[i]: address = x19 + i × 8
    add     x20, x20, #1
    cmp     x20, #10
    b.lo    1b
    mov     x20, #0
2:
    ldr     x2, [x19, x20, lsl #3]
    mov     x1, x20
    adr     x0, item
    bl      printf
    add     x20, x20, #1
    cmp     x20, #10
    b.lo    2b
    mov     x0, x19
    bl      free                        // give the memory back; the heap block disappears
    mov     w0, #0
    ldp     x19, x20, [sp, #16]
    ldp     x29, x30, [sp], #32
    ret

.section .rodata
item:   .asciz  "%ld squared is %ld\n"
