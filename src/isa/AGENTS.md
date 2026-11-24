# AGENTS.md

## 1. Role

The instruction-set plugins and their registry. `index.ts` lists every ISA the selector shows: MIPS32 is
available; AArch64 is being built and can be chosen only in the development build; x86-64 appears as a
disabled placeholder so the interface stays honest about the plan. Each plugin lives in its own folder and implements `IsaPlugin` from
`src/core/isa.ts`: registers, memory layout, editor language, catalog, assembler, machine, decoder and
the calculator's one-line analysis.

## 2. Constraints

- A plugin folder may import from `src/core` but never from `src/ui` or another plugin.
- The UI only sees what the registry exports; plugin internals stay private to their folder.
- A plugin still being built is `available` only in the development build (`import.meta.env.DEV`); the
  published site lists it as not yet available. The app re-creates its panels when the ISA changes.

## 3. Contents

- `index.ts` — the registry (`isas`, `defaultIsa`, `getIsa`).
- `mips` — the MIPS32 plugin with the full MARS 4.5 instruction set.
- `arm64` — the AArch64 (ARMv9-A) plugin, in progress.

## 4. Progress

Done: MIPS32. In progress: AArch64 (phase 2 of 5 done, dev build only; the published bundle leaves it out
through a dev-only dynamic import). Not done: x86-64.
