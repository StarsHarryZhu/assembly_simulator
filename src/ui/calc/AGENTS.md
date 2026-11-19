# AGENTS.md

## 1. Role

The instruction set tab (formerly the instruction calculator) and the disassembler tab. The
instruction set tab turns one line of assembly into machine code: it shows every word as coloured bit
fields, expands a pseudo-instruction into all of its basic instructions, and runs the line on the real
machine with demo starting values so the reads and writes are visible. The disassembler turns machine
words back into assembly with fields and notes.

## 2. Constraints

- Encoding, decoding and running go through the plugin (`analyzeLine`, `buildLine`, `decode`,
  `createMachine`); nothing here knows MIPS encodings.
- Bit fields are drawn as components sized by bit count, never as text diagrams.

## 3. Contents

- `EncoderTab.vue` — instruction picker, one-line input, operand editors, machine code per word.
- `DemoRunner.vue` — runs the analysed line step by step and shows registers and memory before and after.
- `DecoderTab.vue` — machine words (one per line, optional `@ address`) to assembly.
- `BitFields.vue` — one word as a row of fields with bits, value and meaning.
- `values.ts` — parsing a word typed as hex, binary, decimal or (optionally) a float.

## 4. Progress

Done: every basic and pseudo form, both languages. Not done: nothing outstanding.
