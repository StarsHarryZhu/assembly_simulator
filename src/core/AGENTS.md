# AGENTS.md

## 1. Role

Architecture-neutral building blocks shared by every ISA plugin and by the UI. `isa.ts` defines the
contracts (`IsaPlugin`, `Machine`, `Program`, `StepInfo`, register and memory descriptions, the
calculator's `LineAnalysis`), `session.ts` runs a program for the IDE (assemble, step, back, run, auto,
breakpoints, console, input), and the rest are small helpers for numbers, memory and language.

## 2. Constraints

- No Vue, no DOM, and no import from `src/isa` or `src/ui`: everything here runs under Node in tests.
- Register values are raw bit patterns: `number` for 32 bits and fewer, `bigint` for wider scalar
  registers. Vector, predicate and matrix registers are read as bytes (`Machine.readRegisterBytes`).
- Addresses are JS numbers. In a 64-bit address space (`MemoryLayout.addressBits: 64`) they stay below
  2^49: numbers from 2^48 up stand for the top half (`0xffff…`), see `vaOf`/`addrOf`. Never apply
  `>>> 0` or `& ~3` to them there; that cuts them to 32 bits.
- Engine text built at run time uses `L(zh, en)`; text fixed at load time is a `Text` pair.
- Keep `Session` framework-agnostic: it notifies listeners, the UI decides how to re-render.

## 3. Contents

- `isa.ts` — the plugin, machine, program, diagnostic, register and calculator contracts, the
  reference tables for instructions a one-line description cannot explain (`ReferenceTable`), the
  editor's view of the language (comments, block comments, statement separator, register test, data
  directive names), the tabs' starting samples, and the optional `format` (the editor's Format command;
  whitespace only).
- `session.ts` — one editing-and-running session: assembly, console, breakpoints, step granularity,
  run in time slices of at most about 12 ms (the page stays responsive), auto-step, undo, program input and dialogs, the in-memory file store. Every run
  control assembles first when the source changed; there is no separate assemble step in the UI.
  Text that keeps every instruction on its line (comments in another language, formatted code) keeps the
  assembled program and a paused run (`replaceComments`, `reformat`).
- `memory.ts` — sparse little-endian memory in 4 KB pages: `PagedMemory` for 32-bit address spaces,
  `WideMemory` (with 64-bit access) for 64-bit ones.
- `format.ts` — hex, binary groups, signed/unsigned, characters, half/float/double/bfloat16 bits,
  Java-style printing, and the same for 64-bit and wider values and addresses.
- `i18n.ts` — the two locales, `Text` pairs, `L()`, `tx()`, `cat()`.
- `source.ts` — comment position, section directives to the first column, example comments into
  another language, and the minimal whitespace-only edits between a text and its formatted version.

## 4. Progress

Done: contracts used by the MIPS plugin and all panels; session covered by `tests/core`; the contract
and helpers a 64-bit ISA with vector registers needs (ARMv9-A phase 0), used by the AArch64 plugin
(`Program.sections` gives its page-aligned section layout, `language.fileExtension` its `.s` files,
`DecodedView.description` the description of a form that shares its mnemonic).
Not done: vector, predicate and ZA register paths stay unused until AArch64 phases 2–4.
