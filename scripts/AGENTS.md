# AGENTS.md

## 1. Role

Developer tools that run on a developer's machine, never in the site. The main one regenerates the
golden fixtures in `tests/golden/expected` by running MARS 4.5 on every test program and every example,
so the tests can compare our engine with MARS without needing Java or the jar. `mars` holds a small
Java helper that lists the instruction forms MARS knows, used when checking our form table by hand.

## 2. Constraints

- MARS is a test oracle only: these tools may call the jar, but nothing they read from it is copied
  into `src`. The jar stays outside the repository (`MARS_JAR`, default
  `~/.cache/assembly-simulator/Mars4_5.jar`).
- Output must be deterministic so regenerated fixtures only change when behaviour changes.

## 3. Contents

- `mars-golden.mjs` — runs MARS on `tests/golden/programs/*.asm` and the IDE examples and writes one
  JSON fixture per program (`npm run golden`, optionally with program names).
- `mars` — a Java helper that prints MARS's instruction forms.

## 4. Progress

Done: fixtures for 22 test programs and 7 examples. Not done: nothing outstanding.
