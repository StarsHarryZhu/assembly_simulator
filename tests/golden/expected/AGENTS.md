# AGENTS.md

## 1. Role

What MARS 4.5 produced for every golden program and every IDE example, one JSON file each, written by
`scripts/mars-golden.mjs`. Each file records the assembler result (errors, or machine code with source
lines and the data segment) and the run result (console output, final integer and float registers, and
any memory ranges the program asked for). `tests/golden.test.ts` compares our engine against them.

## 2. Constraints

- Generated files: regenerate with `npm run golden`, never edit by hand.
- File names match the programs (`<name>.json`, examples as `example-<name>.json`).

## 3. Contents

- `*.json` — one MARS fixture per program and per example.

## 4. Progress

Done: 29 fixtures. Not done: nothing outstanding.
