# AGENTS.md

## 1. Role

Handwritten assembly lines, one instruction per line, that clang assembles to fixtures
(`tests/arm64/golden/llvm/asm-<name>.json`): our assembler must give the same word, or refuse where clang
refuses.

## 2. Constraints

- One instruction per line; `//` lines are comments. Lines clang refuses are kept on purpose.

## 3. Contents

- `base.s` — aliases, immediate forms, system operations, MOPS, atomics, UNPREDICTABLE choices, and
  operand spellings (`#` rules, shift and extend amounts, lane indexes, FMOV immediates).

## 4. Progress

Done: 329 lines; the phase 5 deep check added the operand spellings where we differed from clang. Not
done: nothing outstanding.
