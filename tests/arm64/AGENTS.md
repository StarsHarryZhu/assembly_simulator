# AGENTS.md

## 1. Role

Tests for the AArch64 plugin: encodings against LLVM, whole programs against clang, single instructions
against the real CPU, the machine with its
system calls, C library, exceptions and undo, the example programs, the UI-facing pieces (calculator,
decoder, formatter, references, both languages) and throughput.

## 2. Constraints

- No test needs clang or an Apple CPU: LLVM's answers are committed in `golden/llvm` (`npm run llvm-golden`)
  and the CPU's in `golden/native` (`npm run native-golden`).
- Features we leave out on purpose are listed in `llvm-scope.ts`, not skipped silently.

## 3. Contents

- `llvm.test.ts` — disassembly, re-assembly and unallocated space against LLVM; programs against clang.
- `llvm-scope.ts` — text normalisation and the out-of-scope instruction list (newer SVE and SME extensions included).
- `machine.test.ts` — programs, system calls, C library, faults, EL1 exceptions, undo and colours.
- `examples.test.ts` — the examples: same code in both languages, formatted, expected output (the sve
  example at several vector lengths, the sme example at several streaming vector lengths).
- `plugin.test.ts` — both languages, calculator, decoder, formatter and references (the SME table's
  examples assemble).
- `native.test.ts` — every native case replayed on our machine: registers, vector registers (Z and P for
  SVE, at the recorded vector length; ZA and ZT0 too for SME), flags, FPSR, buffer and faults.
- `streaming.test.ts` — which encodings each SVCR state forbids, against the M5's probe.
- `sve.test.ts` — the SVE instructions streaming mode forbids: first-fault loads and the FFR, gathers,
  scatters, FADDA, FTMAD, FEXPA, COMPACT, ADR, quadword permutes, SVE2 crypto, bit permutes, histograms
  and matrix multiplies (against Neon per 128-bit segment where it has them).
- `softfloat.test.ts` — the soft-float core against the host's double and single arithmetic.
- `crypto.test.ts` — SM3 and SM4 (absent on this CPU) against their standards' test vectors.
- `speed.test.ts` — at least 2 million instructions per second.
- `golden` — LLVM and native CPU fixtures.

## 4. Progress

Done: phase 1 to 4 coverage, including 18954 native-CPU behaviour cases (3240 for the base, 8107 for
floating point, Neon and crypto, 5555 for SVE and 2052 for SME in streaming mode) and the four-state
probe of 5768 words. Not done: nothing planned.
