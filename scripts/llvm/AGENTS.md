# AGENTS.md

## 1. Role

Inputs for `scripts/llvm-golden.mjs`, the AArch64 encoding oracle: the cases it sends to clang and
objdump, drawn from our own instruction table, plus handwritten assembly lines and whole programs.

## 2. Constraints

- Cases are deterministic (seeded), so regenerated fixtures change only when the table changes.
- Programs avoid references between sections, so the bytes of clang's object file need no relocation.

## 3. Contents

- `cases.ts` — random words per encoding and per instruction class, and every SYS word of DC/IC/AT/TLBI.
- `asm` — handwritten lines for the assembler direction (aliases, immediates, refusals).
- `programs` — whole programs compared section by section (literal pools, data, macros).

## 4. Progress

Done: the base A64 classes. Not done: SIMD&FP, SVE and SME cases (later phases).
