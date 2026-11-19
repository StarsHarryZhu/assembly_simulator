# Labels in .byte/.half/.word data: MARS keeps only the low 8/16/32 bits of the address.
# golden: norun
.data
.space 3
x: .byte 0
.byte x
.half x
.word x
