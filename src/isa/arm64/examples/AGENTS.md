# AGENTS.md

## 1. Role

Example programs for the IDE's example menu when the AArch64 plugin is selected, each showing one thing:
a first loop with printf, raw Linux system calls, printf formats, recursion and stack frames, keyboard
input with scanf, heap memory from malloc, floating point, Neon vectors, an SVE loop that works at any
vector length, a matrix product from SME outer products, and faults caught by an EL1
vector table. These files carry
Chinese comments; `en` holds the same programs with English comments, and the plugin pairs them by name.

## 2. Constraints

- The first line is `// <title>`; the menu shows it.
- The layout is exactly what the Format command produces (`tests/arm64/examples.test.ts` checks it).
- Each line has the same code as the same line of the English copy, so comments can be swapped line by
  line when the language changes. Strings in the programs stay in English for that reason.
- Every example runs to `exit 0` with the output the test expects.
- The menu order is `EXAMPLE_ORDER` in the plugin's `index.ts`.

## 3. Contents

- `welcome.s` — sums 1 to 10 in a loop and prints it with printf; the first program.
- `hello.s` — prints with the write system call from `_start`.
- `hello-printf.s` — puts and the printf formats.
- `factorial.s` — recursive factorial with stack frames and numeric local labels.
- `input.s` — reads two numbers and a name with scanf.
- `heap.s` — an array from malloc, filled and printed, then freed.
- `float.s` — square root of 2 by Newton's method, compared with fsqrt; printf %g and single precision.
- `simd.s` — a floating-point dot product with fmla on 4 lanes, and an integer one with udot.
- `sve.s` — y = a·x + y over 19 elements with a whilelo loop; prints the sum, the vector length and the rounds.
- `sme.s` — a 4 × 3 by 3 × 4 matrix product, one fmopa per k into za0.s, stored by slices and printed; the
  same at every streaming vector length.
- `exceptions.s` — an alignment fault and a breakpoint handled at EL1 and resumed.
- `en` — the same programs with English comments.

## 4. Progress

Done: eleven examples in both languages, including float and SIMD (phase 2), SVE (phase 3) and SME
(phase 4). Not done: nothing planned.
