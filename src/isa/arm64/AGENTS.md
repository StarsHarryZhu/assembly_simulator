# AGENTS.md

## 1. Role

The AArch64 (ARMv9-A) plugin. It assembles GNU as syntax, simulates the machine as a Linux process at
EL0 (with an EL1 vector table when the program has `.ktext`), answers Linux system calls, provides a
built-in C library, and decodes words for the disassembler and the instruction set tab. It covers the A64
base, floating point, Neon and crypto, SVE/SVE2/SVE2.1 and SME/SME2/SME2.1.

## 2. Constraints

- Encodings and aliases are our own tables (`encoding`, `instructions`), checked against LLVM by
  `npm run llvm-golden`; never copy tables or code from LLVM, QEMU or the Arm specification.
- Internal addresses are numbers below 2^49: the low half as is, the top half (kernel) folded at 2^48.
  Convert with `vaOf`/`addrOf` from `src/core/format.ts`; registers hold bigints.
- Sections are laid out after assembling: `.text` at 0x400000, then `.rodata`, `.data`, `.bss`, each
  4 KB aligned; `.ktext` at 0xffff800000000000 with `.kdata` after it. The program records where they
  went in `Program.sections`, which the machine uses for permissions.
- Every state change a step makes goes through the logged `Cpu` and `Host` methods, so undo is exact.
- The step loop is the hot path. The step log keeps counters over reused arrays (never truncate or push
  them), X and SP old values in a `BigUint64Array`, and NZCV as one entry. Lanes of V, Z, P and ZA go
  through the `Cpu` lane methods, which convert through typed-array scratch cells instead of
  `Number(bigint)`. Whole-block loads and stores run only when no byte can fault; otherwise the element
  path runs, so a fault names the same element as before. In hot code, avoid `%` on values that can pass
  2^31 (V8 calls fmod): use `aligned` or `a - Math.floor(a / n) * n`.
- The soft-float fast path only runs where its result is proven equal to the soft path's (bits and FPSR
  flags); anything else falls back. `tests/arm64/softfloat.test.ts` compares the two.
  Kernel and C library state is one immutable `OsState` object.
- Every user-visible string has Chinese and English (`L`, `T`); `tests/arm64/plugin.test.ts` checks every
  encoding's description, decoder notes and operand hints in English.

## 3. Contents

- `index.ts` — the plugin object: catalog, groups, label operands, examples, layout, language.
- `lexer.ts` — tokens and statement splitting (comments, `;`, block comments).
- `expr.ts` — GNU as expressions with its operator precedence.
- `registers.ts` — register ids, banks, system registers and their encodings, register names.
- `assembler.ts` — the program assembler: directives, macros, conditions, literal pools, layout.
- `cpu.ts` — the machine: registers, memory permissions, steps, undo, exceptions, C library calls.
- `softfloat.ts` — IEEE 754 arithmetic in half, single, double and BFloat16 with every FPCR control and FPSR
  flag, plus a native fast path where the host's arithmetic provably gives the same bits and flags.
- `linux.ts` — the memory map, kernel state and the Linux system calls.
- `libc.ts` — the built-in C library (printf, scanf, malloc, string functions, glibc's rand).
- `fpformat.ts` — exact decimal and hex text of floats for printf, and correctly rounded reading for scanf.
- `decoder.ts` — a word as named bit fields (with titles for the common field names), text and notes.
- `calc.ts` — one line on its own for the instruction set tab, with demo inputs.
- `format.ts` — the editor's Format command in the examples' layout.
- `references.ts` — system calls, C library, condition codes, system registers, exceptions, SME (modes,
  ZA tiles and vector groups, ZT0), directives.
- `encoding` — bit patterns, operand syntax and the instruction table.
- `instructions` — the instruction definitions by class, with their semantics.
- `examples` — example programs (Chinese comments; `en` has the English copies).

## 4. Progress

Done: phase 0 (core and panels) and phase 1: the A64 base (integer, CSSC, FlagM, CRC32, MOPS, all
loads and stores, LSE, LRCPC, exclusives, branches, system instructions, PAuth and BTI as allowed
simplifications), the assembler matching clang byte for byte on whole programs, the machine with Linux
system calls, the C library, EL1 exceptions and undo, seven
examples in both languages, and 3240 single-instruction cases matching this Mac's CPU (`npm run
native-golden`; LDXP with one register twice is undefined there, and here). Phase 2: scalar floating
point in half, single, double and BFloat16 with every FPCR mode (FZ, FZ16, DN, AH, FIZ, NEP, AHP) and FPSR
flag, all of Neon with DotProd, I8MM, FHM, FCMA, RDM, BF16 and FP16, the AES, SHA-1/2/3/512, SM3 and SM4
instructions, printf `%f %e %g %a` and scanf of floats done exactly as glibc does, and the float and simd
examples; 22566 more encodings match LLVM and 8110 more cases match this Mac's CPU (SM3 and SM4, which it
lacks, are checked against their standards' test vectors). Phase 3: SVE, SVE2 and SVE2.1 — Z, P and FFR
state at a vector length the toolbar picks (128 to 2048 bits, 256 by default; `ZCR_EL1` can shorten it),
predication, first-fault and non-fault loads, gathers and scatters, predicate-as-counter, the B16B16
BFloat16 forms, the SVE condition names, the register panel's SVE bank and the sve example. Every in-scope
form LLVM knows decodes and assembles as it does (300k random words across the SVE space agree), 5555
cases match this Mac's CPU in streaming mode at 512 bits, and what streaming mode forbids is checked by unit
tests against the Neon equivalents or the architecture's description. FTMAD's coefficients are the
architecture's constants; FEXPA's table is computed (2^(i/64) rounded) and equals the architecture's.
Phase 4: SME, SME2 and SME2.1 with I16I64, F64F64, B16B16 and F16F16 — SVCR, smstart/smstop and the
streaming vector length (128 to 2048 bits, 512 by default; `SMCR_EL1` can shorten it), ZA with its tiles,
slices and vector groups, ZT0, LUTI2/4, the multi-vector instructions, SME exceptions for the wrong SVCR
state, the ZA grid in the register panel, the SME reference table and the sme example. 16005 encodings
match LLVM both ways (and 2.2 million surveyed words agree, apart from the extensions out of scope), 2052
cases match this Mac's CPU with ZA enabled, and the SVCR states that forbid each FP, Neon, SVE and SME
encoding match it too (MOVT, which it lacks, is left to the architecture's description).

Phase 5: every encoding described in both languages, and the plugin opened on the published site.
`softfloat.ts` takes a native fast path for single and double add, subtract and multiply, and single FMA,
in round-to-nearest when the exact error proves the result equals the soft result (`value32` and
`fma32Values` expose the single FMA to callers that convert each operand once, as outer products do).

Speed work (the built engine in Node on an Apple M5, before → after): integer loops 8 → 24–31 million
instructions per second, scalar floating point 2.8 → 14 million, Neon 2.4 → 6.3 million, SVE 2.1 → 8.2
million, a loop of SME outer products 0.14 → 0.55 million. How:
- The step log uses counters, typed arrays for X/SP old values, and one NZCV entry.
- Flags come from `addWithCarry`/`subWithBorrow` without tuples.
- Per-encoding constants are hoisted by `prepare`.
- Written-word counts are kept per 4 KB page, page permissions are cached, and doubleword accesses go
  through a `DataView`.
- Lanes, addresses (`addrOf`) and single-precision fast-path operands are converted through scratch cells,
  not `Number()` of a bigint.
- Undo keeps the old bytes of vector, predicate and ZT0 registers and of ZA rows in a buffer each step log
  owns (`StepLog.keep`) instead of allocating a copy per write.
- Integer outer products of 8- and 16-bit elements sum their products as numbers; single-precision FMOPA
  and FMOPS convert each source element once and take the native path per tile element.
- LDn/STn and SVE contiguous accesses move whole blocks, and WHILE counts are computed in closed form.

All of the deep-check fixtures replay unchanged.

Phase 5 deep check (new seeds: about 210k more CPU cases, 2.2 million more LLVM words, 24.5 million
floating-point edge cases under every FPCR mode, thousands of random programs against clang). Fixed:
CONSTRAINED UNPREDICTABLE loads and stores resolved as this Mac's CPU does (a pair load naming one register
twice, or writeback to a base that is also transferred, raises SIGILL; an exclusive store whose status
register overlaps fails and stores nothing); should-be-zero bits ignored as the CPU and LLVM do; WFET, WFIT
and `bti r`; WHILEWR/WHILERW compare addresses unsigned; SVE FABS/FNEG leave NaNs alone with FPCR.AH;
FPSR.IDC for FSQRT of a negative denormal and for division by zero; four-register MOVA/MOVAZ wrap round a
.d tile that has only two slices at SVL 128 (our choice: the CPU cannot run SVL 128); MOPS with register
31 is undefined (a CONSTRAINED UNPREDICTABLE choice). The assembler follows LLVM's rules: `.set` values as
they stand at each use, cyclic definitions reported, macros (case-sensitive names, named, `:req` and
`:vararg` parameters, `\+`, `\@`, `.exitm`, `.purgem`, nesting limit 20), `.ifeqs`/`.ifnes`/`.ifnotdef`,
data range checks, `.octa`, `.value`, `.balignw/l`, `.p2alignw/l`, character and string escapes, hex
floats, shift and extend amount spellings, and `ldr =` choosing MOVZ for W registers and sharing pool
entries. The C library and Linux calls follow glibc and the kernel on their edge cases (printf `%n`,
positional arguments, `%a` rounding, binary128, `(nil)`, `(null)`; scanf failures and `%[` sets; strtol
clamping; srandom seeds; `-EFAULT` for bad pointers; descriptor checks; shared file positions, `O_EXCL`,
`O_TRUNC`, `O_APPEND`, holes, `SEEK_DATA`/`SEEK_HOLE`; mmap validation, `MAP_FIXED`, partial munmap). The
open-file table is part of `OsState`. Undo is exact over 2000 steps, files included, and a JavaScript error
inside a step takes the step back.

Known differences from clang, left as they are: instructions in `.data` are refused; a numeric branch
target is an address (clang reads an offset); `:lo12:` on constants and `:abs_g*_s`; forward symbols in
immediates; quoted symbol names, `.dc.*` and subsections; a few newer system operations (`tlbi rpalos`,
`tlbi paallos`, `at s1e1a`, `dc cipae`, `apas`, `rprfm`).

Not done on purpose: MTE, FP8, LS64, TME, GCS, D128, RME, interrupts and timers, address translation,
debug and trace, big-endian mode. SME outer products are the slowest instructions (each rewrites a whole tile).
