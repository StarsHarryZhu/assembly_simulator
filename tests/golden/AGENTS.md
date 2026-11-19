# AGENTS.md

## 1. Role

The golden comparison data. `programs` holds MIPS programs written to exercise one area each
(arithmetic, branches, directives, forms, immediates, memory, floating point, syscalls, exceptions,
and one program per runtime error); `expected` holds what MARS 4.5 produced for each of them and for
each IDE example: assembler errors, machine code, data, console output and final registers.

## 2. Constraints

- `expected` is generated only by `npm run golden`; never edit a fixture by hand.
- Every program in `programs` and every example has exactly one fixture.

## 3. Contents

- `programs` — the test programs and their stdin files.
- `expected` — one JSON fixture per program, produced by MARS.

## 4. Progress

Done: 22 test programs and 7 examples, all matching. Not done: nothing outstanding.
