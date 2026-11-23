# AGENTS.md

## 1. Role

The AArch64 instructions themselves, one file per encoding class: each entry has its bit pattern,
operand template, description in both languages and its semantics against the `Cpu` interface.

## 2. Constraints

- Semantics use only `Cpu` (`types.ts`); they never touch machine internals, so undo and register
  colours stay right.
- `valid` rejects field values that make an encoding reserved or another instruction's; `check` refuses,
  when assembling, the register choices clang refuses.
- Descriptions are written in our own words; nothing is copied from the Arm specification.

## 3. Contents

- `types.ts` — the `Cpu` interface and access kinds.
- `util.ts` — shared arithmetic: add with carry, shifts, extends, bit masks, CRC32.
- `dp-imm.ts` — data processing with immediates and their aliases (MOV, CMP, LSL, UBFX, …).
- `dp-reg.ts` — data processing with registers, conditional select, multiply and divide, PAuth.
- `branch.ts` — branches, exception generation, hints, barriers, PSTATE, SYS and system registers.
- `ldst.ts` — loads and stores in every addressing mode, pairs, literals, LDRAA, MOPS.
- `atomic.ts` — exclusives, acquire/release, LRCPC, CAS/CASP and the LSE atomics.
- `index.ts` — loads every table once.

## 4. Progress

Done: the A64 base for phase 1. Not done: floating point, Neon and crypto (phase 2), SVE (phase 3), SME
(phase 4).
