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
import { FPCR_ID, FPSR_ID, P0, SVCR, V0, Z0 } from '../../src/isa/arm64/registers'
import { BUF_SIZE, initialState, rng, sveState, vectorState, zaState, type NativeState, type SveState, type VectorState, type ZaState } from './state'

/** Where the buffer sits in our machine. */
export const SIM_BUF = 0x500000
export const SIM_TEXT = 0x400000

const GROUPS = new Set(['arith', 'logic', 'move', 'bits', 'cond', 'load', 'atomic', 'fp', 'simd', 'simdfp', 'crypto', 'vload'])
/** Groups whose cases run with a random FPCR. */
const FP_GROUPS = new Set(['fp', 'simd', 'simdfp', 'crypto', 'vload'])
const SKIP = /^(pac|aut|xpac|ldra|retaa|retab|braa|blraa)/
/** Features this CPU lacks (they would only show SIGILL): SM3 and SM4 are checked by unit tests instead. */
const ABSENT = new Set(['sm3', 'sm4'])

export interface NativeCase {
  group: string
  text: string
  word: number
  seed: number
  /** Registers that point into the buffer. */
  ptr: number[]
  /** Registers that hold small offsets. */
  small: number[]
  /** FPCR for the case (0 outside the floating-point groups). */
  fpcr: number
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
  const size = memory.length
  return {
    isa: 'arm64',
    instructions: [{ addr: SIM_TEXT, word, basic: '', file: 'case.s', line: 1, source: '', part: 0, parts: 1 }],
    declarations: [],
    symbols: {},
    image: [{ addr: SIM_BUF, bytes: memory }],
    entry: SIM_TEXT,
    sections: [
      { name: '.text', addr: SIM_TEXT, size: 4 },
      { name: '.data', addr: SIM_BUF, size },
    ],
  }
}

/** Our machine records every address it loads or stores, to drop cases that leave the buffer. */
class Probe extends ArmMachine {
  outside = false
  size = BUF_SIZE
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
    if (a < SIM_BUF || a + size > SIM_BUF + this.size) this.outside = true
  }
}

/** Set a machine to a case's starting state. */
export function applyState(m: ArmMachine, s: NativeState, ptr: number[], vs: VectorState, fpcr: number): void {
  s.x.forEach((v, n) => m.setRegister(n, ptr.includes(n) ? BigInt(SIM_BUF) + v : v))
  for (let i = 0; i < 4; i++) m.setRegister(33 + i, (s.nzcv >> (3 - i)) & 1)
  vs.v.forEach((v, n) => m.setRegister(V0 + n, v))
  m.setRegister(FPCR_ID, BigInt(fpcr))
  m.setRegister(FPSR_ID, 0n)
}

export function nativeCases(perInstr = 8, seed = 11): NativeCase[] {
  loadTables()
  const rand = rng(seed)
  const out: NativeCase[] = []
  let caseSeed = 1000
  for (const ins of allInstrs()) {
    const group = ins.spec.group
    if (!GROUPS.has(group) || SKIP.test(ins.spec.mnemonic) || ins.spec.feature === 'pauth' || ABSENT.has(ins.spec.feature ?? '')) continue
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
      const memoryForm = group === 'load' || group === 'atomic' || group === 'vload'
      const ptr = memoryForm && 'Rn' in f ? [f.Rn!] : []
      // The base register named twice (as data too) would store or compare a buffer address, which differs.
      if (ptr.length && (text.match(new RegExp(`\\b[xw]${ptr[0]}\\b`, 'g'))?.length ?? 0) > 1) continue
      // Offset registers (and the post-index registers of structure loads) hold small values.
      const small = memoryForm && 'Rm' in f && ('option' in f || group === 'vload') && f.Rm !== f.Rn ? [f.Rm!] : []
      const s = caseSeed++
      const state = initialState(s, ptr, small)
      const vs = vectorState(s)
      const fpcr = FP_GROUPS.has(group) ? vs.fpcr : 0
      const m = new Probe(caseProgram(word, state.memory), quiet())
      applyState(m, state, ptr, vs, fpcr)
      m.step()
      if (m.outside) continue
      out.push({ group, text, word, seed: s, ptr, small, fpcr })
      made++
    }
  }
  return out
}

/* ------------------------------------------------------------------ SVE, run in streaming mode */

/** The SVE groups; their cases run on the CPU in streaming mode, at its streaming vector length. */
export const SVE_GROUPS = new Set(['sve', 'sve2', 'sveperm', 'svepred', 'svefp', 'sveload'])
/** SVE cases get a larger buffer (a vector is up to 256 bytes, and loads reach several vectors away). */
export const SVE_BUF = 2048
export const SVE_BASE = 1024

/** Set a machine to an SVE case's starting state (vl in bytes). */
export function applySveState(m: ArmMachine, s: NativeState, ptr: number[], zs: SveState, fpcr: number): void {
  s.x.forEach((v, n) => m.setRegister(n, ptr.includes(n) ? BigInt(SIM_BUF) + v : v))
  for (let i = 0; i < 4; i++) m.setRegister(33 + i, (s.nzcv >> (3 - i)) & 1)
  zs.z.forEach((v, n) => m.setRegister(Z0 + n, v))
  zs.p.forEach((v, n) => m.setRegister(P0 + n, v))
  m.setRegister(FPCR_ID, BigInt(fpcr))
  m.setRegister(FPSR_ID, 0n)
}

/** The starting state of an SVE case. */
export const sveInputs = (seed: number, ptr: number[], small: number[], vl: number) => ({
  state: initialState(seed, ptr, small, SVE_BUF, SVE_BASE),
  sve: sveState(seed, vl),
  fpcr: vectorState(seed).fpcr,
})

/**
 * Cases for the SVE groups at a vector length of `vl` bytes. Instructions illegal in streaming mode (gathers,
 * first-fault loads, FFR, FADDA…) raise SIGILL on the CPU; the generator drops those cases.
 */
export function sveCases(vl: number, perInstr = 6, seed = 13): NativeCase[] {
  loadTables()
  const rand = rng(seed)
  const out: NativeCase[] = []
  let caseSeed = 500000
  for (const ins of allInstrs()) {
    const group = ins.spec.group
    if (!SVE_GROUPS.has(group)) continue
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
      const memoryForm = group === 'sveload'
      const ptr = memoryForm && 'Rn' in f ? [f.Rn!] : []
      if (ptr.length && (text.match(new RegExp(`\\b[xw]${ptr[0]}\\b`, 'g'))?.length ?? 0) > 1) continue
      const small = memoryForm && 'Rm' in f && f.Rm !== f.Rn ? [f.Rm!] : []
      const s = caseSeed++
      const { state, sve, fpcr } = sveInputs(s, ptr, small, vl)
      const m = new Probe(caseProgram(word, state.memory), quiet(), { settings: { vl: vl * 8 } })
      m.size = SVE_BUF
      applySveState(m, state, ptr, sve, fpcr)
      m.step()
      if (m.outside) continue
      out.push({ group, text, word, seed: s, ptr, small, fpcr })
      made++
    }
  }
  return out
}

/* ------------------------------------------------------------------ SME, run in streaming mode with ZA */

/** The SME groups; their cases run with PSTATE.SM and PSTATE.ZA set, at the CPU's streaming vector length. */
export const SME_GROUPS = new Set(['sme', 'sme2'])
/** SME cases get a larger buffer still: four-vector loads reach eight groups of four vectors either way. */
export const SME_BUF = 4096
export const SME_BASE = 2048
/** Encodings left out: MSR SVCR changes the mode the harness relies on, and this CPU lacks MOVT. */
const SME_SKIP = new Set(['msr-svcr', 'movt-x', 'movt-zt0'])

/** The starting state of an SME case (svl in bytes). */
export const smeInputs = (seed: number, ptr: number[], small: number[], svl: number) => ({
  state: initialState(seed, ptr, small, SME_BUF, SME_BASE),
  sve: sveState(seed, svl),
  za: zaState(seed, svl),
  fpcr: vectorState(seed).fpcr,
})

/** Set a machine to an SME case's starting state: Streaming SVE mode and ZA on, then the registers, ZA and ZT0. */
export function applySmeState(m: ArmMachine, s: NativeState, ptr: number[], zs: SveState, za: ZaState, fpcr: number): void {
  m.setRegister(SVCR, 3n)
  applySveState(m, s, ptr, zs, fpcr)
  const svl = m.svl
  for (let r = 0; r < svl; r++) m.zaWrite(r, za.za.subarray(r * svl, (r + 1) * svl))
  m.zt0Write(za.zt0)
}

/** Cases for the SME groups at a streaming vector length of `svl` bytes. */
export function smeCases(svl: number, perInstr = 3, seed = 19): NativeCase[] {
  loadTables()
  const rand = rng(seed)
  const out: NativeCase[] = []
  let caseSeed = 800000
  for (const ins of allInstrs()) {
    const group = ins.spec.group
    if (!SME_GROUPS.has(group) || SME_SKIP.has(ins.spec.id)) continue
    const free = ~ins.pattern.mask >>> 0
    let made = 0
    for (let tries = 0; tries < perInstr * 12 && made < perInstr; tries++) {
      const word = (ins.pattern.value | (Math.floor(rand() * 2 ** 32) & free)) >>> 0
      const f = extract(ins.pattern, word)
      if (ins.spec.valid && !ins.spec.valid(f)) continue
      if (ins.spec.check?.(f)) continue
      const text = disassemble(word, { pc: SIM_TEXT })
      if (!text || /\b(sp|wsp|x18|w18)\b|</.test(text)) continue
      const memoryForm = /^(ld|st)/.test(ins.spec.mnemonic)
      const ptr = memoryForm && 'Rn' in f ? [f.Rn!] : []
      if (ptr.length && (text.match(new RegExp(`\\b[xw]${ptr[0]}\\b`, 'g'))?.length ?? 0) > 1) continue
      const small = memoryForm && 'Rm' in f && f.Rm !== f.Rn ? [f.Rm!] : []
      const s = caseSeed++
      const { state, sve, za, fpcr } = smeInputs(s, ptr, small, svl)
      const m = new Probe(caseProgram(word, state.memory), quiet(), { settings: { svl: svl * 8 } })
      m.size = SME_BUF
      applySmeState(m, state, ptr, sve, za, fpcr)
      m.step()
      if (m.outside) continue
      out.push({ group, text, word, seed: s, ptr, small, fpcr })
      made++
    }
  }
  return out
}

/* ------------------------------------------------------------------ the streaming-mode probe */

/** Groups whose legality depends on PSTATE.SM and PSTATE.ZA. */
export const MODE_GROUPS = new Set(['fp', 'simd', 'simdfp', 'crypto', 'vload', ...SVE_GROUPS, 'sme', 'sme2'])

export interface ModeCase {
  id: string
  group: string
  word: number
}

/**
 * Sample words of every encoding in MODE_GROUPS for the probe, which runs each in the four SVCR states
 * (MSR SVCR itself changes the state, so it is left out).
 */
export function modeCases(perInstr = 2, seed = 17): ModeCase[] {
  loadTables()
  const rand = rng(seed)
  const out: ModeCase[] = []
  for (const ins of allInstrs()) {
    if (!MODE_GROUPS.has(ins.spec.group) || ins.spec.id === 'msr-svcr' || ABSENT.has(ins.spec.feature ?? '')) continue
    const free = ~ins.pattern.mask >>> 0
    let made = 0
    for (let tries = 0; tries < perInstr * 12 && made < perInstr; tries++) {
      const word = (ins.pattern.value | (Math.floor(rand() * 2 ** 32) & free)) >>> 0
      const f = extract(ins.pattern, word)
      if (ins.spec.valid && !ins.spec.valid(f)) continue
      if (ins.spec.check?.(f)) continue
      out.push({ id: ins.spec.id, group: ins.spec.group, word })
      made++
    }
  }
  return out
}

export { initialState, vectorState, sveState, BUF_SIZE, BASE_OFFSET } from './state'
