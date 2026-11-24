# AGENTS.md

## 1. Role

The AArch64 (ARMv9-A) plugin. It assembles GNU as syntax, simulates the machine as a Linux process at
EL0 (with an EL1 vector table when the program has `.ktext`), answers Linux system calls, provides a
built-in C library, and decodes words for the disassembler and the instruction set tab. It is being built
in phases (base integer, floating point and Neon, SVE, SME) and is selectable only in the development
build until all of them are done.

## 2. Constraints

- Encodings and aliases are our own tables (`encoding`, `instructions`), checked against LLVM by
  `npm run llvm-golden`; never copy tables or code from LLVM, QEMU or the Arm specification.
- Internal addresses are numbers below 2^49: the low half as is, the top half (kernel) folded at 2^48.
  Convert with `vaOf`/`addrOf` from `src/core/format.ts`; registers hold bigints.
- Sections are laid out after assembling: `.text` at 0x400000, then `.rodata`, `.data`, `.bss`, each
  4 KB aligned; `.ktext` at 0xffff800000000000 with `.kdata` after it. The program records where they
  went in `Program.sections`, which the machine uses for permissions.
- Every state change a step makes goes through the logged `Cpu` and `Host` methods, so undo is exact.
  Kernel and C library state is one immutable `OsState` object.
- Every user-visible string has Chinese and English (`L`, `T`).
- `index.ts` must stay out of the production bundle until the plugin ships: the registry imports it
  dynamically in the development build only.

## 3. Contents

- `index.ts` — the plugin object: catalog, groups, label operands, examples, layout, language.
- `lexer.ts` — tokens and statement splitting (comments, `;`, block comments).
- `expr.ts` — GNU as expressions with its operator precedence.
- `registers.ts` — register ids, banks, system registers and their encodings, register names.
- `assembler.ts` — the program assembler: directives, macros, conditions, literal pools, layout.
- `cpu.ts` — the machine: registers, memory permissions, steps, undo, exceptions, C library calls.
- `softfloat.ts` — IEEE 754 arithmetic in half, single, double and BFloat16 with every FPCR control and FPSR flag.
- `linux.ts` — the memory map, kernel state and the Linux system calls.
- `libc.ts` — the built-in C library (printf, scanf, malloc, string functions, glibc's rand).
- `fpformat.ts` — exact decimal and hex text of floats for printf, and correctly rounded reading for scanf.
- `decoder.ts` — a word as named bit fields, text and notes.
- `calc.ts` — one line on its own for the instruction set tab, with demo inputs.
- `format.ts` — the editor's Format command in the examples' layout.
- `references.ts` — system calls, C library, condition codes, system registers, exceptions, directives.
- `encoding` — bit patterns, operand syntax and the instruction table.
- `instructions` — the instruction definitions by class, with their semantics.
- `examples` — example programs (Chinese comments; `en` has the English copies).

## 4. Progress

Done: phase 0 (core and panels) and phase 1: the A64 base (integer, CSSC, FlagM, CRC32, MOPS, all
loads and stores, LSE, LRCPC, exclusives, branches, system instructions, PAuth and BTI as allowed
simplifications), the assembler matching clang byte for byte on whole programs, the machine with Linux
system calls, the C library, EL1 exceptions and undo, about 3.4 million instructions per second, seven
examples in both languages, and 3240 single-instruction cases matching this Mac's CPU (`npm run
native-golden`; LDXP with one register twice is undefined there, and here). Phase 2: scalar floating
point in half, single, double and BFloat16 with every FPCR mode (FZ, FZ16, DN, AH, FIZ, NEP, AHP) and FPSR
flag, all of Neon with DotProd, I8MM, FHM, FCMA, RDM, BF16 and FP16, the AES, SHA-1/2/3/512, SM3 and SM4
instructions, printf `%f %e %g %a` and scanf of floats done exactly as glibc does, and the float and simd
examples; 22566 more encodings match LLVM and 8107 more cases match this Mac's CPU (SM3 and SM4, which it
lacks, are checked against their standards' test vectors).

Not done: phases 3–5 (SVE, SME, polish and release).
