# AGENTS.md

## 1. Role

The AArch64 behaviour oracle's parts, used by `native-golden.mjs`: which cases to run, their starting
states, and the C harness that runs them on this Mac's CPU and prints what each one changed.

## 2. Constraints

- Runs only on an Apple silicon Mac with clang; nothing here is bundled into the site.
- Cases come from our own instruction table; nothing is copied from a real CPU's documentation tables.
- Starting states depend only on a case's seed, so `npm test` rebuilds them without the harness.
- Cases never name sp or x18 (Apple reserves x18) and touch only the buffer (256 bytes; 2048 for SVE, 4096
  for SME);
  registers near the buffer are compared as offsets (`p<offset>`), so the buffer's real address never matters.
- This CPU runs SVE only in streaming mode: the SVE cases enter it around the instruction, at the CPU's
  streaming vector length (recorded in the fixtures), and cases streaming mode forbids (SIGILL) are dropped.
  The SVE harness's C code is built without SVE, or clang would vectorise it with instructions this CPU
  runs only in streaming mode. SME cases run the same way with ZA enabled too (`smstart`), and carry ZA
  and ZT0 in and out; MOVT is left out (this CPU lacks it).
- `state.ts` and `cases.ts` are shared with `tests/arm64/native.test.ts`; keep them free of Node APIs.

## 3. Contents

- `cases.ts` — picks cases per catalog group from random words, drops those our machine sees leave the buffer;
  the SVE and SME groups at a given (streaming) vector length; the words for the streaming-mode probe.
- `state.ts` — the deterministic starting state (registers, NZCV, V, Z and P registers, ZA and ZT0, buffer
  bytes) from a seed.
- `harness.c` — loads each state and FPCR, runs the case, catches faults and prints registers, flags,
  FPSR, V registers and buffer.
- `sve-harness.c` — the same for the SVE and SME cases in streaming mode, with Z and P registers (and ZA
  and ZT0 for SME), inputs read from a file; it pre-touches the case code and retries a case whose FPSR
  comes back reset (a page fault taken in streaming mode returns with FPSR set to smstart's value on macOS).
- `mode-harness.c` — the streaming-mode probe: runs each word in the four SVCR states (neither, SM, ZA,
  both) and prints which raised a signal.

## 4. Progress

Done: integer data processing, conditional select, loads and stores, atomics and exclusives (3240
cases); scalar floating point and Neon under random FPCR modes with IEEE special values, vector loads and
stores, AES and SHA (8110 cases; SM3 and SM4 are absent on this CPU); SVE, SVE2 and SVE2.1 in streaming
mode at 512 bits (5555 cases); SME, SME2 and SME2.1 with ZA (2052 cases; a deeper run with `PER=15`,
10260 cases, also matched); the four-state probe of every FP, Neon, SVE and SME encoding (5768 words).
Not done: nothing planned.
