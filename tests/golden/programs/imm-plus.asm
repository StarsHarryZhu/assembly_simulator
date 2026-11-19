# Unary plus on immediate operands, and decimal literals above 0x7fffffff.
# golden: norun
.text
addi $t0,$zero,+5
li $t1,+7
lw $t2,+4($sp)
addi $t3,$zero,2147483648
li $t4,4294967295
