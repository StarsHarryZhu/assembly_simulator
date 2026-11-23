# AGENTS.md

## 1. Role

Whole programs that clang assembles into an object file; `tests/arm64/llvm.test.ts` checks that our
assembler puts the same bytes in every section.

## 2. Constraints

- No reference may cross sections (the object file would hold a zero waiting for relocation).
- Only syntax clang accepts (for example `'a'`, not the GNU-only `'a`).

## 3. Contents

- `pool.s` — `ldr =` constants: which become MOVZ, and where pool entries and `.ltorg` put them.
- `data.s` — data directives, expressions, alignment with fill, and padding in code.
- `macro.s` — macros, `.rept`/`.irp`/`.irpc`, conditions, local labels, `;` and comments.

## 4. Progress

Done: the three programs match. Not done: nothing outstanding.
