# AGENTS.md

## 1. Role

The Vue user interface. `ide` is the Edit & run tab (editor, toolbar, terminal, registers, stack,
memory, files, dialogs); `calc` is the instruction set tab and the disassembler. The shared pieces
here are the colour tokens for both themes, the reactive language setting with its `t()` helper, and
guarded access to the browser's local storage for per-viewer preferences.

## 2. Constraints

- Components talk to an ISA only through `IsaPlugin` and `Session` from `src/core`.
- Every visible string goes through `t(zh, en)` or `tx(text)`; no hard-coded single-language text.
- Colours only from the tokens in `theme.css`; check both themes and widths down to 320 px.
- No ASCII art: bit fields, registers and memory are real components.
- Storage access is wrapped in try/catch and the UI must work when storage is unavailable.

## 3. Contents

- `theme.css` — light and dark colour tokens, fonts, and the shared button, input, chip, card styles.
- `i18n.ts` — the saved language (`lang`), `t(zh, en)` and `tx(text)` for components.
- `storage.ts` — `load` and `save` of preferences in localStorage, prefixed `asmsim.`; `loadSettings` reads
  an ISA's machine settings; `isaKey` scopes a key to one ISA (MIPS keeps the unscoped names it always had).
- `ide` — the Edit & run tab.
- `calc` — the instruction set tab and the disassembler.

## 4. Progress

Done: three tabs, two languages, two themes, layouts from phones to wide screens.
Not done: console notes already printed keep their old language after a switch.
