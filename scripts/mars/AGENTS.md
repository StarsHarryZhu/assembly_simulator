# AGENTS.md

## 1. Role

A dev-only Java program compiled against the MARS 4.5 jar. It prints every basic and extended
(pseudo) instruction form MARS knows, one JSON object per line, with its example syntax, description and
encoding or expansion template. It was used to check that our instruction and pseudo-instruction tables
cover every form; it is not part of the build or the tests.

## 2. Constraints

- Never commit its output or the jar, and never copy MARS's tables into `src`: the listing is only for
  comparing coverage.
- Compile and run with the jar on the class path, outside the repository, e.g.
  `javac -cp Mars4_5.jar -d out DumpInstructions.java` then `java -cp Mars4_5.jar:out DumpInstructions`.

## 3. Contents

- `DumpInstructions.java` — prints MARS's instruction forms as JSON lines.

## 4. Progress

Done: used once to confirm full coverage of MARS 4.5 forms. Not done: nothing outstanding.
