/**
 * Behaviour cases for the native oracle (scripts/native-golden.mjs), drawn from our own instruction table:
 * random words inside each encoding of the classes that run without side effects (arithmetic, logic,
 * moves, bit operations, conditional select, loads and stores, atomics), shown as text by our disassembler
 * (which matches LLVM), with a starting state from state.ts.
 *
 * Left out: branches and system instructions (they leave the harness), MOPS (absent on Apple CPUs), pointer
 * authentication (Apple enables its keys, we model them disabled), anything naming sp or x18, and
 * PC-relative forms. Our own machine runs each case first; a case whose loads or stores reach outside
 * the buffer is dropped, since the native harness only maps the buffer.
 */
import { loadTables } from '../../src/isa/arm64/instructions/index'
import { allInstrs, disassemble, operandsOf } from '../../src/isa/arm64/encoding/table'
import { extract } from '../../src/isa/arm64/encoding/pattern'
import { ArmMachine } from '../../src/isa/arm64/cpu'
import type { Environment, Program } from '../../src/core/isa'
import { BUF_SIZE, initialState, rng, type NativeState } from './state'

/** Where the buffer sits in our machine. */
export const SIM_BUF = 0x500000
export const SIM_TEXT = 0x400000

const GROUPS = new Set(['arith', 'logic', 'move', 'bits', 'cond', 'load', 'atomic'])
const SKIP = /^(pac|aut|xpac|ldra|retaa|retab|braa|blraa)/

export interface NativeCase {
  group: string
  text: string
  word: number
  seed: number
  /** Registers that point into the buffer. */
  ptr: number[]
  /** Registers that hold small offsets. */
  small: number[]
}

const quiet = (): Environment => ({
  print: () => {},
  readLine: () => null,
  readChar: () => null,
  dialog: () => null,
  files: { read: () => null, write: () => {}, list: () => [] },
  now: () => 0,
})

/** A one-instruction program with the buffer as its data. */
export function caseProgram(word: number, memory: Uint8Array): Program {
  return {
    isa: 'arm64',
    instructions: [{ addr: SIM_TEXT, word, basic: '', file: 'case.s', line: 1, source: '', part: 0, parts: 1 }],
    declarations: [],
    symbols: {},
    image: [{ addr: SIM_BUF, bytes: memory }],
    entry: SIM_TEXT,
    sections: [
      { name: '.text', addr: SIM_TEXT, size: 4 },
      { name: '.data', addr: SIM_BUF, size: BUF_SIZE },
    ],
  }
}

/** Our machine records every address it loads or stores, to drop cases that leave the buffer. */
class Probe extends ArmMachine {
  outside = false
  override load(addr: bigint, size: number, acc = 0): bigint {
    this.note(addr, size)
    return super.load(addr, size, acc)
  }
  override store(addr: bigint, size: number, value: bigint, acc = 0): void {
    this.note(addr, size)
    super.store(addr, size, value, acc)
  }
  private note(addr: bigint, size: number) {
    const a = Number(addr)
    if (a < SIM_BUF || a + size > SIM_BUF + BUF_SIZE) this.outside = true
  }
}

/** Set a machine to a case's starting state. */
export function applyState(m: ArmMachine, s: NativeState, ptr: number[]): void {
  s.x.forEach((v, n) => m.setRegister(n, ptr.includes(n) ? BigInt(SIM_BUF) + v : v))
  for (let i = 0; i < 4; i++) m.setRegister(33 + i, (s.nzcv >> (3 - i)) & 1)
}

export function nativeCases(perInstr = 8, seed = 11): NativeCase[] {
  loadTables()
  const rand = rng(seed)
  const out: NativeCase[] = []
  let caseSeed = 1000
  for (const ins of allInstrs()) {
    const group = ins.spec.group
    if (!GROUPS.has(group) || SKIP.test(ins.spec.mnemonic) || ins.spec.feature === 'pauth') continue
    if (operandsOf(ins.form.items).some((op) => op.type.kind === 'label')) continue
    const free = ~ins.pattern.mask >>> 0
    let made = 0
    for (let tries = 0; tries < perInstr * 12 && made < perInstr; tries++) {
      const word = (ins.pattern.value | (Math.floor(rand() * 2 ** 32) & free)) >>> 0
      const f = extract(ins.pattern, word)
      if (ins.spec.valid && !ins.spec.valid(f)) continue
      if (ins.spec.check?.(f)) continue
      const text = disassemble(word, { pc: SIM_TEXT })
      if (!text || /\b(sp|wsp|x18|w18)\b|</.test(text)) continue
      const memoryForm = group === 'load' || group === 'atomic'
      const ptr = memoryForm && 'Rn' in f ? [f.Rn!] : []
      // The base register named twice (as data too) would store or compare a buffer address, which differs.
      if (ptr.length && (text.match(new RegExp(`\\b[xw]${ptr[0]}\\b`, 'g'))?.length ?? 0) > 1) continue
      const small = memoryForm && 'Rm' in f && 'option' in f && f.Rm !== f.Rn ? [f.Rm!] : []
      const s = caseSeed++
      const state = initialState(s, ptr, small)
      const m = new Probe(caseProgram(word, state.memory), quiet())
      applyState(m, state, ptr)
      m.step()
      if (m.outside) continue
      out.push({ group, text, word, seed: s, ptr, small })
      made++
    }
  }
  return out
}

export { initialState, BUF_SIZE, BASE_OFFSET } from './state'
