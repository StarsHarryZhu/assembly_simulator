# Assembly Simulator

**English** | [中文](README-zh.md)

Write, assemble, and step through MIPS assembly in the browser. The instruction set and behaviour match **MARS 4.5**, but the engine is our own: no MARS code ships in the page. The build is a single self-contained `index.html` that works on GitHub Pages and also opens from a double-click on your desktop, with no network needed.

Try it online: <https://starsharryzhu.github.io/assembly_simulator/> (source on [GitHub](https://github.com/StarsHarryZhu/assembly_simulator), open source under [MIT](LICENSE)).

The interface is available in **Chinese and English**: it follows the system language on first visit (English for anything else), you can switch in the top-right corner, and your choice is remembered. Light and dark themes can be switched too.

## Three tabs

### Edit & run

- **Editor**:
  - Syntax highlighting: section directives (`.data`, `.text`) get their own colour and a background, and always sit in the first column (typing one on an indented line moves it to the start). Label definitions and references to defined labels (such as `jal sum` or `la $a0, msg`) are pink.
  - VS Code-style suggestions: at the start of a line it lists instructions (with a description and every form on the right), after `$` it lists registers (or type the name without `$`: `t0` offers `$t0`), and in operand position it lists defined labels. Enter or Tab accepts.
  - Tab indents by 4 spaces (tab characters also display as 4 spaces), and the example programs are indented by 4 spaces.
  - Typing `"` `'` `(` `[` `{` also inserts the closing character with the cursor in between; typing that closing character jumps over it, and Backspace between the pair deletes both. An apostrophe after a word (as in don't inside a comment) is left alone.
  - **Format** (⇧⌥F on macOS, Shift+Alt+F elsewhere, as in VS Code, or the toolbar's "Format" button) lays the code out like the example programs: section directives and labels in the first column, statements indented by 4 spaces, mnemonics padded to 8 columns, one space after each comma, data in label / directive / value columns, trailing comments aligned at column 32 (Chinese characters count as two columns). A label written in front of an instruction moves to its own line. Only whitespace changes, so the program assembles exactly as before; one undo takes it back, and when no line moves a paused program can keep running.
  - Click a line number to set a breakpoint. Assembly errors are marked at the exact position, and the line being executed is highlighted.
  - **Modifier-click**: hold ⌘ on macOS (Ctrl on Windows and Linux) and click an instruction to open that statement in the Instruction set tab; click a label reference or a macro call to jump to its definition. While the modifier is held, clickable tokens underline and show a hand cursor, as in VS Code. Labels defined in an included file have no editor to jump to.
  - "New" starts an empty file; you can also open an `.asm` file (or drag one into the editor), download it as `.asm`, or pick one of the example programs. If the current code has unsaved changes (changed since opening, creating, or downloading), switching asks first: save (download as `.asm`), don't save, or cancel. Switching the interface language also switches the example programs' comments (code and line numbers stay the same; a running program is untouched). Code is saved in the browser automatically.
- **No separate assemble step**: once the code changes, run, step, undo, auto, and reset all reassemble first. Slow operations show a spinner.
- **Three ways to execute**:
  - **Step** runs one source line by default; pseudo-instructions (`li`, `la`, `blt`) expand to several real instructions that run together. The "step by" switch in the toolbar changes this to "basic instruction" (one real instruction per step, as in MARS), which also reports "pseudo-instruction k/N".
  - **Run** executes until the end, a breakpoint, input, or an error. The program runs in slices of about 12 ms so the page stays responsive and redraws between slices; you can pause at any time.
  - **Auto** steps automatically at a chosen interval (0–2000 ms, adjustable while running).
  - **Undo** goes back up to 2000 steps; register colours, the stack, and memory return to their state at that point.
- **Terminal**: program output appears here, and you type input here when the program asks for it. There are also a "Messages" page (assembly and runtime errors) and a "Files" page (files the program reads and writes with syscalls 13–16, which you can upload and download).
- **Registers**: every register in one panel, on three pages: general (32 registers plus HI/LO), floating point (`$f0`–`$f31` and the 8 condition bits), and CP0. **Grey** means not used yet, **green** read, **red** written; registers written by the last step stay dark red until the next step. Click any cell to see its hexadecimal, binary, signed and unsigned decimal, and character value; floating-point registers also show float and double.
- **Stack**: the contents from `$sp` up to the stack base, the top few words by default with an option to expand to the base, marking where `$sp` and `$fp` point.
- **Memory**: one entry per `.data` declaration (label, type, address, value); expand an entry to see every element. Blocks allocated by `sbrk` and data written elsewhere each get their own entry too. Recently changed places are highlighted.
- **Machine code view**: switch the area above the editor to the assembly result (address, machine code, real instruction, matching source line). Click a row to open it in the Disassembler tab.

Shortcuts: F5 run, F6 auto, F7 step, F8 undo, F9 pause, F10 reset, ⇧⌥F (Shift+Alt+F) format.

### Instruction set

Pick an instruction from the list (filter by R / I / J / REGIMM / SPECIAL2 / traps / CP0 / floating point / pseudo-instructions, or search the Chinese or English description), or type a line of assembly. The machine code appears below with each word drawn as bit fields, showing what every range means. Pseudo-instructions list each real instruction they expand to. At the bottom the line is executed on the real simulator, showing which registers and memory it read and wrote.

### Disassembler

Enter one machine word per line (`0x` hexadecimal, `0b` binary, 32 bits of 0 and 1, or decimal). Append `@ address` to say where the word lives (which affects branch and jump targets), and get the assembly text, its bit fields, and a note.

## Coverage

- **All 155 basic instructions** of MARS 4.5 (integer, HI/LO, SPECIAL2, traps, CP0, single- and double-precision floating point) and **every pseudo-instruction form**, expanding the same way as MARS.
- Directives: `.text` `.data` `.ktext` `.kdata` `.word` `.half` `.byte` `.ascii` `.asciiz` `.space` `.align` `.float` `.double` `.globl` `.extern` `.eqv` `.macro`/`.end_macro` `.include` `.set`.
- **All 39 syscalls** (1–17, 30–36, 40–44, 50–59): input waits for you to type in the terminal; 31 and 33 really make a sound; 32 really waits; 40–44 use the same random-number algorithm as MARS, so the same seed gives the same numbers; 50–59 open dialogs.
- Exceptions: overflow, traps, misaligned and out-of-range addresses, `break`, and so on. With a `.ktext` handler the program jumps to `0x80000180`; without one it stops with the same message as MARS.
- Memory layout matches MARS's default configuration: text at `0x00400000`, data at `0x10010000`, heap at `0x10040000`, `$gp = 0x10008000`, `$sp = 0x7fffeffc`, little-endian, no delayed branching. As in MARS, each segment has 4 MB behind it, and reading the text segment as data is an address error.
- Speed: about 5 million instructions per second.

**Deliberately not implemented**: MARS's tools (MMIO keyboard and display, bitmap display, and so on), delayed branching, and the compact memory configuration.

**Deliberately stricter than MARS**: where MARS silently produces a broken program, this is an error instead: instructions inside `.data`, integers wider than 32 bits, branches out of 16-bit range, unterminated strings, `.align` above 21, a `.eqv` value that uses a macro parameter, and an `sbrk` request that wraps past `0x7fffffff`.

**ARM64 and x86-64**: both appear in the architecture selector and their interfaces exist, but they are not implemented.

## Development

Requires Node.js 22.12 or newer (the Pages workflow uses Node 24).

```bash
npm install
```

```bash
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm test` | Run all tests (unit tests, comparisons against MARS golden results, AGENTS.md check) |
| `npm run typecheck` | TypeScript and Vue type checking |
| `npm run build` | Build `dist/index.html` (a single file you can open by double-clicking) |
| `npm run preview` | Preview the build locally |
| `npm run golden` | Regenerate the golden results with MARS (see below) |

### Comparing against MARS

The test programs in `tests/golden/programs/` and all the example programs were run through MARS 4.5 beforehand, and the results (machine code, data segment, terminal output, final registers, errors) are committed in `tests/golden/expected/`. `npm test` compares our engine against them point by point, so no Java or MARS is needed normally.

Regenerating is only necessary when test or example programs change. It needs Java and the MARS 4.5 jar (which is not kept in the repository):

```bash
MARS_JAR=~/.cache/assembly-simulator/Mars4_5.jar npm run golden
```

MARS is only used to produce the golden results; the site itself runs our own engine.

### Adding text in another language

Every string on the interface is written in both Chinese and English: `t('中文', 'English')` in components, and `L('中文', 'English')` or `T('中文', 'English')` in the engine. The English descriptions of real instructions are in `src/isa/mips/instructions/en.ts`. The English versions of the example programs are in `src/isa/mips/examples/en/`: the code must be identical to the Chinese version and only the comments may differ (a test enforces this).

## Deployment

`.github/workflows/pages.yml` runs the tests and the build on every push to `main`, then publishes `dist/` to GitHub Pages. This repository is already set to **Settings → Pages → Source = GitHub Actions**; set it the same way when you copy the project to a new repository.

## Layout

| Path | Contents |
| --- | --- |
| `src/core` | Architecture-independent interfaces, the run session, memory, formatting, and language |
| `src/isa/mips` | The MIPS32 engine: instruction table, assembler, CPU, syscalls, disassembler, example programs |
| `src/ui` | Vue interface: edit & run, instruction set, disassembler |
| `tests` | Tests and MARS golden answers |
| `scripts` | Scripts that generate the golden answers |

Every folder contains an English `AGENTS.md` explaining what the folder is responsible for, its constraints, what each file does, and its progress.

## License

The code is open source under the [MIT License](LICENSE), © 2026 Starfield: use, modify, and redistribute it freely as long as you keep the copyright notice. It is provided "as is", without warranty of any kind.
