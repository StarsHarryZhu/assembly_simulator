# AGENTS.md

## 1. Role

All application source. `core` holds the architecture-neutral contracts and the run session; `isa`
holds instruction-set plugins (only MIPS32 today); `ui` holds the Vue components and styles; `App.vue`
is the shell with the three tabs, the language selector, the theme switch and the version badge. The UI reaches an ISA
only through the `IsaPlugin` interface, so adding ARM or x86-64 means adding a plugin, not editing
the panels.

## 2. Constraints

- Imports flow one way: `ui` → `core` and `isa/index.ts`; `isa/*` → `core`; `core` imports nothing
  from `isa` or `ui`.
- No network access at run time and no external assets: the build inlines everything into one page.
- User-visible text is bilingual (see the root AGENTS.md); comments are English.

## 3. Contents

- `main.ts` — creates the Vue app and loads the theme stylesheet.
- `App.vue` — header (title, ISA selector, tabs, language and theme controls, version) and the tab bodies.
- `version.ts` — the package version, injected by Vite at build time so the header never hard-codes it.
- `core` — contracts (`IsaPlugin`, `Machine`, …), formatting, paged memory, i18n, the run session.
- `isa` — the ISA registry and the MIPS32 plugin.
- `ui` — Vue components for the IDE, the instruction set tab and the disassembler, the theme, storage and UI i18n helpers.

## 4. Progress

Done: all three tabs work on the MIPS plugin in both languages and both themes.
Not done: other ISAs. Known defects: none open.
