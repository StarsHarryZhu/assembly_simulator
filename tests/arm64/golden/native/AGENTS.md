# AGENTS.md

## 1. Role

Fixtures from `npm run native-golden`: what this Mac's CPU did with each behaviour case, replayed on our
machine by `tests/arm64/native.test.ts`.

## 2. Constraints

- Generated files only; regenerate after changing the instruction table or `scripts/native`.
- `<group>.json`: `{ cases: [[text, word, seed, ptr, small, signal, nzcv, regs, memory, fpcr, vregs, fpsr]] }`. `signal` is
  `sigill`, `sigbus`, `sigsegv`, `sigtrap` or null; `regs` maps changed registers to hex or `p<offset>`;
  `memory` lists changed buffer bytes as `[offset, byte]`; `fpcr` is the mode the case ran under, `vregs`
  maps changed V registers to 128-bit hex and `fpsr` holds the flags it raised.
- SVE groups: `{ vl, buf, cases: [[text, word, seed, ptr, small, signal, nzcv, regs, memory, fpcr, zregs,
  pregs, fpsr]] }`: run in streaming mode at `vl` bytes with a `buf`-byte buffer; `zregs` and `pregs` map
  changed Z and P registers to hex.

## 3. Contents

- `arith.json` — add, subtract, multiply, divide and friends.
- `atomic.json` — exclusives, acquire/release and LSE atomics.
- `bits.json` — bitfield, shift and bit-count instructions.
- `cond.json` — conditional select and compare.
- `load.json` — loads and stores in every addressing mode.
- `logic.json` — logical operations.
- `move.json` — wide moves.
- `fp.json` — scalar floating point under random FPCR modes.
- `simd.json` — Neon integer instructions.
- `simdfp.json` — Neon floating point under random FPCR modes.
- `vload.json` — loads and stores of SIMD&FP registers and structures.
- `crypto.json` — AES, SHA-1, SHA-256, SHA-512 and SHA-3.
- `sve.json` — SVE integer instructions, in streaming mode.
- `sve2.json` — SVE2 and SVE2.1, in streaming mode.
- `sveperm.json` — SVE permutes, in streaming mode.
- `svepred.json` — predicates, compares and WHILE, in streaming mode.
- `svefp.json` — SVE floating point and BFloat16 under random FPCR modes, in streaming mode.
- `sveload.json` — SVE contiguous and structure loads and stores, in streaming mode.

## 4. Progress

Done: 3240 cases for the A64 base and 8107 for floating point, Neon and crypto, and 5555 for SVE, SVE2
and SVE2.1 at 512 bits, all matching. Not done: SME.
