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
- **Instruction set** — pick or type one line, see its machine code as bit fields (pseudo
  instructions show their whole expansion) and step it on the real machine.
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
- Colours come from the CSS tokens in `src/ui/theme.css`; both themes must stay legible.
- Deployment is the owner's job: `.github/workflows/pages.yml` builds and publishes on push to `main`.
- Open source under the MIT license (`LICENSE`, © 2026 Starfield); keep the copyright notice intact.
- Every folder (except dot folders, `node_modules`, `dist`) keeps an AGENTS.md with these four
  sections; `tests/agents-md.test.ts` enforces it. Update a folder's AGENTS.md in the same change.
- `npm test`, `npm run typecheck` and `npm run build` must all pass before a change is done.

## 3. Contents

- `index.html` — Vite entry page; applies the saved theme before the app loads.
- `package.json` — scripts (`dev`, `build`, `preview`, `typecheck`, `test`, `golden`) and dependencies.
- `package-lock.json` — locked dependency versions.
- `vite.config.ts` — Vue and single-file plugins, relative base, Vitest settings.
- `tsconfig.json` — strict TypeScript settings for sources and tests.
- `README.md` — English overview for people: features, usage, development, deployment.
- `README-zh.md` — Chinese version of the same overview; keep the two in sync.
- `LICENSE` — MIT license text; the copyright notice is what makes the license valid.
- `src` — the application: core contracts, the MIPS engine, and the Vue UI.
- `tests` — unit tests, golden comparisons against MARS, and the AGENTS.md checker.
- `scripts` — developer tools; regenerates golden fixtures with MARS.
- `AGENTS.md` — this file.

## 4. Progress

Done:

- MIPS engine at MARS 4.5 parity: assembler (directives, macros, `.eqv`, `.include`), every basic and
  pseudo form, CPU with exceptions and kernel handlers, all syscalls, undo of up to 2000 steps.
  Verified against MARS on 38 golden fixtures (31 programs and all 7 examples); about 5 million
  instructions per second.
- Edit & run tab, instruction set tab, disassembler, Chinese/English switch, light/dark themes,
  layouts from 320 px phones to wide desktops. ⌘/Ctrl-click opens an instruction in the instruction
  set tab and jumps label and macro references to their definition, with a hover hint.

Not done / known gaps:

- Not implemented on purpose: MARS tools (MMIO keyboard and display, bitmap display), delayed
  branching, the compact memory configuration. Instructions inside `.data` are an error here, while
  MARS silently accepts them.
- After a language switch, console notes already printed by a running program stay in the old language.

Goals: ARM64 and x86-64 plugins behind the same `IsaPlugin` interface.
