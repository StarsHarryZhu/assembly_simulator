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
- SME semantics reach ZA and ZT0 only through `zavec.ts` and `Cpu` (`zaLanes`, `zaSetLanes`, `zaRead`,
  `zaWrite`, `zt0Read`, `zt0Write`), with the streaming vector length `Cpu.svl`. Floating-point results that go to ZA use
  `zaEnv` (default NaN, no FPSR flags). Multi-vector instructions read every source before writing any
  result, since destinations may overlap sources (as the M5 does).
- Speed: lanes go through `Cpu.vlanes`/`vsetLanes` (via `readV`, `writeV`, `zget`, `zset`) and predicates
  through `pflags`/`psetFlags` (via `pget`, `pset`), not byte copies. Values that depend only on an
  encoding's fields belong in its `prepare` hook (passed to `exec` as the third argument), not in `exec`.
  A block access (`loadBlock`/`storeBlock`) must fall back to the element path when it returns null or
  false, so faults stay per element. Arithmetic may leave bigints for numbers only where every value stays
  exact below 2^53 (as the integer outer products do), and a native floating-point path must fall back to
  the soft one wherever it cannot prove the same result.
- Each encoding's `needs` says which SVCR state it requires; `streaming.ts` marks the FP, Neon and SVE
  encodings, the SME files mark their own; `tests/arm64/streaming.test.ts` checks them against the M5.

## 3. Contents

- `types.ts` — the `Cpu` interface (including lane, predicate and block access methods) and access kinds.
- `util.ts` — shared arithmetic: add with carry and subtract with borrow (flags in `nzcvOut`), shifts, extends, bit masks, CRC32.
- `dp-imm.ts` — data processing with immediates and their aliases (MOV, CMP, LSL, UBFX, …).
- `dp-reg.ts` — data processing with registers, conditional select, multiply and divide, PAuth.
- `branch.ts` — branches, exception generation, hints, barriers, PSTATE, SYS and system registers.
- `ldst.ts` — loads and stores in every addressing mode, pairs, literals, LDRAA, MOPS.
- `atomic.ts` — exclusives, acquire/release, LRCPC, CAS/CASP and the LSE atomics.
- `fp.ts` — scalar floating point: arithmetic, compares, moves, precision and integer conversions, FRINT*.
- `vec.ts` — lane helpers for Advanced SIMD: elements (`lanesAt`, `storeLanes`, `lo32`), saturation, register shifts (and the SVE form, `shiftSve`), narrowing.
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
- `zavec.ts` — SME helpers: ZA rows as elements, tiles and their slices, the array vectors of a vector group, `zaEnv`.
- `sme.ts` — SME: SMSTART/SMSTOP and RDSVL, outer products, ADDHA/ADDVA, MOVA and MOVAZ, slice loads and stores, LDR/STR of ZA and ZT0, ZERO, MOVT, LUTI2/LUTI4.
- `sme2.ts` — SME2 and SME2.1 arithmetic into ZA's array vectors: add, multiply-add, widening multiply-add, dot and vertical dot products.
- `sme2-vec.ts` — SME2 and SME2.1 multi-vector instructions on z registers: max/min, shifts, clamps, ZIP/UZP, conversions, saturating and shifting narrows, unpacks, SEL, multi-vector loads and stores.
- `streaming.ts` — which FP, Neon and SVE encodings Streaming SVE mode forbids (as measured on the M5).
- `index.ts` — loads every table once.

## 4. Progress

Done: the A64 base for phase 1; scalar floating point, all of Neon and the crypto extensions for phase 2;
SVE, SVE2 and SVE2.1 for phase 3; SME, SME2 and SME2.1 with I16I64, F64F64, B16B16 and F16F16 for phase 4
(every form LLVM knows in the plan's scope; FP8, SME2.2 and LUTv2 are out of it). Phase 5 speed work: lane
conversion through scratch cells and the `Cpu` lane methods, `prepare` hooks for logical, move-wide and
bitfield immediates, flag helpers without tuples, whole-block LDn/STn and SVE contiguous accesses with
element fallbacks, closed-form WHILE counts, outer products without per-element flag arrays, integer outer products summed
as numbers, and single-precision FMOPA/FMOPS on the native path.
Not done: nothing planned.
