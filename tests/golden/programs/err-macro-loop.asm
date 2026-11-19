# golden: norun
# A macro may not expand itself, directly or through another macro.
.macro a
    b_
.end_macro
.macro b_
    a
.end_macro
.text
    a
