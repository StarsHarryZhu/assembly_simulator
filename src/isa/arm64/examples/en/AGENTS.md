# AGENTS.md

## 1. Role

English copies of the AArch64 example programs in the parent folder: the same code line for line, with
English comments, shown when the interface language is English.

## 2. Constraints

- Every line's code equals the same line of the Chinese file; only `//` comments differ.
- No Chinese characters (`tests/arm64/examples.test.ts`).

## 3. Contents

- `welcome.s` — sums 1 to 10 in a loop and prints it with printf.
- `hello.s` — prints with the write system call from `_start`.
- `hello-printf.s` — puts and the printf formats.
- `factorial.s` — recursive factorial with stack frames.
- `input.s` — reads two numbers and a name with scanf.
- `heap.s` — an array from malloc, filled, printed and freed.
- `float.s` — square root of 2 by Newton's method.
- `simd.s` — dot products with Neon.
- `sve.s` — a loop that works at any SVE vector length.
- `sme.s` — a matrix product from outer products into a ZA tile.
- `exceptions.s` — faults handled at EL1 and resumed.

## 4. Progress

Done: all eleven examples, SVE and SME included. Not done: nothing planned.
