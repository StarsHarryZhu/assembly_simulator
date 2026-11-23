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
- `linux.ts` — the memory map, kernel state and the Linux system calls.
- `libc.ts` — the built-in C library (printf, scanf, malloc, string functions, glibc's rand).
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
native-golden`; LDXP with one register twice is undefined there, and here).

Not done: phases 2–5 (floating point and Neon,
SVE, SME, polish and release). Later: an engine choice (auto / CPU / simulator) that needs a local helper,
since a web page cannot run machine code.
