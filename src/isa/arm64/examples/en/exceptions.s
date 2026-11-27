// Exceptions: an EL1 vector table catches faults and resumes
// With a .ktext section a fault does not stop the program: the processor enters kernel mode (EL1) and jumps into the vector table.
// The handler reads the cause from ESR_EL1, adds 4 to ELR_EL1 (the faulting instruction) and returns to the next one with eret.

.text
.global main
main:
    stp     x29, x30, [sp, #-16]!
    mov     x29, sp
    adr     x0, value
    add     x0, x0, #1                  // make the address misaligned on purpose
    ldxr    x1, [x0]                    // exclusive loads must be aligned: a fault, EC = 0x24
    brk     #7                          // a breakpoint, EC = 0x3c
    adr     x0, back
    bl      puts
    mov     w0, #0
    ldp     x29, x30, [sp], #16
    ret

.data
        .balign 16
value:  .quad   0x1122334455667788, 0
back:   .asciz  "Back in main after two exceptions."

.section .ktext, "ax"
    .balign 2048                        // the vector table is 2 KB aligned
vectors:
    .skip   0x400                       // the first 0x400 bytes serve faults at EL1, unused here
el0_sync:                               // VBAR_EL1 + 0x400: synchronous exceptions from EL0
    stp     x29, x30, [sp, #-48]!       // sp here is the kernel stack, SP_EL1
    stp     x0, x1, [sp, #16]
    stp     x2, x3, [sp, #32]
    mrs     x1, esr_el1
    ubfx    x1, x1, #26, #6             // exception class EC = ESR bits 31..26
    mrs     x2, elr_el1                 // address of the faulting instruction
    adr     x0, report
    ldr     x9, =printf                 // the C library is too far for bl (±128 MB)
    blr     x9                          // so call through a register
    mrs     x2, elr_el1
    add     x2, x2, #4                  // skip the faulting instruction
    msr     elr_el1, x2
    ldp     x2, x3, [sp, #32]
    ldp     x0, x1, [sp, #16]
    ldp     x29, x30, [sp], #48
    eret                                // back to EL0, continuing at ELR_EL1

.section .kdata, "aw"
report: .asciz  "  exception: EC = 0x%lx at %p\n"
