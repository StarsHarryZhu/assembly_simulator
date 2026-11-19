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
- Never use the browser's `confirm()`/`alert()`: embedded browsers may drop them. Ask with
  `ConfirmDialog.vue`.

## 3. Contents

- `IdeView.vue` — layout, shortcuts, file drop, New/Open/examples with the unsaved-changes prompt.
- `useSession.ts` — creates the session, version counter, busy state, saved code and settings, sound.
- `editor.ts` — CodeMirror language, label and section marks, VS Code-style suggestions, auto-closed
  quotes and brackets, breakpoints.
- `EditorPane.vue` — the editor bound to the session (text, breakpoints, diagnostics, current line).
- `Toolbar.vue` — new, open, download, examples, run controls, interval, step size (line by default), status.
- `TerminalPane.vue` — program output with input prompt, messages, files.
- `FilesPanel.vue` — files the program can open, with upload and download.
- `files.ts` — saving bytes or text as a browser download.
- `RegisterPanel.vue` — all register banks in one grid with use colours, last-step highlight, details.
- `StackPanel.vue` — words from `$sp` up to the stack base, top first.
- `MemoryPanel.vue` — data declarations, heap blocks and other written memory.
- `memoryEntries.ts` — builds the memory panel's entries and summaries (cost independent of sizes).
- `TextSegmentView.vue` — the assembled machine code next to the source.
- `DialogHost.vue` — dialogs for the syscalls 50–59.
- `ConfirmDialog.vue` — in-page question with several answers (save / don't save / cancel).

## 4. Progress

Done: everything listed above, checked in the browser in both languages and themes.
Not done: nothing outstanding.
