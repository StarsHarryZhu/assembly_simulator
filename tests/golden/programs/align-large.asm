# .align beyond 3: MARS aligns to any non-negative power of two (4 = 16 bytes, 6 = 64 bytes).
# golden: norun
.data
.byte 1
.align 4
.word 0x11223344
.align 6
.word 0x55667788
