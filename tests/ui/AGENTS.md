# AGENTS.md

## 1. Role

Tests for UI helpers that do not need a browser. CodeMirror's `EditorState` runs under Node, so the
editor's label scan, the rule that keeps section directives in the first column, the suggestion
source and the memory panel's entry builder are tested here directly; components themselves are checked by hand in the browser.

## 2. Constraints

- No DOM: only test code that works on `EditorState` and plain data.
- Use the MIPS plugin from `src/isa/mips` as the ISA under test.

## 3. Contents

- `editor.test.ts` — label scan, section directive layout on input, suggestions.
- `memory.test.ts` — memory panel entries: kernel addresses, large buffers, undeclared writes.

## 4. Progress

Done: editor helpers and memory entries. Not done: component tests (none planned; the UI is checked in the browser).
