# Assembly Simulator

**English** | [中文](README-zh.md)

Write, assemble, and step through assembly in the browser, for two architectures:

- **MIPS32**, with the instruction set and behaviour of **MARS 4.5**.
- **ARMv9-A (AArch64)**, in GNU as syntax, running as a Linux process: the A64 base, floating point, Neon, SVE/SVE2 and SME/SME2, with Linux system calls and a built-in C library.

The engines are our own: no code from MARS, LLVM or QEMU ships in the page. The build is a single self-contained `index.html` that works on GitHub Pages and also opens from a double-click on your desktop, with no network needed.

Try it online: <https://starsharryzhu.github.io/assembly_simulator/> (source on [GitHub](https://github.com/StarsHarryZhu/assembly_simulator), open source under [MIT](LICENSE)).

The interface is available in **Chinese and English**: it follows the system language on first visit (English for anything else), you can switch in the top-right corner, and your choice is remembered. Light and dark themes can be switched too. Pick the architecture in the top-left corner; each one keeps its own code and settings.

## Three tabs

### Edit & run

- **Editor**:
  - Syntax highlighting: section directives (`.data`, `.text`) get their own colour and a background, and always sit in the first column (typing one on an indented line moves it to the start). Label definitions and references to defined labels (such as `jal sum` or `bl factorial`) are pink.
  - VS Code-style suggestions: at the start of a line it lists instructions (with a description and every form on the right), in operand position it lists registers and defined labels. MIPS registers can be typed without `$` (`t0` offers `$t0`). Enter or Tab accepts.
  - Tab indents by 4 spaces (tab characters also display as 4 spaces), and the example programs are indented by 4 spaces.
  - Typing `"` `'` `(` `[` `{` also inserts the closing character with the cursor in between; typing that closing character jumps over it, and Backspace between the pair deletes both. An apostrophe after a word (as in don't inside a comment) is left alone.
  - **Format** (⇧⌥F on macOS, Shift+Alt+F elsewhere, as in VS Code, or the toolbar's "Format" button) lays the code out like the example programs: section directives and labels in the first column, statements indented by 4 spaces, mnemonics padded to 8 columns, one space after each comma, data in label / directive / value columns, trailing comments aligned (column 32 for MIPS, 40 for AArch64; Chinese characters count as two columns). A label written in front of an instruction moves to its own line. Only whitespace changes, so the program assembles exactly as before; one undo takes it back, and when no line moves a paused program can keep running.
  - Click a line number to set a breakpoint. Assembly errors are marked at the exact position, and the line being executed is highlighted.
  - **Modifier-click**: hold ⌘ on macOS (Ctrl on Windows and Linux) and click an instruction to open that statement in the Instruction set tab; click a label reference or a macro call to jump to its definition. While the modifier is held, clickable tokens underline and show a hand cursor, as in VS Code. Labels defined in an included file have no editor to jump to.
  - "New" starts an empty file; you can also open a source file (`.asm` for MIPS, `.s` for AArch64, or drag one into the editor), download it, or pick one of the example programs. If the current code has unsaved changes (changed since opening, creating, or downloading), switching asks first: save (download), don't save, or cancel. Closing or reloading the tab with such changes makes the browser ask whether to leave (browsers ask only after you have clicked or typed in the page). Switching the interface language also switches the example programs' comments (code and line numbers stay the same; a running program is untouched). Code is saved in the browser automatically.
- **No separate assemble step**: once the code changes, run, step, undo, auto, and reset all reassemble first. Slow operations show a spinner.
- **Three ways to execute**:
  - **Step** runs one source line. On MIPS a pseudo-instruction (`li`, `la`, `blt`) expands to several real instructions that run together; the "step by" switch in the toolbar changes this to "basic instruction" (one real instruction per step, as in MARS), which also reports "pseudo-instruction k/N". On AArch64 every line is one instruction, and a call into the built-in C library is one step.
  - **Run** executes until the end, a breakpoint, input, or an error. The program runs in slices of about 12 ms so the page stays responsive and redraws between slices; you can pause at any time.
  - **Auto** steps automatically at a chosen interval (0–2000 ms, adjustable while running).
  - **Undo** goes back up to 2000 steps; register colours, the stack, and memory return to their state at that point.
- **Terminal**: program output appears here, and you type input here when the program asks for it. There are also a "Messages" page (assembly and runtime errors) and a "Files" page (files the program reads and writes, which you can upload and download).
- **Registers**: every register in one panel, split into pages. **Grey** means not used yet, **green** read, **red** written; registers written by the last step stay dark red until the next step. Click any cell to see its hexadecimal, binary, signed and unsigned decimal, and character value; floating-point registers also show their float value.
  - MIPS: general (32 registers plus HI/LO), floating point (`$f0`–`$f31` and the 8 condition bits), and CP0.
  - AArch64: general (`x0`–`x30`, `sp`, with the low 32 bits as `w`), the NZCV flags, FP and vector (`v0`–`v31` shown as lanes of a chosen size and format, FPCR, FPSR), SVE (`z0`–`z31`, `p0`–`p15`, FFR), SME (SVCR, the ZA array, ZT0), and system registers. **ZA** opens as a grid: pick an element size and a tile (`za0.s` and so on) or the whole array, and the elements the last step changed are red.
- **Stack**: the contents from the stack pointer up to the stack base (4-byte slots on MIPS, 8-byte on AArch64), the top few by default with an option to expand to the base, marking where the stack and frame pointers point.
- **Memory**: one entry per data label (label, type, address, value); expand an entry to see every element. Lines without a label that continue the one above with the same type belong to it (`A: .word 1, 2, 3, 4` followed by `.word 5, 6, 7, 8` is eight words of `A`); other unlabelled data is named by its offset, such as `A+32`. An expanded entry can be read as hex bytes, text, or numbers of any width, so a buffer can show the string or the numbers stored in it. Heap blocks (`sbrk` on MIPS; `malloc`, `brk` and `mmap` on AArch64) and data written elsewhere each get their own entry too. Recently changed places are highlighted.
- **Machine code view**: switch the area above the editor to the assembly result (address, machine code, real instruction, matching source line). Click a row to open it in the Disassembler tab.
- **AArch64 settings** in the toolbar: the SVE vector length and the SME streaming vector length (128 to 2048 bits; 256 and 512 by default). Programs written the SVE way compute the same results at every length; changing one restarts the program.

Shortcuts: F5 run, F6 auto, F7 step, F8 undo, F9 pause, F10 reset, ⇧⌥F (Shift+Alt+F) format.

### Instruction set

Pick an instruction from the list (filter by group, or search the Chinese or English description), or type a line of assembly. The machine code appears below with each word drawn as bit fields, showing what every range means. MIPS pseudo-instructions list each real instruction they expand to. At the bottom the line is executed on the real simulator, showing which registers and memory it read and wrote. Instructions that need more than one line come with reference tables: MIPS syscalls, CP0 registers and exception codes, floating-point condition flags; AArch64 Linux system calls, the C library, condition codes, system registers, exception classes, and SME's modes, tiles and vector groups. Every assembler directive is explained too.

### Disassembler

Enter one machine word per line (`0x` hexadecimal, `0b` binary, 32 bits of 0 and 1, or decimal). Append `@ address` to say where the word lives (which affects branch targets), and get the assembly text, its bit fields, and a note.

## MIPS32

- **All 155 basic instructions** of MARS 4.5 (integer, HI/LO, SPECIAL2, traps, CP0, single- and double-precision floating point) and **every pseudo-instruction form**, expanding the same way as MARS.
- Directives: `.text` `.data` `.ktext` `.kdata` `.word` `.half` `.byte` `.ascii` `.asciiz` `.space` `.align` `.float` `.double` `.globl` `.extern` `.eqv` `.macro`/`.end_macro` `.include` `.set`.
- **All 39 syscalls** (1–17, 30–36, 40–44, 50–59): input waits for you to type in the terminal; 31 and 33 really make a sound; 32 really waits; 40–44 use the same random-number algorithm as MARS, so the same seed gives the same numbers; 50–59 open dialogs.
- Exceptions: overflow, traps, misaligned and out-of-range addresses, `break`, and so on. With a `.ktext` handler the program jumps to `0x80000180`; without one it stops with the same message as MARS.
- Memory layout matches MARS's default configuration: text at `0x00400000`, data at `0x10010000`, heap at `0x10040000`, `$gp = 0x10008000`, `$sp = 0x7fffeffc`, little-endian, no delayed branching. As in MARS, each segment has 4 MB behind it, and reading the text segment as data is an address error.
- Speed: about 40 to 55 million instructions per second on an Apple M5.

**Deliberately not implemented**: MARS's tools (MMIO keyboard and display, bitmap display, and so on), delayed branching, and the compact memory configuration.

**Deliberately stricter than MARS**: where MARS silently produces a broken program, this is an error instead: instructions inside `.data`, integers wider than 32 bits, branches out of 16-bit range, unterminated strings, `.align` above 21, a `.eqv` value that uses a macro parameter, and an `sbrk` request that wraps past `0x7fffffff`.

## ARMv9-A (AArch64)

- **Instructions**: everything mandatory in Armv9.4-A, plus SVE2.1 and SME2.1:
  - integer and bit operations, with CSSC, FlagM, CRC32 and the MOPS memory copy and set;
  - loads and stores in every addressing mode, pairs, exclusives, load-acquire/store-release, LRCPC and the LSE atomics;
  - branches, conditional select and system instructions;
  - scalar floating point in half, single, double and BFloat16, with every FPCR mode (rounding, FZ, FZ16, DN, AH, FIZ, NEP, AHP) and FPSR flag;
  - all of Neon, with dot products, I8MM, FHM, FCMA, RDM, BF16 and FP16, and the AES, SHA-1, SHA-256, SHA-512, SHA-3, SM3 and SM4 instructions;
  - SVE, SVE2 and SVE2.1: predication, first-fault and non-fault loads, gathers and scatters, predicate-as-counter;
  - SME, SME2 and SME2.1 with I16I64, F64F64, B16B16 and F16F16: streaming mode, the ZA array with its tiles, slices and vector groups, ZT0 with LUTI2/LUTI4, outer products and multi-vector instructions.
  - Pointer authentication and BTI behave as on a system that leaves them off: `paciasp` and `autiasp` change nothing, `retaa` is `ret`, `bti` is a no-op.
- **Assembler**: GNU as syntax, the way clang reads it: `//`, `/* */` and `#` at the start of a line for comments, `;` between statements, `#` before immediates optional, numeric local labels (`1:`, `1b`, `1f`), expressions with `:lo12:` and the other relocation operators, `adrp` page addresses, literal pools (`ldr x0, =value`), and the directives for sections, data, alignment, symbols, macros (`.macro`, `.rept`, `.irp`), conditions and `.include`.
- **A Linux process**: the program starts at `_start` if it defines one; otherwise built-in startup code sets up the stack, `argc` and `argv`, calls `main`, and exits with its return value. `.text` starts at `0x400000` with the data sections after it, the heap after the data, the stack top at `0x0000fffffffff000` (8 MB), little-endian.
- **Linux system calls** with `svc #0` and the real numbers in `x8`: `read` 63, `write` 64, `openat` 56, `close` 57, `lseek` 62, `exit` 93, `exit_group` 94, `brk` 214, `mmap` 222 (anonymous memory), `munmap` 215, `getrandom` 278, `clock_gettime` 113, `nanosleep` 101, `getpid` 172, `getppid` 173, `getuid` 174, `gettid` 178. Any other number returns `-ENOSYS` with a note in the terminal.
- **Built-in C library**: `bl printf` and friends work when the program does not define them, as if the library were linked: `printf`, `sprintf`, `snprintf`, `puts`, `putchar`, `scanf`, `sscanf`, `getchar`, `malloc`, `calloc`, `realloc`, `free`, `exit`, `abort`, `strlen`, `strcmp`, `strncmp`, `strcpy`, `strncpy`, `strcat`, `strchr`, `memcpy`, `memmove`, `memset`, `memcmp`, `atoi`, `atol`, `strtol`, `abs`, `labs`, `rand`, `srand`, `time`. Arguments follow AAPCS64 (variadic ones as on Linux), `printf` and `scanf` handle floating point (`%f %e %g %a`) exactly as glibc does, and `rand` gives glibc's sequence. So these programs also build and run with `gcc` on a real Linux machine.
- **Exceptions**: a program with a `.ktext` section gets an EL1 vector table (at the label `vectors`, or the start of `.ktext`). Undefined instructions, `brk`, `udf`, data and instruction aborts, alignment faults, and EL0 access to EL1 registers then go there with `ESR_EL1`, `ELR_EL1`, `FAR_EL1` and `SPSR_EL1` set, and `eret` returns. Without one the program stops the way a Linux process does on a signal (SIGILL, SIGSEGV, SIGBUS, SIGTRAP), with the exception class, ESR and fault address. `svc #0` always goes to the simulated Linux.
- **Eleven example programs**: a first loop, raw system calls, printf formats, recursion with stack frames, scanf input, the heap, floating point, Neon dot products, an SVE loop that works at any vector length, a matrix product from SME outer products, and faults handled at EL1.
- Speed on an Apple M5: about 24 to 30 million integer instructions per second, 14 million for scalar floating point, about 6 million for Neon and 8 million for SVE. SME outer products are much slower (a loop of them runs about half a million instructions per second), since each updates a whole tile.

**Not implemented**: MTE, FP8, LS64, TME, GCS, D128, RME, interrupts and timers, address translation (addresses are flat, with permissions per region), debug and trace, and big-endian mode.

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
| `npm test` | Run all tests (unit tests, comparisons with MARS, LLVM and the CPU, AGENTS.md check) |
| `npm run typecheck` | TypeScript and Vue type checking |
| `npm run build` | Build `dist/index.html` (a single file you can open by double-clicking) |
| `npm run preview` | Preview the build locally |
| `npm run golden` | Regenerate the MIPS golden results with MARS |
| `npm run llvm-golden` | Regenerate the AArch64 encoding fixtures with clang and objdump |
| `npm run native-golden` | Regenerate the AArch64 behaviour fixtures on an Apple silicon Mac |

### How the engines are checked

Every reference result is generated beforehand and committed, so `npm test` needs no Java, MARS, clang or particular CPU.

- **MIPS against MARS**: the test programs in `tests/golden/programs/` and all the example programs were run through MARS 4.5, and the results (machine code, data segment, terminal output, final registers, errors) are in `tests/golden/expected/`. Regenerating needs Java and the MARS 4.5 jar (not kept in the repository):

  ```bash
  MARS_JAR=~/.cache/assembly-simulator/Mars4_5.jar npm run golden
  ```

- **AArch64 encodings against LLVM**: random words of every encoding are disassembled by objdump and the text compared with ours, our encodings are assembled by clang and compared with our words, and whole programs are compared section by section. That covers about 65,000 encodings and 29,000 words drawn across whole instruction classes. `npm run llvm-golden` needs a clang and an objdump that know AArch64 (`CLANG` and `OBJDUMP` choose them).
- **AArch64 behaviour against a real CPU**: about 19,000 single-instruction cases ran on an Apple M5, starting from random registers, flags, FPCR modes and memory, and our machine must end every one with the same registers, vector registers, flags, FPSR and memory, or the same fault. SVE and SME cases ran in streaming mode at 512 bits, the SME ones with ZA and ZT0. A further 5,768 instruction words were run with streaming mode and ZA in each combination of on and off, to check which states forbid which instructions. `npm run native-golden` needs an Apple silicon Mac with clang (SVE and SME cases need SME hardware, M4 or later).
- What the M5 cannot run (SVE instructions that streaming mode forbids, SM3 and SM4, MOVT, EL1 exceptions, system calls, the C library, assembler errors) is checked by unit tests written from the architecture's description, and `printf` formats against the host's C library.
- **Deeper surveys**: the three generators take a different seed and size (`SEED`, `PER`, `OUT`, and `COUNT` for LLVM; `GOLDEN_DIR` for MARS) to write a larger set somewhere else, and the tests replay it with `GOLDEN_DIR`, `LLVM_DIR` or `NATIVE_DIR` without touching the committed fixtures. Before release this ran about 7,000 more MIPS programs against MARS, 210,000 more CPU cases, 2.2 million more words against LLVM, thousands of random programs against clang and 24.5 million floating-point edge cases under every FPCR mode; what they found is fixed and kept in the unit tests.

MARS, LLVM and the CPU are used only to produce reference results; the site runs our own engines.

### Adding text in another language

Every string on the interface is written in both Chinese and English: `t('中文', 'English')` in components, and `L('中文', 'English')` or `T('中文', 'English')` in the engines. MIPS keeps the English descriptions of real instructions in `src/isa/mips/instructions/en.ts`; AArch64 writes both languages next to each instruction's definition. The English versions of the example programs are in `examples/en/` of each architecture: the code must be identical to the Chinese version and only the comments may differ (a test enforces this, and another checks every AArch64 encoding's description, decoder notes and operand hints in English).

## Deployment

`.github/workflows/pages.yml` runs the tests and the build on every push to `main`, then publishes `dist/` to GitHub Pages. This repository is already set to **Settings → Pages → Source = GitHub Actions**; set it the same way when you copy the project to a new repository.

## Layout

| Path | Contents |
| --- | --- |
| `src/core` | Architecture-independent interfaces, the run session, memory, formatting, and language |
| `src/isa/mips` | The MIPS32 engine: instruction table, assembler, CPU, syscalls, disassembler, example programs |
| `src/isa/arm64` | The AArch64 engine: instruction tables, assembler, CPU with soft floating point, Linux and C library, disassembler, example programs |
| `src/ui` | Vue interface: edit & run, instruction set, disassembler |
| `tests` | Tests and the MARS, LLVM and CPU reference results |
| `scripts` | Scripts that generate the reference results |

Every folder contains an English `AGENTS.md` explaining what the folder is responsible for, its constraints, what each file does, and its progress.

## License

The code is open source under the [MIT License](LICENSE), © 2026 Starfield: use, modify, and redistribute it freely as long as you keep the copyright notice. It is provided "as is", without warranty of any kind.
