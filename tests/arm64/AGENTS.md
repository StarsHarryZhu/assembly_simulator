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
- `llvm-scope.ts` — text normalisation and the out-of-scope instruction list.
- `machine.test.ts` — programs, system calls, C library, faults, EL1 exceptions, undo and colours.
- `examples.test.ts` — the examples: same code in both languages, formatted, expected output.
- `plugin.test.ts` — both languages, calculator, decoder, formatter and references.
- `native.test.ts` — every native case replayed on our machine: registers, flags, buffer and faults.
- `speed.test.ts` — at least 2 million instructions per second.
- `golden` — LLVM and native CPU fixtures.

## 4. Progress

Done: phase 1 coverage, including 3240 native-CPU behaviour cases. Not done: the later phases.
