# golden: norun
# Instructions must be word-aligned inside the 4 MB text segments: the third nop would sit at
# 0x00800000, and .text 0x00400002 is not aligned.
.text 0x007ffff8
    nop
    nop
    nop
.text 0x00400002
    nop
