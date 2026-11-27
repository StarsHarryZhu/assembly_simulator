# AGENTS.md

## 1. Role

Assembly Simulator is a browser-based assembly IDE and simulator for teaching. It implements two
architectures, chosen in the top-left corner:

- **MIPS32** with the full MARS 4.5 instruction set (155 basic instructions, every pseudo-instruction
  form, coprocessor 0 and 1, all 39 syscalls).
- **ARMv9-A (AArch64)** in GNU as syntax, run as a Linux process: the A64 base, floating point, Neon,
  crypto, SVE/SVE2/SVE2.1 and SME/SME2/SME2.1, Linux system calls, a built-in C library and EL1
  exception vectors.

It has three tabs:

- **Edit & run** — a CodeMirror editor (VS Code-style suggestions, pink label references, section
  directives in the first column with their own colour, breakpoints), a simulated terminal with keyboard
  input, every register coloured by use (grey unused, green read, red written; the last step's writes
  stay highlighted until the next step; SME's ZA as a grid of tiles), the stack from the stack pointer to its base, memory shown as one entry per data declaration, and three
  ways to execute: single step (by source line by default, or by basic instruction, with undo), run,
  and auto-step at an interval. There is no assemble button: every run control reassembles changed code.
  Format (⇧⌥F / Shift+Alt+F, or the toolbar button) lays the code out like the example programs,
  changing whitespace only.
- **Instruction set** — pick or type one line, see its machine code as bit fields (pseudo
  instructions show their whole expansion) and step it on the real machine. Instructions that need
  more than one line get full reference tables: for MIPS every `syscall` service by `$v0`, the
  coprocessor 0 registers and exception codes, and the floating-point condition flags; for AArch64 the
  Linux system calls, the C library, condition codes, system registers, exception classes and SME's
  modes, tiles and vector groups. Every assembler directive is explained there too, and in the editor's
  suggestions.
- **Disassembler** — machine words to assembly, fields and notes.

The UI is available in Chinese and English (the system language at first, English otherwise), and the
example programs' comments follow the switch. The engine is our own; MARS is used only offline to
produce the golden test fixtures; AArch64 is checked offline against LLVM (encodings) and an Apple M5
(behaviour). x86-64 is listed in the selector but not implemented.

## 2. Constraints

- Stack: Vite + TypeScript + Vue 3 + CodeMirror 6, tests with Vitest. `npm run build` must produce a
  single self-contained `dist/index.html` (vite-plugin-singlefile) that works from `file://`.
- The UI depends only on `src/core` and the registry in `src/isa/index.ts`, never on an ISA folder.
- MARS is a test oracle only: never port its code or data tables, and never ship anything from it.
  The jar lives outside the repository (`~/.cache/assembly-simulator/Mars4_5.jar` or `MARS_JAR`).
- Every user-visible string exists in Chinese and English (`t(zh, en)` in the UI, `L(zh, en)` or a
  `Text` pair in the engine). Code comments and AGENTS.md files are English.
- No ASCII art in the UI: structure (bit fields, registers, memory) is drawn with real components.
- Never use the browser's `confirm()`/`alert()`/`prompt()`: embedded browsers may drop them silently.
  Closing the tab is the exception: only the browser's own `beforeunload` question can appear then.
- Colours come from the CSS tokens in `src/ui/theme.css`; both themes must stay legible.
- Deployment is the owner's job: `.github/workflows/pages.yml` builds and publishes on push to `main`.
- Open source under the MIT license (`LICENSE`, © 2026 Starfield); keep the copyright notice intact.
- Every folder (except dot folders, `node_modules`, `dist`) keeps an AGENTS.md with these four
  sections; `tests/agents-md.test.ts` enforces it. Update a folder's AGENTS.md in the same change.
- `npm test`, `npm run typecheck` and `npm run build` must all pass before a change is done.

## 3. Contents

- `index.html` — Vite entry page; applies the saved theme before the app loads.
- `package.json` — scripts (`dev`, `build`, `preview`, `typecheck`, `test`, `golden`, `llvm-golden`,
  `native-golden`) and dependencies.
- `package-lock.json` — locked dependency versions.
- `vite.config.ts` — Vue and single-file plugins, relative base, Vitest settings.
- `tsconfig.json` — strict TypeScript settings for sources and tests.
- `README.md` — English overview for people: features, usage, development, deployment.
- `README-zh.md` — Chinese version of the same overview; keep the two in sync.
- `LICENSE` — MIT license text; the copyright notice is what makes the license valid.
- `src` — the application: core contracts, the MIPS and AArch64 engines, and the Vue UI.
- `tests` — unit tests, golden comparisons against MARS, LLVM and the CPU, and the AGENTS.md checker.
- `scripts` — developer tools; regenerates golden fixtures with MARS, LLVM and the native CPU.
- `AGENTS.md` — this file.

## 4. Progress

Done:

- MIPS engine at MARS 4.5 parity: assembler (directives, macros, `.eqv`, `.include`), every basic and
  pseudo form, CPU with exceptions and kernel handlers, all syscalls, undo of up to 2000 steps.
  Verified against MARS on 49 golden fixtures (42 programs and all 7 examples) and by differential
  runs (about 50k instruction lines, 8k data lines, 2000 random programs, 130 syscall cases, segment
  and exception edge cases, and about 7,000 more programs in the phase 5 deep check); about 40 to 55
  million instructions per second (the built engine in Node on an Apple M5).
- Edit & run tab, instruction set tab, disassembler, Chinese/English switch, light/dark themes,
  layouts from 320 px phones to wide desktops, and a Format command in the examples' layout.
  ⌘/Ctrl-click opens an instruction in the instruction set tab and jumps label and macro references to
  their definition; while the modifier is held, the target underlines and shows a hand cursor, as in VS Code.
- AArch64 engine (built in phases 0 to 5): the A64 integer base, loads and stores, atomics, branches
  and system instructions; scalar floating point (half, single, double, BFloat16, every FPCR mode and
  FPSR flag); all of Neon with its dot product, matrix, complex and BF16 extensions, and the crypto
  extensions; SVE, SVE2 and SVE2.1 at a vector length chosen in the toolbar (128 to 2048 bits); SME,
  SME2 and SME2.1 (with I16I64, F64F64, B16B16 and F16F16) at a streaming vector length chosen there too.
  A GNU as assembler, Linux system calls, a C library whose printf and scanf match glibc, EL0/EL1
  exceptions, undo, the calculator, decoder, formatter, references, register banks for V, Z, P, ZA and
  ZT0, and 11 examples in both languages. About 65k encodings match LLVM both ways, 18957
  single-instruction cases match an Apple M5 (SVE and SME in streaming mode at 512 bits), and 5768
  words fault in the same SVCR states as on the M5. Speed on the M5: about 24 to 30 million integer
  instructions per second, 14 million for scalar floating point, 6 million for Neon, 8 million for SVE, and
  about half a million in a loop of SME outer products.
  A phase 5 deep check at new seeds (about 210k more CPU cases, 2.2 million more LLVM words, 24.5 million
  floating-point edge cases, thousands of random programs against clang, and the C library, Linux calls
  and undo against glibc's and the kernel's rules) fixed every difference it found; the few left on
  purpose are listed in `src/isa/arm64/AGENTS.md`.
- The published site offers both MIPS32 and AArch64 (phase 5: performance, every encoding described and
  explained in both languages, READMEs).
- Phase 5 speed work: scalar code runs about 3 to 5 times faster than before on both engines, Neon about 2.6
  times, and SVE and SME about 4 times, with every fixture and deep-check survey replaying unchanged. The
  engines' AGENTS.md files say how.

Not done / known gaps:

- Not implemented on purpose: MARS tools (MMIO keyboard and display, bitmap display), delayed
  branching, the compact memory configuration.
- Stricter than MARS on purpose, where MARS silently produces a garbled program: instructions inside
  `.data`, integers wider than 32 bits, branches beyond 16-bit range, unterminated strings, `.align`
  above 21, `.eqv` values that use macro parameters, and sbrk requests that wrap past 0x7fffffff.
- Different from MARS on purpose, where MARS misbehaves: a double-precision operation on an odd register
  stops the program even with a `.ktext` handler (MARS enters it without setting EPC or Cause);
  `lwl`/`lwr`/`swl`/`swr`/`ulw`/`usw` above 0x80000000 use the real alignment (MARS takes a signed
  remainder); FP condition flags 8 to 31 run as encoded (n & 7).
- After a language switch, console notes already printed by a running program stay in the old language.
- AArch64, not implemented on purpose: MTE, FP8, LS64, TME, GCS, D128, RME, interrupts and timers,
  address translation, debug and trace, big-endian mode. SME outer products are the slowest instructions
  (each one rewrites a whole tile, about 4 µs for 16 × 16 singles), which is fine for teaching-sized programs.

Goals: x86-64 behind the same `IsaPlugin` interface.
