# Loading a word from the text segment is an address error in MARS (code is not data).
.text
main:
    la $t0, main
    lw $t1, 0($t0)
