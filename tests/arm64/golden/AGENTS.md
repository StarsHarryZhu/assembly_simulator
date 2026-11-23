# AGENTS.md

## 1. Role

Committed oracle output for the AArch64 tests, so `npm test` runs without clang or a native harness.

## 2. Constraints

- Regenerated only by scripts (`npm run llvm-golden`, `npm run native-golden`); never edited by hand.

## 3. Contents

- `llvm` — what clang and objdump say about our encodings, lines and programs.
- `native` — what this Mac's CPU did with each behaviour case.

## 4. Progress

Done: LLVM and native fixtures for the A64 base. Not done: later phases.
