# Runtime error: overflow
.text
main:
  li $t0,0x7fffffff
  addi $t0,$t0,1
