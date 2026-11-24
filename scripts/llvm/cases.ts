/**
 * Test cases for the LLVM oracle (scripts/llvm-golden.mjs), drawn from our own instruction table:
 * random words inside every encoding's pattern, random words across the instruction classes we implement
 * (to compare which words are unallocated), and the assembly lines in scripts/llvm/asm/*.s.
 */
import { loadTables } from '../../src/isa/arm64/instructions/index'
import { allInstrs } from '../../src/isa/arm64/encoding/table'
import { extract } from '../../src/isa/arm64/encoding/pattern'

/** A small deterministic generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface WordGroup {
  group: string
  words: number[]
}

/** Random words per encoding (with all-zero and all-one fields too), grouped by catalog group. */
export function wordCases(perInstr = 24, seed = 1): WordGroup[] {
  loadTables()
  const rand = rng(seed)
  const groups = new Map<string, Set<number>>()
  for (const ins of allInstrs()) {
    const set = groups.get(ins.spec.group) ?? new Set<number>()
    groups.set(ins.spec.group, set)
    const free = ~ins.pattern.mask >>> 0
    const candidates = [ins.pattern.value, (ins.pattern.value | free) >>> 0]
    for (let i = 0; i < perInstr * 4 && candidates.length < perInstr + 2; i++) candidates.push((ins.pattern.value | (Math.floor(rand() * 2 ** 32) & free)) >>> 0)
    let n = 0
    for (const w of candidates) {
      const f = extract(ins.pattern, w)
      if (ins.spec.valid && !ins.spec.valid(f)) continue
      set.add(w)
      if (++n >= perInstr) break
    }
  }
  return [...groups].map(([group, words]) => ({ group, words: [...words] }))
}

/** Top-level classes (op0, bits 28:25) implemented so far, for the unallocated-space comparison. */
export const CLASSES: { name: string; mask: number; value: number }[] = [
  { name: 'dp-imm', mask: 0x1c000000, value: 0x10000000 },
  { name: 'branch-sys', mask: 0x1c000000, value: 0x14000000 },
  { name: 'dp-reg', mask: 0x0e000000, value: 0x0a000000 },
  // Loads and stores without the SIMD&FP bit (26).
  { name: 'ldst', mask: 0x0a000000 | 0x04000000, value: 0x08000000 },
  // Loads and stores of SIMD&FP registers (bit 26 set).
  { name: 'ldst-v', mask: 0x0e000000, value: 0x0c000000 },
  // Scalar floating point, Advanced SIMD and the cryptographic extensions (op0 x111).
  { name: 'simd-fp', mask: 0x0e000000, value: 0x0e000000 },
  // SVE, SVE2 and SVE2.1 (op0 0010).
  { name: 'sve', mask: 0x1e000000, value: 0x04000000 },
]

/** Random words in the implemented classes. */
export function classCases(count = 3000, seed = 7): WordGroup[] {
  const rand = rng(seed)
  return CLASSES.map((c) => {
    const words = new Set<number>()
    while (words.size < count) words.add(((Math.floor(rand() * 2 ** 32) & ~c.mask) | c.value) >>> 0)
    return { group: `class-${c.name}`, words: [...words] }
  })
}

/** Every SYS word for the DC, IC, AT and TLBI spaces (op1 0, 3, 4, 6; CRn 7–9), with and without a register. */
export function sysCases(): WordGroup[] {
  const words: number[] = []
  for (const op1 of [0, 3, 4, 6])
    for (const crn of [7, 8, 9])
      for (let crm = 0; crm < 16; crm++)
        for (let op2 = 0; op2 < 8; op2++) for (const rt of [31, 5]) words.push((0xd5080000 | (op1 << 16) | (crn << 12) | (crm << 8) | (op2 << 5) | rt) >>> 0)
  return [{ group: 'sysops', words }]
}
