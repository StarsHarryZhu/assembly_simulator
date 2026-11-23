# AGENTS.md

## 1. Role

The instruction-set plugins and their registry. `index.ts` lists every ISA the selector shows; only
MIPS32 is available, while ARM64 and x86-64 appear as disabled placeholders so the interface stays
honest about the plan. Each plugin lives in its own folder and implements `IsaPlugin` from
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

## 4. Progress

Done: MIPS32. Not done: ARM64 and x86-64 plugins (interfaces are ready, nothing is implemented).
