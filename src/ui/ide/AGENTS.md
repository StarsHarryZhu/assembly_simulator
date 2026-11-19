# AGENTS.md

## 1. Role

The Edit & run tab: a CodeMirror editor with breakpoints and error marks, a toolbar with the three
ways to execute (step, run, auto-step at an interval) plus back and reset, a terminal that takes keyboard
input, and the machine panels. Registers are drawn in one grid coloured by use (grey unused, green read,
red written, the last step's writes in stronger red until the next step); the stack is shown from `$sp` to its base; memory is one entry per
data declaration plus heap blocks and other written ranges.

## 2. Constraints

- One `Session` per tab, created in `useSession.ts`; components re-render by reading the session's
  version counter inside `computed`, never by deep-watching the session.
- Panels must stay fast after a long run: they read the machine's summary, not its whole memory, and
  their cost per step must not depend on address ranges or declaration sizes.
- Addresses are unsigned: normalise with `>>> 0` after any bit operation (`addr & ~3` is negative for
  kernel addresses such as 0x90000000, which once made every step scan half the address space).
- Keyboard shortcuts (F5 run, F6 auto, F7 step, F8 back, F9 pause, F10 reset) call `preventDefault`
  so the browser does not reload.
- There is no assemble button: run controls go through `handle.control`, which assembles first (with
  the spinner) when the code changed. Slow actions show the shared `.spinner` from `theme.css`.
- The editor's tab width and indent unit are 4 spaces.
- Every editor feature that needs to know what a word is (pink label references, section bands, label
  suggestions, modifier-click) uses the one line scan `scanLine` in `editor.ts`, which reads identifiers
  the way the assembler does (`.L1`, `a$b`). Labels and macros come from the shared `sourceIndex` state
  field, rebuilt once per document change; never rescan the document on hover, scroll or selection.
- Label suggestions come from that index: a label in a data section (`language.dataSections`) is data and
  shows its declaration, any other is code and shows its line. Where an operand takes a label
  (`language.labelOperands`), the list opens before anything is typed, with the wanted kind first.
- Modifier-click (⌘ on macOS, Ctrl elsewhere) is handled in `editor.ts`, not by the browser's follow-link
  behaviour: a mnemonic or directive opens its statement in the instruction set tab, a label reference or macro call
  jumps to its definition. While the modifier is held over a target, `editor.ts` underlines it and shows
  a hand cursor, as VS Code does, and clears the decoration when the modifier is released or the pointer
  leaves the token. Included files have no editor, so their labels cannot be jumped to.
- Never use the browser's `confirm()`/`alert()`: embedded browsers may drop them. Ask with
  `ConfirmDialog.vue`.

## 3. Contents

- `IdeView.vue` — layout, shortcuts, file drop, New/Open/examples with the unsaved-changes prompt;
  forwards the editor's `open-instruction` event to the app.
- `useSession.ts` — creates the session, version counter, busy state, saved code and settings, sound.
- `editor.ts` — CodeMirror language, label and section marks, VS Code-style suggestions (with a short
  index of an instruction's reference tables, and each directive's explanation), auto-closed quotes and brackets, breakpoints, modifier-click navigation with VS Code-style link feedback.
- `EditorPane.vue` — the editor bound to the session (text, breakpoints, diagnostics, current line);
  emits `open-instruction` for a modifier-clicked mnemonic.
- `Toolbar.vue` — new, open, download, examples, run controls, interval, step size (line by default), status.
- `TerminalPane.vue` — program output with input prompt, messages, files.
- `FilesPanel.vue` — files the program can open, with upload and download.
- `files.ts` — saving bytes or text as a browser download.
- `RegisterPanel.vue` — all register banks in one grid with use colours, last-step highlight, details.
- `StackPanel.vue` — words from `$sp` up to the stack base, top first.
- `MemoryPanel.vue` — data declarations, heap blocks and other written memory; rows in fixed `ch`
  columns, strings and `.space` as hex plus one character cell per byte.
- `memoryEntries.ts` — builds the memory panel's entries and summaries (cost independent of sizes).
- `TextSegmentView.vue` — the assembled machine code next to the source.
- `DialogHost.vue` — dialogs for the syscalls 50–59.
- `ConfirmDialog.vue` — in-page question with several answers (save / don't save / cancel).

## 4. Progress

Done: everything listed above, checked in the browser in both languages and themes, including
⌘/Ctrl-click navigation to the instruction set tab and to label and macro definitions.
Not done: nothing outstanding.
