# AGENTS.md

## 1. Role

The basic (machine-level) MIPS instructions: one `def()` per instruction with its name, format,
operand list, fixed field values, group, description and semantics. Every other part of the plugin
derives from this table: encodings, decoding by mask (more fixed bits win, so `nop` beats `sll`),
assembler forms, editor completion, the calculator's catalog and the CPU's execute functions.

## 2. Constraints

- Semantics go through the `Cpu` interface only, so register reads and writes are tracked for the
  colour coding and the undo log.
- A description is written in Chinese in the table; its English lives in `en.ts` under the same Chinese
  key, and `tests/mips/i18n.test.ts` fails when one is missing.
- `{op}` placeholders in descriptions name the instruction's operands.

## 3. Contents

- `types.ts` — operand kinds, the `Cpu` interface, `InstrDef` and the `def()` builder.
- `alu.ts` — arithmetic, logic, shifts, HI/LO, conditional moves, SPECIAL2 (`mul`, `madd`, `clz`, …).
- `memory.ts` — loads and stores, including `ll`/`sc` and the unaligned `lwl`/`lwr`/`swl`/`swr`.
- `branch.ts` — branches and jumps, including the REGIMM group.
- `system.ts` — `syscall`, `break`, traps, `mfc0`/`mtc0`, `eret`.
- `cop1.ts` — single and double precision floating point (coprocessor 1).
- `en.ts` — English descriptions keyed by the Chinese text.
- `index.ts` — the combined table `BASIC` and a lookup by name.

## 4. Progress

Done: all 155 MARS 4.5 basic instructions with golden-tested encodings and semantics, in both languages.
Not done: nothing outstanding.
