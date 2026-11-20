# AGENTS.md

## 1. Role

The MIPS32 plugin, matching MARS 4.5's default configuration: no delay slots, little-endian memory,
text at 0x00400000, data at 0x10010000, heap at 0x10040000, `$sp` = 0x7fffeffc, `$gp` = 0x10008000,
kernel text at 0x80000000 with the exception handler at 0x80000180, and, as in MARS, only 4 MB behind
each segment (`memoryRegion` in `assembler.ts`; loads from code are address errors). The instruction table is the single
source of truth: the assembler, the decoder, the CPU, the editor completion and the calculator are all
generated from it, so they cannot drift apart.

## 2. Constraints

- Bit-exact parity with MARS for encodings, pseudo expansions, assembler error positions and kinds,
  runtime results and console output; `tests/golden.test.ts` checks it. Do not port MARS code or tables.
- Operand matching follows MARS's token classes (5-bit, unsigned 16-bit, signed 16-bit, 32-bit) and
  its form order: basic forms first, then pseudo forms, first match wins.
- Diagnostic and halt `code`s are stable identifiers; messages are bilingual through `L()`.
- Hot paths in `cpu.ts` avoid allocation per step (undo records are recycled from a ring).
- Addresses above 0x7fffffff are kept unsigned (`>>> 0`) wherever they index or loop: `a & ~3` alone
  turns kernel and MMIO addresses negative.
- A failed syscall throws through `syscallFault` (cause 8) so a `.ktext` handler can catch it, as in MARS.
- The formatter changes whitespace only (moving a code label onto its own line adds a line break), and
  formatting the examples changes nothing; `tests/mips/format.test.ts` checks both and that every golden
  program assembles the same after formatting. Lines whose meaning could depend on spacing (an unclosed
  quote, two labels, an `.eqv` value) are left as written.

## 3. Contents

- `index.ts` — the `IsaPlugin` object, catalog, groups, memory layout, bilingual examples, and which
  operands take a code or data label (read off the forms).
- `registers.ts` — register names, flat ids, banks and bilingual notes.
- `formats.ts` — bit-field layouts of every format and their titles.
- `instructions` — the basic-instruction table with semantics.
- `encoding.ts` — encode, decode fields, find the instruction for a word, render it as text.
- `decoder.ts` — a word as fields with meanings and notes (calculator and disassembler).
- `lexer.ts` — the line tokenizer and MARS integer classes.
- `pseudo.ts` — every pseudo-instruction form with its expansion and description.
- `forms.ts` — all source forms, operand patterns and the form-choosing rules.
- `assembler.ts` — preprocessing (`.include`, `.eqv`, macros), two passes, data directives, the memory
  map shared with the CPU, diagnostics.
- `cpu.ts` — the machine: registers, memory, exceptions, read/write status, undo, fast run loop.
- `syscalls.ts` — the 39 MARS syscalls, Java-compatible random numbers and number parsing.
- `references.ts` — reference tables: syscall services, coprocessor 0 registers, exception codes,
  floating-point condition flags, every directive with an example; written from the engine's
  behaviour and checked against it.
- `calc.ts` — one line assembled on its own for the calculator, with demo starting values.
- `format.ts` — the editor's Format command: the example programs' layout (columns, comment column 32).
- `examples` — example programs for the IDE's menu.

## 4. Progress

Done: every MARS 4.5 basic and pseudo instruction, directives, macros, kernel handlers, all syscalls,
both languages, and a formatter in the style of the examples. Not done: MARS tools (MMIO devices), delayed branching, the compact memory map.
Known differences, all stricter than MARS: instructions written inside `.data` are an error here,
while MARS accepts them silently; decimal literals above 0xFFFFFFFF are rejected (MARS wraps them
modulo 2^32); data lists such as `.word 1+2` are rejected instead of being split into separate
values; more than one label on a data line is an error (MARS silently loses the data); `.align`
above 21 is rejected (MARS accepts the directive but then rejects any data that follows); branches
beyond 16 bits and unterminated strings are errors (MARS encodes a wrong offset or drops the last
character); a `.eqv` value may not use a macro parameter; an sbrk request that wraps past
0x7fffffff fails (MARS returns memory it cannot back). Differential runs against MARS 4.5 (about
50k instruction lines, 8k data lines, 2000 random programs, 130 syscall cases and the segment,
macro and exception edge cases now in `tests/golden/programs`) show no other difference.
