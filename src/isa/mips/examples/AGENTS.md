# AGENTS.md

## 1. Role

Example programs for the IDE's example menu, each showing one thing the panels make visible: register
colours, the stack growing during calls, memory entries changing, keyboard input, floating point, heap
blocks from `sbrk`, and an exception caught by a kernel handler. These files carry Chinese comments;
`en` holds the same programs with English comments, and the plugin pairs them by file name.

## 2. Constraints

- The first line is `# <title>`; the menu shows it.
- Section directives (`.data`, `.text`, `.kdata`, `.ktext`) start in the first column; instructions are
  indented by 4 spaces (the editor's tab width).
- Each line has the same code as the same line of the English copy, so comments can be swapped line by
  line when the language changes (`src/core/source.ts`).
- Strings in the programs stay ASCII so output matches MARS byte for byte.
- Every example is a golden program (`example-<name>`): regenerate fixtures with `npm run golden`
  after changing one, and keep the English copy's code identical (`tests/mips/i18n.test.ts`).
- The menu order is `EXAMPLE_ORDER` in the plugin's `index.ts`.

## 3. Contents

- `welcome.asm` — sums an array through a function call; the default program.
- `hello.asm` — prints a string.
- `factorial.asm` — recursive factorial with stack frames.
- `input.asm` — reads a line and an integer from the terminal.
- `float.asm` — single and double precision arithmetic and printing.
- `heap.asm` — builds a linked list in memory from `sbrk`.
- `exceptions.asm` — an overflow handled at 0x80000180 and resumed.
- `en` — the same programs with English comments.

## 4. Progress

Done: seven examples, all matching MARS, in both languages. Not done: no further examples planned.
