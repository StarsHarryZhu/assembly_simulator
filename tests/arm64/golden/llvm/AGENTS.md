# AGENTS.md

## 1. Role

Fixtures from `npm run llvm-golden`: per catalog group and per instruction class, LLVM's disassembly of
random words; for handwritten lines, the words clang assembles; for whole programs, clang's section bytes.

## 2. Constraints

- Generated files only; regenerate after changing the instruction table or the case lists.
- `<group>.json` and `class-*.json` and `sysops.json`: `{ cases: [[word, addr, text | null, canon?]] }`;
  `asm-*.json`: `{ lines: [[line, word | null]] }`; `prog-*.json`: `{ sections: { name: hex } }`.

## 3. Contents

- `arith.json` — add, subtract and friends.
- `atomic.json` — exclusives, acquire/release and LSE atomics.
- `bits.json` — bitfield, shift and bit-count instructions.
- `branch.json` — branches.
- `cond.json` — conditional select and compare.
- `load.json` — loads and stores.
- `logic.json` — logical operations.
- `mops.json` — memory copy and set.
- `move.json` — wide moves.
- `system.json` — system instructions.
- `fp.json` — scalar floating point.
- `simd.json` — Neon integer instructions.
- `simdfp.json` — Neon floating point.
- `vload.json` — loads and stores of SIMD&FP registers and structures.
- `crypto.json` — the cryptographic extensions.
- `sve.json` — SVE integer arithmetic, logic, shifts, counts and immediates.
- `sve2.json` — SVE2 and SVE2.1 integer, and SVE2's floating-point additions.
- `sveperm.json` — SVE permutes.
- `svepred.json` — predicates, compares, WHILE, the FFR and predicate-as-counter.
- `svefp.json` — SVE floating point and BFloat16.
- `sveload.json` — SVE loads, stores, gathers, scatters and prefetches.
- `class-dp-imm.json` — random words across data processing (immediate).
- `class-dp-reg.json` — random words across data processing (register).
- `class-branch-sys.json` — random words across branches and system instructions.
- `class-ldst.json` — random words across integer loads and stores.
- `class-ldst-v.json` — random words across SIMD&FP loads and stores.
- `class-simd-fp.json` — random words across scalar FP, Advanced SIMD and crypto.
- `class-sve.json` — random words across the SVE space.
- `sysops.json` — every SYS word in the DC, IC, AT and TLBI spaces.
- `asm-base.json` — clang's words for `scripts/llvm/asm/base.s`.
- `prog-data.json` — section bytes of `scripts/llvm/programs/data.s`.
- `prog-macro.json` — section bytes of `scripts/llvm/programs/macro.s`.
- `prog-pool.json` — section bytes of `scripts/llvm/programs/pool.s`.

## 4. Progress

Done: fixtures for the A64 base and for floating point, Neon and crypto (22566 encodings plus 6000
class-wide random words); SVE, SVE2 and SVE2.1 (26741 encodings plus 3000 class-wide words). Not
done: SME.
