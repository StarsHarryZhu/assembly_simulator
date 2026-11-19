# AGENTS.md

## 1. Role

Unit tests for the MIPS plugin beyond the golden comparison: the read/written register status used for
the colours, undo of registers and memory, input requests, the calculator's one-line analysis and demo
values, and the English translations (every description translated, no Chinese left in English text,
English examples identical in code to the Chinese ones, localized error messages).

## 2. Constraints

- Prefer a golden program when MARS can produce the expected result; test here only what MARS cannot
  show (status colours, undo, calculator, translations).

## 3. Contents

- `machine.test.ts` — register status, undo, input.
- `calc.test.ts` — one-line analysis, pseudo expansions, line building, demo inputs.
- `i18n.test.ts` — translation coverage and consistency.
- `references.test.ts` — reference tables against the engine: syscall codes, exception codes, CP0
  registers, every directive with an example that assembles, real names, both languages.
- `parity.test.ts` — MARS rules the golden programs cannot pin down: `.eqv` and macro rules, text and
  data address limits, deliberate strictness, file descriptors.
- `regs.ts` — register numbers used by the tests.

## 4. Progress

Done: all pass. Not done: nothing outstanding.
