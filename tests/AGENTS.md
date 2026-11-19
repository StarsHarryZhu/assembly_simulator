# AGENTS.md

## 1. Role

All automated checks, run by `npm test` (Vitest). Unit tests cover the machine, the session, the
calculator and the translations; the golden test assembles and runs every program in
`golden/programs` and every IDE example and compares the result with what MARS 4.5 produced; the
AGENTS.md checker keeps the folder documentation in the required shape.

## 2. Constraints

- Tests never need Java or the MARS jar: fixtures are committed in `golden/expected`.
- A new behaviour that MARS also has gets a golden program; behaviour MARS lacks gets a unit test.
- Tests import from `src` directly and run under Node without a browser.

## 3. Contents

- `golden.test.ts` — compares our assembler and machine with the MARS fixtures, program by program.
- `version.test.ts` — the header version is the version in package.json.
- `agents-md.test.ts` — every folder has an AGENTS.md with the four sections and a complete contents list.
- `helpers.ts` — a console environment that feeds stdin the way the MARS command line does.
- `core` — session tests.
- `mips` — machine, calculator and translation tests.
- `ui` — editor helper tests that run without a browser.
- `golden` — the test programs and the MARS fixtures.

## 4. Progress

Done: 46 golden fixtures and the unit suites pass. Not done: nothing outstanding.
