# AGENTS.md

## 1. Role

Assembly Simulator is a browser-based assembly IDE and simulator for teaching. It implements MIPS32
with the full MARS 4.5 instruction set (155 basic instructions, every pseudo-instruction form,
coprocessor 0 and 1, all 39 syscalls) and has three tabs:

- **Edit & run** — a CodeMirror editor (VS Code-style suggestions, pink label references, section
  directives in the first column with their own colour, breakpoints), a simulated terminal with keyboard
  input, every register coloured by use (grey unused, green read, red written; the last step's writes
  stay highlighted until the next step), the stack from `$sp` to its base, memory shown as one entry per data declaration, and three
  ways to execute: single step (by source line by default, or by basic instruction, with undo), run,
  and auto-step at an interval. There is no assemble button: every run control reassembles changed code.
  Format (⇧⌥F / Shift+Alt+F, or the toolbar button) lays the code out like the example programs,
  changing whitespace only.
- **Instruction set** — pick or type one line, see its machine code as bit fields (pseudo
  instructions show their whole expansion) and step it on the real machine. Instructions that need
  more than one line get full reference tables: every `syscall` service by `$v0`, the coprocessor 0
  registers and exception codes, and the floating-point condition flags; every assembler directive is
  explained there too, and in the editor's suggestions.
- **Disassembler** — machine words to assembly, fields and notes.

The UI is available in Chinese and English (the system language at first, English otherwise), and the
example programs' comments follow the switch. The engine is our own; MARS is used only offline to
produce the golden test fixtures. Interfaces for other ISAs (ARM, x86-64) exist but are not implemented.

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
- `src` — the application: core contracts, the MIPS engine, and the Vue UI.
- `tests` — unit tests, golden comparisons against MARS, and the AGENTS.md checker.
- `scripts` — developer tools; regenerates golden fixtures with MARS, LLVM and the native CPU.
- `AGENTS.md` — this file.

## 4. Progress

Done:

- MIPS engine at MARS 4.5 parity: assembler (directives, macros, `.eqv`, `.include`), every basic and
  pseudo form, CPU with exceptions and kernel handlers, all syscalls, undo of up to 2000 steps.
  Verified against MARS on 46 golden fixtures (39 programs and all 7 examples) and by differential
  runs (about 50k instruction lines, 8k data lines, 2000 random programs, 130 syscall cases, segment
  and exception edge cases); about 5 million instructions per second.
- Edit & run tab, instruction set tab, disassembler, Chinese/English switch, light/dark themes,
  layouts from 320 px phones to wide desktops, and a Format command in the examples' layout.
  ⌘/Ctrl-click opens an instruction in the instruction set tab and jumps label and macro references to
  their definition; while the modifier is held, the target underlines and shows a hand cursor, as in VS Code.

Not done / known gaps:

- Not implemented on purpose: MARS tools (MMIO keyboard and display, bitmap display), delayed
  branching, the compact memory configuration.
- Stricter than MARS on purpose, where MARS silently produces a garbled program: instructions inside
  `.data`, integers wider than 32 bits, branches beyond 16-bit range, unterminated strings, `.align`
  above 21, `.eqv` values that use macro parameters, and sbrk requests that wrap past 0x7fffffff.
- After a language switch, console notes already printed by a running program stay in the old language.

In progress: an ARMv9-A (AArch64) plugin covering the A64 base, floating point, Advanced SIMD, SVE/SVE2
and SME/SME2, with Linux system calls, a built-in C library and EL1 exception vectors. It is built in
phases and stays selectable only in the development build (the published bundle leaves its code out)
until all of them are done. Phase 0 is done: the core contracts and panels handle 64-bit registers and
addresses, vector registers, and GNU as comments, with MIPS unchanged. Phase 1 is done: the A64 integer
base, loads and stores, atomics, branches and system instructions, a GNU as assembler, Linux system
calls, a C library, EL0/EL1 exceptions, the calculator, decoder, formatter, references and 7 examples.
Encodings match LLVM both ways; 3240 single-instruction cases match this Mac's CPU; about 3.4 million
instructions per second. Phase 2 is done: scalar floating point (half, single, double, BFloat16, every
FPCR mode and FPSR flag), all of Neon with its dot product, matrix, complex and BF16 extensions, the
crypto extensions, printf and scanf of floats, and the float and simd examples; 8107 more cases match
the CPU. Phase 3 is done: SVE, SVE2 and SVE2.1 with a vector length chosen in the toolbar (128 to 2048
bits), predication, first-fault loads, gathers and scatters, predicate-as-counter, the register panel's
SVE bank and the sve example; 26741 encodings match LLVM, 5555 cases match the CPU in streaming mode at
512 bits, and unit tests cover what streaming mode forbids. Next: phase 4 (SME, SME2, SME2.1).

Goals: the AArch64 plugin above, then x86-64, behind the same `IsaPlugin` interface.
