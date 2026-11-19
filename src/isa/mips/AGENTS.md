# AGENTS.md

## 1. Role

The MIPS32 plugin, matching MARS 4.5's default configuration: no delay slots, little-endian memory,
text at 0x00400000, data at 0x10010000, heap at 0x10040000, `$sp` = 0x7fffeffc, `$gp` = 0x10008000,
kernel text at 0x80000000 with the exception handler at 0x80000180. The instruction table is the single
source of truth: the assembler, the decoder, the CPU, the editor completion and the calculator are all
generated from it, so they cannot drift apart.

## 2. Constraints

- Bit-exact parity with MARS for encodings, pseudo expansions, assembler error positions and kinds,
  runtime results and console output; `tests/golden.test.ts` checks it. Do not port MARS code or tables.
- Operand matching follows MARS's token classes (5-bit, unsigned 16-bit, signed 16-bit, 32-bit) and
  its form order: basic forms first, then pseudo forms, first match wins.
- Diagnostic and halt `code`s are stable identifiers; messages are bilingual through `L()`.
- Hot paths in `cpu.ts` avoid allocation per step (undo records are recycled from a ring).

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
- `assembler.ts` — preprocessing (`.include`, `.eqv`, macros), two passes, data directives, diagnostics.
- `cpu.ts` — the machine: registers, memory, exceptions, read/write status, undo, fast run loop.
- `syscalls.ts` — the 39 MARS syscalls, Java-compatible random numbers and number parsing.
- `references.ts` — reference tables: syscall services, coprocessor 0 registers, exception codes,
  floating-point condition flags, every directive with an example; written from the engine's
  behaviour and checked against it.
- `calc.ts` — one line assembled on its own for the calculator, with demo starting values.
- `examples` — example programs for the IDE's menu.

## 4. Progress

Done: every MARS 4.5 basic and pseudo instruction, directives, macros, kernel handlers, all syscalls,
both languages. Not done: MARS tools (MMIO devices), delayed branching, the compact memory map.
Known differences: instructions written inside `.data` are an error here, while MARS accepts them
silently; decimal literals above 0xFFFFFFFF are rejected (MARS wraps them modulo 2^32); data lists
such as `.word 1+2` are rejected instead of being split into separate values; more than one label on
a data line is an error (MARS silently loses the data); `.align` above 21 is rejected (MARS accepts
the directive but then rejects any data that follows). A differential audit against MARS 4.5 (543
instruction-form examples and 118 assembler edge cases) leaves only the deliberate `.data`
instruction difference.
