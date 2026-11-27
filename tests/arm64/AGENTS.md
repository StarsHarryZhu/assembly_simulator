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
- `plugin.test.ts` — both languages (every encoding's description, and a decoded word of each with its
  notes and operand hints in English), calculator, decoder, formatter and references (the SME table's
  examples assemble).
- `native.test.ts` — every native case replayed on our machine: registers, vector registers (Z and P for
  SVE, at the recorded vector length; ZA and ZT0 too for SME), flags, FPSR, buffer and faults.
- `streaming.test.ts` — which encodings each SVCR state forbids, against the M5's probe.
- `sve.test.ts` — the SVE instructions streaming mode forbids: first-fault loads and the FFR, gathers,
  scatters, FADDA, FTMAD, FEXPA, COMPACT, ADR, quadword permutes, SVE2 crypto, bit permutes, histograms
  and matrix multiplies (against Neon per 128-bit segment where it has them).
- `softfloat.test.ts` — the soft-float core against the host's double and single arithmetic, and the
  native fast path against the soft path under every FPCR mode (double-rounding ties included).
- `crypto.test.ts` — SM3 and SM4 (absent on this CPU) against their standards' test vectors.
- `fp-edge.test.ts` — floating-point edge values (zeros, infinities, NaN payloads, subnormals, ties, conversion
  limits) under every FPCR mode, with the results the CPU gave.
- `libc.test.ts` — the C library and Linux system calls against the host C library and Linux semantics.
- `constrained.test.ts` — what the deep checks found beyond the fixtures: the CPU's choices for UNPREDICTABLE
  pair and writeback loads and stores, ignored should-be-zero bits, WHILEWR/WHILERW, SVE FABS/FNEG with AH,
  WFET/WFIT and `bti r`.
- `block.test.ts` — whole-block LDn/STn and SVE contiguous accesses that run into unmapped memory fault at
  the same element as element-by-element ones (stores before it done), and WHILE counts at the range ends.
- `outer.test.ts` — SME integer outer products against sums computed from the registers, and single-precision
  FMOPA/FMOPS against the exact soft-float path under every FPCR mode.
- `speed.test.ts` — at least 2 million instructions per second (retried for up to 20 s under load).
- `undo.test.ts` — random programs stepped forward and undone: every register bank, memory, output and status
  restored exactly; running equals stepping.
- `golden` — LLVM and native CPU fixtures.

## 4. Progress

Done: phase 1 to 5 coverage, including 18957 native-CPU behaviour cases (3240 for the base, 8110 for
floating point, Neon and crypto, 5555 for SVE and 2052 for SME in streaming mode) and the four-state
probe of 5768 words. Phase 5 deep check: surveys at other seeds replay through `NATIVE_DIR` and
`LLVM_DIR` without changing the fixtures, and what they found is kept in `constrained.test.ts`,
`fp-edge.test.ts`, `libc.test.ts` and `undo.test.ts`. Phase 5 speed work: `block.test.ts` and `outer.test.ts`; the undo test
reads the machine's per-page written-word counts and watches doubleword stores too. Not done: nothing
planned.
