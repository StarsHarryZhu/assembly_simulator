# AGENTS.md

## 1. Role

MIPS programs used as golden tests. Each one targets an area of MARS behaviour: encodings of every
form, pseudo expansions, directives and alignment, immediates of every size, memory access, floating
point, syscalls, kernel exception handlers, and one `err-*` program per runtime or assembly error so
the error text and position are compared too.

## 2. Constraints

- A `# golden:` header may set `norun`, `steps=N` or `mem=A-B` (see `scripts/mars-golden.mjs`).
- A program that reads input has a `<name>.in` file next to it; examples keep theirs here as
  `example-<name>.in`.
- Output must be ASCII so MARS and our engine print the same bytes.

## 3. Contents

- `*.asm` — the test programs, one area or one error each.
- `*.in` — standard input for the programs that read the terminal.

## 4. Progress

Done: 31 programs. Not done: nothing outstanding.
