# golden: norun
# MARS substitutes .eqv names in the text before reading the line, so errors point into the replacement
# (each of its parts at its own column) and everything after it moves by the change in length.
.eqv N 4($t0)
.data
    .word N
    .word N, (
