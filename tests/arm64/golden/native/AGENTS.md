# AGENTS.md

## 1. Role

Fixtures from `npm run native-golden`: what this Mac's CPU did with each behaviour case, replayed on our
machine by `tests/arm64/native.test.ts`.

## 2. Constraints

- Generated files only; regenerate after changing the instruction table or `scripts/native`.
- `<group>.json`: `{ cases: [[text, word, seed, ptr, small, signal, nzcv, regs, memory]] }`. `signal` is
  `sigill`, `sigbus`, `sigsegv`, `sigtrap` or null; `regs` maps changed registers to hex or `p<offset>`;
  `memory` lists changed buffer bytes as `[offset, byte]`.

## 3. Contents

- `arith.json` — add, subtract, multiply, divide and friends.
- `atomic.json` — exclusives, acquire/release and LSE atomics.
- `bits.json` — bitfield, shift and bit-count instructions.
- `cond.json` — conditional select and compare.
- `load.json` — loads and stores in every addressing mode.
- `logic.json` — logical operations.
- `move.json` — wide moves.

## 4. Progress

Done: 3240 cases for the A64 base, all matching. Not done: later phases.
