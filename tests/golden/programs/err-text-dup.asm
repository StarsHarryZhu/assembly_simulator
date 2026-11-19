# golden: norun
# Two pieces of code cannot share an address.
.text
    nop
    nop
.text 0x00400004
    addi $t0, $t0, 1
