# AGENTS.md

## 1. Role

The machinery behind the AArch64 instruction table: bit patterns, logical-immediate encoding, operand
templates and the table that turns lines into words and words into text, in both directions.

## 2. Constraints

- One definition per encoding drives assembling, disassembling, the catalog, completion hints and the
  decoder's field meanings; nothing is written twice.
- The disassembler prints what LLVM's objdump prints (after normalising spaces and numbers) and the
  assembler accepts what clang accepts, including clang's refusals of UNPREDICTABLE register choices.
- Operand types are pure: they read and write `Fields`, never the machine.

## 3. Contents

- `pattern.ts` — bit-pattern strings to mask, value and field positions.
- `bitmask.ts` — logical immediates (N, immr, imms) to values and back.
- `syntax.ts` — operand templates: compile, match, print, sample, rebuild from operand texts.
- `operands.ts` — every operand type (registers, immediates, labels, shifts, extends, system names).
- `simd.ts` — SIMD&FP operand types: scalar and vector registers, elements, lists, lanes, FP and modified immediates.
- `sve.ts` — SVE operand types: Z and P registers with element sizes, lists and pairs, predicate-as-counter, indexed elements, patterns, shift and logical immediates.
- `table.ts` — the instruction and alias table: define, encode a line, decode a word, pick the alias to show.

## 4. Progress

Done: everything the A64 base needs, including the full DC, IC, AT and TLBI name tables (with the nXS
and range forms). Phase 2: vector arrangements, elements and lanes, register lists, structure
loads' post-index forms, floating-point and modified immediates (`simd.ts`). Phase 3: the SVE operand
types (`sve.ts`) and SVE's condition names (`b.first`, `b.none`…). Not done: ZA operand types for phase 4.
