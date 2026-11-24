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
- `fp.ts` — scalar floating point: arithmetic, compares, moves, precision and integer conversions, FRINT*.
- `vec.ts` — lane helpers for Advanced SIMD: elements, saturation, register shifts, narrowing.
- `simd-int.ts` — Neon integer: three same, three different, two-register misc, across lanes.
- `simd-more.ts` — Neon shifts by immediate, copies, modified immediates, permutes, TBL, by element, dot products.
- `simd-fp.ts` — Neon floating point, FP16, FHM, FCMA and BF16.
- `simd-ldst.ts` — loads and stores of SIMD&FP registers and the LD1–LD4/ST1–ST4 structures.
- `crypto.ts` — AES, SHA-1, SHA-256, SHA-512, SHA-3, SM3 and SM4.
- `index.ts` — loads every table once.

## 4. Progress

Done: the A64 base for phase 1; scalar floating point, all of Neon and the crypto extensions for phase 2.
Not done: SVE (phase 3), SME (phase 4).
