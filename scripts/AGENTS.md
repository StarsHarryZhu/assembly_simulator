# AGENTS.md

## 1. Role

Developer tools that run on a developer's machine, never in the site. The main one regenerates the
golden fixtures in `tests/golden/expected` by running MARS 4.5 on every test program and every example,
so the tests can compare our engine with MARS without needing Java or the jar. `mars` holds a small
Java helper that lists the instruction forms MARS knows, used when checking our form table by hand.

## 2. Constraints

- MARS is a test oracle only: these tools may call the jar, but nothing they read from it is copied
  into `src`. The jar stays outside the repository (`MARS_JAR`, default
  `~/.cache/assembly-simulator/Mars4_5.jar`).
- Output must be deterministic so regenerated fixtures only change when behaviour changes.
- LLVM and the native CPU are test oracles in the same way: only their answers about our own encodings
  and cases are recorded.

## 3. Contents

- `mars-golden.mjs` — runs MARS on `tests/golden/programs/*.asm` and the IDE examples and writes one
  JSON fixture per program (`npm run golden`, optionally with program names; `GOLDEN_DIR=<dir>` reads and
  writes another folder, for deeper random checks replayed with the same variable).
- `mars` — a Java helper that prints MARS's instruction forms.
- `llvm-golden.mjs` — the AArch64 encoding oracle: clang and objdump on cases from our own table
  (`npm run llvm-golden`), written to `tests/arm64/golden/llvm`; `SEED`, `PER`, `COUNT` and `OUT` make a
  deeper survey elsewhere, replayed with `LLVM_DIR`.
- `llvm` — the cases, handwritten lines and whole programs `llvm-golden.mjs` uses.
- `native-golden.mjs` — the AArch64 behaviour oracle: runs cases on this Mac's CPU (`npm run native-golden`,
  `ONLY=<groups>` for some, `PER=<n>` for more cases per encoding, `SEED` and `OUT` for a deeper run elsewhere,
  replayed with `NATIVE_DIR`), the SVE groups in streaming
  mode, the SME groups with ZA too, and the four-state SVCR probe, written to `tests/arm64/golden/native`.
- `native` — the cases, starting states and C harnesses `native-golden.mjs` uses.

## 4. Progress

Done: fixtures for 39 test programs and 7 examples; errors inside macro expansions ("line 6->2")
are read at the calling line. AArch64: encoding fixtures from LLVM and behaviour fixtures from the CPU
for the A64 base, floating point, Neon and crypto, for SVE, SVE2 and SVE2.1 (phase 3), and for SME, SME2
and SME2.1 with the streaming-mode probe (phase 4). Not done: nothing planned.
