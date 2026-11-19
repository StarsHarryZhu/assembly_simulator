# AGENTS.md

## 1. Role

Tests for the architecture-neutral session in `src/core/session.ts`, driven through the MIPS plugin:
assembling and reassembling after edits, stepping by instruction and by source line, going back,
running to breakpoints, pausing for terminal input and resuming, and the console messages the session
prints at each stage.

## 2. Constraints

- Use the plugin's example programs (`mips.examples`) or small inline programs; no browser APIs.

## 3. Contents

- `session.test.ts` — session behaviour end to end.
- `source.test.ts` — section directive layout, example comments switching language without changing the run.

## 4. Progress

Done: session run modes (line stepping by default), reassembly after edits, source helpers. Not done: nothing outstanding.
