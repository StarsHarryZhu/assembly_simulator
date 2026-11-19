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
- The instruction set tab can be opened from the editor with a `{ line, n }` request; the request replaces
  the one-line input and clears the per-label addresses, it never runs anything.
- Reference tables come from the plugin's `references`; every table listing the analysed mnemonic is
  shown right after the title card, and the search box also matches the titles of their rows.
- Directives are listed in the picker (their own group, and under All). A line that starts with a
  directive shows a title card and the directive table with its row highlighted, never the
  "only one instruction" error.

## 3. Contents

- `EncoderTab.vue` — instruction picker, one-line input (also fed by the editor's modifier-click),
  operand editors, reference tables, machine code per word.
- `ReferenceTable.vue` — one reference table (registers read in green, written in red); folds into
  cards below about 620 px.
- `DemoRunner.vue` — runs the analysed line step by step and shows registers and memory before and after.
- `DecoderTab.vue` — machine words (one per line, optional `@ address`) to assembly.
- `BitFields.vue` — one word as a row of fields with bits, value and meaning.
- `values.ts` — parsing a word typed as hex, binary, decimal or (optionally) a float.

## 4. Progress

Done: every basic and pseudo form, both languages. Not done: nothing outstanding.
