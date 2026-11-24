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
- SVE semantics take the vector length from `Cpu.vl` and never assume 128 bits; Z and P registers go
  through `zvec.ts`. BFloat16 forms keep their halfword elements apart from the format index (`storage`
  in `sve-fp.ts`).

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
- `zvec.ts` — SVE helpers: Z elements at the current vector length, predicates, merging and zeroing, flags.
- `sve-int.ts` — SVE integer arithmetic, logic, shifts, reductions, multiply-add, INDEX, ADDVL/RDVL, element counts, immediates, ADR.
- `sve-perm.ts` — SVE permutes: EXT, DUP, TBL/TBX, unpacks, REV, ZIP/UZP/TRN, CPY, COMPACT, LAST/CLAST, SPLICE, SEL, the 128-bit segment forms.
- `sve-pred.ts` — predicates: compares, logic, BRK*, PTEST, PTRUE, WHILE*, CTERM, CNTP and increments, the FFR, predicate-as-counter (PEXT, PSEL, PMOV).
- `sve-fp.ts` — SVE floating point and the B16B16 BFloat16 forms, FTMAD/FEXPA helpers, FP SVE2 and SVE2.1.
- `sve-ldst.ts` — SVE loads and stores: contiguous, replicating, structures, first-fault and non-fault, gathers, scatters, prefetches.
- `sve2.ts` — SVE2 and SVE2.1 integer: widening and narrowing, saturating and complex arithmetic, dot and matrix products, bit permutes, histograms, crypto, quadword reductions.
- `index.ts` — loads every table once.

## 4. Progress

Done: the A64 base for phase 1; scalar floating point, all of Neon and the crypto extensions for phase 2;
SVE, SVE2 and SVE2.1 for phase 3 (every form LLVM knows in the plan's scope). Not done: SME (phase 4).
