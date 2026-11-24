// Assembler-side syntax for the base instruction set: aliases, immediate forms clang picks for us,
// optional '#', case, and lines clang refuses (which we must refuse too). One instruction per line, no
// PC-relative operands (clang reads a number there as an offset, we read it as an address).
add x0, x1, #4096
add x0, x1, #0x123000
add x0, x1, #4097
add x0, x1, #-1
sub x0, x1, #-4096
adds w0, w1, #-5
cmp x0, #-1
cmn w3, #-7
cmp sp, #16
add sp, sp, #16
add x0, sp, x1
add sp, x1, x2
add x0, x1, w2, uxtw #2
add x0, x1, x2, uxtx
add x0, x1, w2
sub sp, sp, x0, lsl #4
mov x0, sp
mov sp, x0
mov x0, x1
mov w0, wzr
mov x0, #0
mov x0, #65535
mov x0, #0x10000
mov x0, #0xffff00000000
mov x0, #-1
mov w0, #-1
mov w0, #0xffffffff
mov x0, #0xffffffff
mov x0, #-65536
mov x0, #0x5555555555555555
mov w0, #0x55555555
mov x0, #0x12345
mov x0, #0x123456789
movz x0, #1, lsl #16
movk x0, #0xbeef, lsl #48
movn w0, #0, lsl #32
and x0, x1, #0xff
and w0, w1, #0xff00ff00
and x0, x1, #0
orr x0, x1, #-2
eor w0, w1, #1
tst x0, #8
tst w0, #0x80000000
lsl x0, x1, #3
lsl w0, w1, #31
lsl w0, w1, #32
lsr x0, x1, #63
asr w0, w1, #4
ror x0, x1, #7
ubfx x0, x1, #4, #8
ubfx x0, x1, #60, #8
sbfx w0, w1, #0, #32
bfi x0, x1, #8, #4
bfxil w0, w1, #3, #5
ubfiz x0, x1, #32, #16
sbfiz w0, w1, #4, #28
bfc x0, #5, #10
sxtb x0, w1
sxth w0, w1
sxtw x0, w1
uxtb w0, w1
uxth w0, w1
uxtw x0, w1
extr x0, x1, x2, #12
neg x0, x1
neg w0, w1, lsl #3
negs x0, x1
ngc w0, w1
mvn x0, x1
mvn w0, w1, ror #4
mul x0, x1, x2
mneg w0, w1, w2
smull x0, w1, w2
umull x0, w1, w2
smulh x0, x1, x2
udiv w0, w1, w2
lsl x0, x1, x2
ror w0, w1, w2
cset w0, eq
cset x0, lt
csetm x0, ne
cinc x0, x1, hi
cinv w0, w1, lo
cneg x0, x1, mi
cset w0, al
csel x0, x1, x2, ge
ccmp x0, #5, #4, ne
ccmn w0, w1, #0, cs
csel x0, x1, x2, first
cset w0, none
csinc x0, x1, x2, tcont
ccmp x0, #5, #4, pmore
rev x0, x1
rev64 x0, x1
rev32 x0, x1
rev w0, w1
clz x0, x1
cls w0, w1
rbit x0, x1
abs x0, x1
cnt w0, w1
ctz x0, x1
smax x0, x1, #-128
umin w0, w1, #255
smax x0, x1, #128
crc32b w0, w1, w2
crc32cx w0, w1, x2
crc32x w0, w1, w2
ldr x0, [x1]
ldr x0, [x1, #8]
ldr x0, [x1, #-8]
ldr x0, [x1, #3]
ldr w0, [x1, #16380]
ldr x0, [x1, #32768]
ldr x0, [x1, #-257]
ldrb w0, [x1, #4095]
ldrsb x0, [x1, #-1]
ldrh w0, [x1, x2, lsl #1]
ldr x0, [x1, x2, lsl #3]
ldr x0, [x1, x2, lsl #2]
ldr x0, [x1, w2, sxtw]
ldr x0, [x1, w2, uxtw #3]
ldrb w0, [x1, x2, lsl #0]
ldrb w0, [x1, x2]
ldr x0, [sp, #-16]!
ldr x0, [x1], #8
str x0, [sp, #-16]!
str w0, [x1, #-4]
strb w0, [x1]
stur x0, [x1, #-8]
ldur x0, [x1, #8]
ldtr x0, [x1, #8]
ldrsw x0, [x1, #4]
prfm pldl1keep, [x0]
prfm pstl2strm, [x0, #8]
prfm #5, [x0]
prfm pldl1keep, [x0, #-8]
stp x29, x30, [sp, #-16]!
ldp x29, x30, [sp], #16
stp x0, x1, [sp, #8]
stp x0, x1, [sp, #12]
ldp w0, w1, [x2, #252]
ldp w0, w1, [x2, #256]
ldpsw x0, x1, [x2]
ldnp x0, x1, [x2, #16]
ldp x0, x0, [x1]
ldxr x0, [x1]
ldxr x0, [x1, #0]
stxr w2, x0, [x1]
stxr w0, x0, [x1]
stlxp w2, x0, x1, [x3]
ldaxp x0, x1, [x2]
ldar w0, [x1]
stlr x0, [sp]
ldapr x0, [x1]
ldapur x0, [x1, #-8]
stlurb w0, [x1, #5]
cas x0, x1, [x2]
casal w0, w1, [sp]
casp x0, x1, x2, x3, [x4]
casp x1, x2, x3, x4, [x5]
ldadd x0, x1, [x2]
ldaddal w0, w1, [x2]
ldsmaxlb w0, w1, [x2]
stadd x0, [x1]
staddl w0, [x1]
stclrlb w0, [sp]
swpal x0, x1, [x2]
ldraa x0, [x1]
ldraa x0, [x1, #-4096]
ldrab x0, [x1, #4088]!
ldraa x0, [x1, #4]
cpyfp [x0]!, [x1]!, x2!
cpye [x0]!, [x1]!, x2!
setp [x0]!, x1!, x2
setptn [x0]!, x1!, xzr
cpyp [x0]!, [x0]!, x2!
svc #0
svc 0
brk #0xf000
hlt #1
nop
NOP
yield
wfi
hint #6
hint #33
bti c
bti
paciasp
autiasp
pacia x0, sp
autdza x3
xpaci x1
pacga x0, x1, sp
br x0
blr x1
ret
ret x2
retaa
braa x0, sp
blraaz x3
eret
dmb ish
dsb sy
dsb #12
dsb ishnxs
isb
isb sy
sb
clrex
clrex #3
mrs x0, tpidr_el0
mrs x0, TPIDR_EL0
msr tpidr_el0, x1
mrs x0, nzcv
msr nzcv, x0
mrs x0, s3_0_c4_c2_2
mrs x0, currentel
msr daifset, #2
msr spsel, #1
msr pan, #1
msr daifclr, #16
cfinv
axflag
xaflag
rmif x0, #3, #2
setf8 w0
setf16 w1
dc zva, x0
dc civac, x1
ic iallu
ic ivau, x2
tlbi vmalle1
tlbi vae1, x0
at s1e1r, x0
sys #3, c7, c4, #1, x0
sysl x0, #3, c7, c4, #1
ldr x0, [x0, #8]!
ldr x0, [x0], #8
str x0, [x0, #8]!
str x1, [x0], #8
ldr x0, [sp, #8]!
ldp x0, x1, [x0], #16
ldp x1, x2, [x0, #16]!
stp x0, x1, [x0, #-16]!
stp x0, x1, [sp, #-16]!
ldraa x0, [x0, #8]!
stxp w0, x0, x1, [x2]
stxp w1, x0, x2, [x3]
stxr w1, x0, [x1]
stxr w1, x0, [sp]
ldxp x0, x0, [x1]
ldp w2, w2, [x1]
ldp x1, x1, [x2], #16
ldp x1, x1, [x2, #16]!
ldpsw x1, x1, [x2], #8
ldnp x1, x1, [x2]
ldp x2, x1, [x2], #16
ldpsw x2, x1, [x2], #8
stp x2, x1, [x2], #16
stp x2, x2, [x2]
ldrsw x2, [x2], #4
strb w2, [x2, #1]!
ldr x2, [x2, x3]
stlxr w1, w1, [x2]
stxp w3, x1, x2, [x3]
