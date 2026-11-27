/**
 * Machine-state consistency of the AArch64 machine: random programs (integer, loads and stores, atomics,
 * floating point, Neon, SVE, SME, system registers, Linux system calls, C library calls, typed input, files,
 * and faults taken by an EL1 vector table) are stepped with a full-state snapshot before every step, then
 * undone step by step (every snapshot must come back), replayed (every step must repeat exactly), and run in
 * slices with breakpoints (every stop must equal the stepped state at the same step count).
 *
 * UNDO_FUZZ=<count> (and UNDO_SEED=<first seed>) runs more programs than the default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Environment, StepInfo } from '../../src/core/isa'
import { Session } from '../../src/core/session'
import { arm64 } from '../../src/isa/arm64'
import type { ArmMachine } from '../../src/isa/arm64/cpu'
import { allInstrs, disassemble, type Instr } from '../../src/isa/arm64/encoding/table'
import { extract } from '../../src/isa/arm64/encoding/pattern'
import { loadTables } from '../../src/isa/arm64/instructions/index'
import { ESR_EL1, FAR_EL1, REGISTER_COUNT, SMCR_EL1, SVCR, ZA } from '../../src/isa/arm64/registers'
import { MemoryFiles } from '../helpers'

/* ------------------------------------------------------------------ helpers */

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Two 32-bit hashes of some bytes (words at a time when aligned). */
function digest(b: Uint8Array): string {
  let h1 = 0x811c9dc5
  let h2 = 0x2545f491
  if (b.byteOffset % 4 === 0 && b.length % 4 === 0) {
    const w = new Int32Array(b.buffer, b.byteOffset, b.length >> 2)
    for (let i = 0; i < w.length; i++) {
      const x = w[i]!
      h1 = Math.imul(h1 ^ x, 0x01000193)
      h2 = Math.imul(h2 ^ x, 0x5bd1e995) ^ (h2 >>> 15)
    }
  } else
    for (let i = 0; i < b.length; i++) {
      const x = b[i]!
      h1 = Math.imul(h1 ^ x, 0x01000193)
      h2 = Math.imul(h2 ^ x, 0x5bd1e995) ^ (h2 >>> 15)
    }
  return `${b.length}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`
}

/** An order-independent digest of a map of numbers to numbers (the words written and how often). */
/** The machine's store counts word by word (it keeps one count per word in each 4 KB page; 0 is never). */
function wordCounts(pages: Map<number, Uint32Array>): Map<number, number> {
  const out = new Map<number, number>()
  for (const [key, page] of pages) page.forEach((n, i) => n && out.set(key * 4096 + i * 4, n))
  return out
}

function mapDigest(map: Map<number, number>): string {
  let sum = 0
  let mix = 0
  for (const [k, v] of map) {
    const h = Math.imul((k % 0x7fffffff) ^ Math.imul(Math.floor(k / 0x7fffffff), 0x9e3779b1) ^ Math.imul(v, 0x85ebca6b), 0xc2b2ae35)
    sum = (sum + h) | 0
    mix ^= Math.imul(h ^ (h >>> 16), 0x27d4eb2d)
  }
  return `${map.size}:${sum >>> 0}:${mix >>> 0}`
}

const big = (_: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? digest(v) : v)
const json = (v: unknown) => JSON.stringify(v, big)

/** The machine's private state, for a snapshot finer than the public interface. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (m: object) => m as unknown as Record<string, any>

/** The IDE's file store can delete a file (undoing a step that created one does). */
class Files extends MemoryFiles {
  remove(name: string) {
    this.files.delete(name)
  }
}

/** A console like the IDE's: input never arrives synchronously, the clock stands still. */
class QuietEnv implements Environment {
  output = ''
  files = new Files()
  print(text: string) {
    this.output += text
  }
  readLine() {
    return null
  }
  readChar() {
    return null
  }
  dialog() {
    return null
  }
  now() {
    return 1_750_000_000_000
  }
}

/**
 * Digests of memory pages, kept up to date by watching the memory object's primitive writers (setByte, setWord
 * and setDword; every other writer goes through them), so a snapshot rehashes only the pages written since
 * the last one.
 */
class PageWatch {
  private dirty = new Set<number>()
  private pages = new Map<number, string>()
  constructor(private m: ArmMachine) {
    this.attach()
  }
  attach() {
    const mem = priv(this.m).mem
    if (mem.__watched) return
    mem.__watched = true
    this.pages.clear()
    const setByte = mem.setByte.bind(mem)
    const setWord = mem.setWord.bind(mem)
    const setDword = mem.setDword.bind(mem)
    mem.setByte = (a: number, v: number) => {
      this.dirty.add(Math.floor(a / 4096))
      setByte(a, v)
    }
    mem.setWord = (a: number, v: number) => {
      this.dirty.add(Math.floor(a / 4096))
      this.dirty.add(Math.floor((a + 3) / 4096))
      setWord(a, v)
    }
    mem.setDword = (a: number, v: bigint) => {
      this.dirty.add(Math.floor(a / 4096))
      this.dirty.add(Math.floor((a + 7) / 4096))
      setDword(a, v)
    }
    // A fresh memory (after reset) starts with the program image: rehash everything it holds.
    for (const key of mem.pages.keys()) this.dirty.add(key)
  }
  text(): string {
    this.attach()
    const pages: Map<number, Uint8Array> = priv(this.m).mem.pages
    for (const key of this.dirty) {
      const p = pages.get(key)
      if (!p || p.every((b) => b === 0)) this.pages.delete(key)
      else this.pages.set(key, digest(p))
    }
    this.dirty.clear()
    return [...this.pages].sort((a, b) => a[0] - b[0]).map(([k, d]) => `${k}:${d}`).join(' ')
  }
  /** Every non-zero page, exactly (for the final states). */
  exact(): string {
    const pages: Map<number, Uint8Array> = priv(this.m).mem.pages
    return [...pages].filter(([, p]) => p.some((b) => b !== 0)).sort((a, b) => a[0] - b[0]).map(([k, p]) => `${k}:${Buffer.from(p).toString('hex')}`).join('\n')
  }
}

const SCALAR_IDS = arm64.registers.flatMap((b) => b.registers).filter((r) => !['vector', 'predicate', 'matrix'].includes(r.kind)).map((r) => r.id)
const BYTE_IDS = arm64.registers.flatMap((b) => b.registers).filter((r) => ['vector', 'predicate', 'matrix'].includes(r.kind)).map((r) => r.id)
const SYS_FIRST = 140

const osText = new WeakMap<object, string>()
const objText = (v: unknown) => (v === null || typeof v !== 'object' ? String(v) : json(v))

/**
 * Everything a step may change, as key=value lines: the machine's own fields (cheap, every step), and with
 * `full` also everything the panels read through the Machine interface.
 */
function snapshot(m: ArmMachine, env: QuietEnv, pages: PageWatch, full = false): string {
  const p = priv(m)
  const os = p.os as object
  if (!osText.has(os)) osText.set(os, json(os))
  const out = [
    `x=${digest(new Uint8Array(p.xr.buffer))} sp=${p.sp0},${p.sp1} pstate=${p.nzcv},${p.elv},${p.spsel},${p.daif},${p.smv},${p.zav}`,
    `vl=${p.maxVl},${p.nsvl},${p.maxSvl},${p.svlen},${p.vlen} fp=${p.fpcrv},${p.fpsrv}`,
    `pc=${p.pcReg} badTarget=${p.badTarget} steps=${p.stepCount} monitor=${objText(p.monitor)} wait=${p.waitStdinLen}`,
    `halt=${objText(p.haltReason)}`,
    `pendingReq=${objText(p.pendingReq)}`,
    `sys=${p.sys.join(',')}`,
    `vr=${digest(p.vr)} pr=${digest(p.pr)} za=${digest(p.za)} zt=${digest(p.zt)}`,
    `status=${digest(p.status)}`,
    `os=${osText.get(os)}`,
    `stdin=${p.stdin.join(',')}`,
    `files=${p.files?.size ? json([...p.files]) : ''}`,
    `written=${mapDigest(wordCounts(p.written))}`,
    `mem=${pages.text()}`,
    `vfs=${env.files.files.size ? [...env.files.files].sort().map(([n, d]) => `${n}:${digest(d)}`).join(' ') : ''}`,
  ]
  if (full) {
    out.push(`regs=${SCALAR_IDS.map((id) => String(m.readRegister(id))).join(',')}`)
    for (let id = SYS_FIRST; id < REGISTER_COUNT; id++) out.push(`sys${id}=${m.readRegister(id)}`)
    for (const id of BYTE_IDS) out.push(`b${id}=${digest(m.readRegisterBytes(id))}`)
    out.push(`colours=${Array.from({ length: REGISTER_COUNT }, (_, id) => m.registerStatus(id)).join('')}`)
    out.push(`state=${m.state} pc=${m.programCounter} heap=${json(m.heapBlocks())}`)
    out.push(`words=${m.writtenWords().length}`)
    out.push(`rows=${json(m.lastRowWrites(ZA))}`)
  }
  return out.join('\n')
}

function diff(a: string, b: string): string {
  const x = a.split('\n')
  const y = b.split('\n')
  const lines: string[] = []
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) lines.push(`  got  ${x[i]?.slice(0, 300)}\n  want ${y[i]?.slice(0, 300)}`)
  return lines.slice(0, 12).join('\n')
}

const infoText = (i: StepInfo) => json(i)

/** The snapshot for state k: the full one (with the Machine interface's view) every 32 states. */
const at = (t: Track, k: number) => snapshot(t.m, t.env, t.pages, k % 32 === 0)

/* ------------------------------------------------------------------ random programs */

loadTables()
const BY_GROUP = new Map<string, Instr[]>()
for (const ins of allInstrs()) {
  const list = BY_GROUP.get(ins.spec.group) ?? []
  list.push(ins)
  BY_GROUP.set(ins.spec.group, list)
}
const SCALAR = ['arith', 'logic', 'move', 'bits', 'cond', 'fp', 'simd', 'simdfp', 'crypto']
const MEMORY = ['load', 'atomic', 'vload']
const SVE = ['sve', 'sve2', 'sveperm', 'svepred', 'svefp', 'sveload']
const SME = ['sme', 'sme2']
const SKIP = /^(pac|aut|xpac|ldra|retaa|retab|braa|blraa)/

interface ArmCase {
  seed: number
  text: string
  vl: number
  svl: number
}

const FORMATS = ['v=%ld %lx %d\\n', '%u|%o|%c|%%\\n', 'f=%f %e\\n', '%g %a %.3f\\n', '%5.2f|%-8x|%+d|%08lx\\n', '%hhd %hd %lld\\n']

function armProgram(seed: number): ArmCase {
  const r = rng(seed)
  const int = (n: number) => Math.floor(r() * n)
  const pick = <T>(a: readonly T[]): T => a[int(a.length)]!
  const useSve = r() < 0.6
  const useSme = r() < 0.5
  const vl = pick([128, 256, 512, 1024, 2048])
  const svl = pick([128, 256, 512, 512, 1024])
  const handlerKind = int(3)
  const long = r() < 0.12
  const n = long ? 700 + int(400) : 30 + int(220)
  const lines: string[] = []
  const emit = (...l: string[]) => lines.push(...l.map((s) => `    ${s}`))
  const off = (align = 8) => Math.floor(int(4000) / align) * align
  /** A random instruction word of one of the groups, with base and offset registers made safe. */
  const word = (groups: string[]): boolean => {
    const list = BY_GROUP.get(pick(groups))
    if (!list) return false
    for (let tries = 0; tries < 30; tries++) {
      const ins = pick(list)
      if (SKIP.test(ins.spec.mnemonic) || ins.spec.feature === 'pauth') continue
      const free = ~ins.pattern.mask >>> 0
      const w = (ins.pattern.value | (Math.floor(r() * 2 ** 32) & free)) >>> 0
      const f = extract(ins.pattern, w)
      if (ins.spec.valid && !ins.spec.valid(f)) continue
      if (ins.spec.check?.(f)) continue
      const text = disassemble(w, { pc: 0x400000 })
      if (!text || /\b(sp|wsp)\b/.test(text)) continue
      const memory = MEMORY.includes(ins.spec.group) || ins.spec.group === 'sveload' || (SME.includes(ins.spec.group) && /^(ld|st)/.test(ins.spec.mnemonic))
      if (memory && 'Rn' in f && f.Rn! < 31) emit(`adr x${f.Rn}, buf + ${off(r() < 0.8 ? 16 : 1)}`)
      if (memory && 'Rm' in f && f.Rm! < 31 && f.Rm !== f.Rn) emit(`mov x${f.Rm}, #${int(64)}`)
      emit(`.inst 0x${w.toString(16).padStart(8, '0')} // ${text}`)
      return true
    }
    return false
  }
  const libc = () => {
    switch (int(16)) {
      case 0:
      case 1:
        return emit(`adr x0, fmt${int(FORMATS.length)}`, 'bl printf')
      case 2:
        return emit('adr x0, str0', 'bl puts')
      case 3:
        return emit(`mov x0, #${1 + int(300)}`, 'bl malloc', 'mov x21, x0', `str x${int(29)}, [x21]`, ...(int(2) ? ['mov x0, x21', 'bl free'] : []))
      case 4:
        return emit(`mov x0, #${1 + int(8)}`, `mov x1, #${1 + int(16)}`, 'bl calloc')
      case 5:
        return emit('mov x0, #0', `mov x1, #${8 + int(64)}`, 'bl realloc', `mov x1, #${64 + int(200)}`, 'bl realloc')
      case 6:
        return emit(`adr x0, buf + ${off(1)}`, `mov w1, #${int(256)}`, `mov x2, #${int(100)}`, 'bl memset')
      case 7:
        return emit(`adr x0, buf + ${off(1)}`, `adr x1, buf + ${off(1)}`, `mov x2, #${int(100)}`, 'bl memmove')
      case 8:
        return emit('adr x0, str0', 'bl strlen')
      case 9:
        return emit('bl rand')
      case 10:
        return emit(`mov w0, #${int(1000)}`, 'bl srand', 'bl rand')
      case 11:
        return emit('adr x0, num0', 'bl atoi')
      case 12:
        return emit(`adr x0, buf + ${off(1)}`, `adr x1, fmt${int(FORMATS.length)}`, 'bl sprintf')
      case 13:
        return emit('adr x0, num0', 'mov x1, #0', `mov x2, #${pick([0, 8, 10, 16])}`, 'bl strtol')
      case 14:
        return emit('mov x0, #0', 'bl time')
      default:
        return emit(`mov w0, #${32 + int(90)}`, 'bl putchar')
    }
  }
  const input = () => {
    switch (int(4)) {
      case 0:
        return emit('adr x0, scanfmt', `adr x1, buf + ${off()}`, `adr x2, buf + ${off()}`, 'bl scanf')
      case 1:
        return emit('bl getchar')
      case 2:
        return emit('mov x0, #0', `adr x1, buf + ${off(1)}`, `mov x2, #${1 + int(12)}`, 'mov x8, #63', 'svc #0')
      default:
        return emit('adr x0, scanfmt2', `adr x1, buf + ${off()}`, 'bl scanf')
    }
  }
  const system = () => {
    switch (int(9)) {
      case 0:
        return emit('mov x0, #1', `adr x1, buf + ${off(1)}`, `mov x2, #${int(40)}`, 'mov x8, #64', 'svc #0')
      case 1:
        return emit('mov x0, #0', 'mov x8, #214', 'svc #0', `add x0, x0, #${1 + int(3)}, lsl #12`, 'svc #0', 'mov x9, #0x10000000', `str x${int(29)}, [x9, #${off()}]`)
      case 2:
        return emit('mov x0, #0', `mov x1, #${1 + int(9000)}`, 'mov x2, #3', 'mov x3, #0x22', 'mov x4, #-1', 'mov x5, #0', 'mov x8, #222', 'svc #0', 'mov x22, x0', `str x${int(29)}, [x22, #${off()}]`, ...(int(3) ? [] : ['mov x0, x22', 'mov x1, #4096', 'mov x8, #215', 'svc #0']))
      case 3:
        return emit('mov x0, #-100', `adr x1, fname${int(2)}`, `mov x2, #${pick([0o102, 0o1102, 0o2102, 0o101, 0])}`, 'mov x3, #420', 'mov x8, #56', 'svc #0', 'mov x20, x0')
      case 4:
        return emit(int(2) ? 'mov x0, x20' : `mov x0, #${3 + int(2)}`, `adr x1, buf + ${off(1)}`, `mov x2, #${int(60)}`, 'mov x8, #64', 'svc #0')
      case 5:
        return emit(`mov x0, #${3 + int(2)}`, `mov x1, #${int(20)}`, `mov x2, #${int(3)}`, 'mov x8, #62', 'svc #0', `mov x0, #${3 + int(2)}`, `adr x1, buf + ${off(1)}`, `mov x2, #${int(30)}`, 'mov x8, #63', 'svc #0')
      case 6:
        return emit(`mov x0, #${3 + int(3)}`, 'mov x8, #57', 'svc #0')
      case 7:
        return emit('mov x0, #0', `adr x1, buf + ${off(16)}`, 'mov x8, #113', 'svc #0')
      default:
        return emit('adr x0, ts', 'mov x1, #0', 'mov x8, #101', 'svc #0')
    }
  }
  const sysreg = () => {
    const x = `x${int(29)}`
    emit(
      pick([
        `msr fpcr, ${x}`,
        `mrs ${x}, fpcr`,
        `mrs ${x}, fpsr`,
        `msr fpsr, ${x}`,
        `msr nzcv, ${x}`,
        `mrs ${x}, nzcv`,
        `mrs ${x}, svcr`,
        `msr svcr, ${x}`,
        `mrs ${x}, tpidr_el0`,
        `msr tpidr_el0, ${x}`,
        `mrs ${x}, cntvct_el0`,
        `mrs ${x}, midr_el1`,
        `mrs ${x}, id_aa64pfr0_el1`,
        `mrs ${x}, dczid_el0`,
        'clrex',
        `adr x9, buf + ${off(64)}\n    dc zva, x9`,
        `rdvl ${x}, #1`,
      ]),
    )
  }
  const mode = () => emit(pick(['smstart', 'smstop', 'smstart sm', 'smstop sm', 'smstart za', 'smstop za', 'smstart']))
  const fault = () => {
    switch (int(8)) {
      case 0:
        return emit(`brk #${int(65536)}`)
      case 1:
        return emit('.inst 0x00000000')
      case 2:
        return emit('mov x9, #0', 'ldr x1, [x9]')
      case 3:
        return emit(`adr x9, buf + ${1 + int(7)}`, 'ldxr x1, [x9]')
      case 4:
        return emit('mov x9, #-4096', 'ldr x1, [x9]')
      case 5:
        return emit('adr x9, fmt0', 'str x1, [x9]')
      case 6:
        return emit(pick(['msr zcr_el1, x1', 'mrs x1, elr_el1', 'msr daifset, #2', 'mrs x1, currentel']))
      default:
        return emit(pick(['mov x9, #0x30000000', 'mov x9, #-8', `adr x9, buf + ${off(1)}`, 'ldr x9, =0x400002']), 'blr x9')
    }
  }
  const exclusive = () => {
    const a = off(16)
    emit(`adr x9, buf + ${a}`, 'ldxr x1, [x9]')
    if (int(2)) word(SCALAR)
    if (int(3) === 0) emit(`adr x10, buf + ${a + 16 * int(2)}`, 'str x2, [x10]')
    emit('add x1, x1, #1', 'stxr w2, x1, [x9]')
  }

  emit('.text', '.global _start')
  lines.push('_start:')
  emit(`mov x15, #${int(16)}`)
  for (let i = 0; i < n; i++) {
    const k = r() * 100
    if (int(25) === 0) {
      // A forward branch over a few items.
      const cond = pick(['b.eq', 'b.ne', 'b.lt', 'b.hs', 'b.mi', 'b.gt'])
      emit(int(3) ? `${cond} F${i}` : int(2) ? `cbz x${int(29)}, F${i}` : `tbnz x${int(29)}, #${int(64)}, F${i}`)
      for (let j = int(4); j > 0; j--) word(SCALAR)
      lines.push(`F${i}:`)
    }
    if (k < 30) word(SCALAR)
    else if (k < 45) word(MEMORY)
    else if (k < 57) {
      if (!useSve || !word(SVE)) word(SCALAR)
    } else if (k < 65) {
      if (!useSme || !word(SME)) word(MEMORY)
    } else if (k < 69) mode()
    else if (k < 74) sysreg()
    else if (k < 80) system()
    else if (k < 86) libc()
    else if (k < 89) fault()
    else if (k < 91) input()
    else if (k < 93) exclusive()
    else word(SCALAR)
  }
  emit('mov x0, #0', 'mov x8, #93', 'svc #0')
  lines.push('    .section .rodata')
  FORMATS.forEach((f, i) => lines.push(`fmt${i}: .asciz "${f}"`))
  lines.push('str0: .asciz "hello, undo"', 'num0: .asciz "  -1234xyz"', 'scanfmt: .asciz "%ld %ld"', 'scanfmt2: .asciz "%d"', 'fname0: .asciz "a.txt"', 'fname1: .asciz "./b.bin"')
  lines.push('    .balign 16', 'ts: .quad 0, 1000000')
  lines.push('    .data', '    .balign 16', `buf: .quad ${Array.from({ length: 32 }, () => `0x${int(2 ** 32).toString(16)}${int(2 ** 32).toString(16).padStart(8, '0')}`).join(', ')}`, '    .skip 8192')
  lines.push('    .section .ktext, "ax"', '    .balign 2048', 'vectors:')
  // Skip the faulting instruction; an instruction abort (a call to nowhere) returns to x30 instead.
  for (const at of [0, 0x200, 0x400]) {
    lines.push(`    .balign ${at === 0 ? 2048 : 0x200}`)
    emit('mrs x17, esr_el1', 'ubfx x17, x17, #26, #6', 'cmp x17, #0x20', `b.eq R${at}`, 'cmp x17, #0x22', `b.eq R${at}`)
    emit('mrs x17, elr_el1', 'add x17, x17, #4', 'msr elr_el1, x17')
    if (handlerKind === 1) emit('mrs x16, esr_el1', 'and x16, x15, #15', 'msr zcr_el1, x16', 'msr smcr_el1, x16', 'add x15, x15, #5')
    if (handlerKind === 2) emit('mrs x16, spsr_el1', 'eor x16, x16, #0x40000000', 'msr spsr_el1, x16', 'mrs x16, far_el1')
    emit('eret')
    lines.push(`R${at}:`)
    emit('msr elr_el1, x30', 'eret')
  }
  return { seed, text: lines.join('\n') + '\n', vl, svl }
}

/* ------------------------------------------------------------------ the checks */

const MAX_STEPS = 2600

interface Track {
  m: ArmMachine
  env: QuietEnv
  pages: PageWatch
}

function build(c: ArmCase): Track {
  const res = arm64.assemble({ name: 'fuzz.s', text: c.text }, {})
  if (!res.ok) throw new Error(`seed ${c.seed}: ${JSON.stringify(res.diagnostics.slice(0, 3))}`)
  const env = new QuietEnv()
  const m = arm64.createMachine(res.program!, env, { settings: { vl: c.vl, svl: c.svl } }) as ArmMachine
  return { m, env, pages: new PageWatch(m) }
}

/** The line typed when the program waits at step k (the same in every pass). */
const inputFor = (seed: number, k: number) => {
  const r = rng(seed * 7919 + k)
  return r() < 0.15 ? '' : `${Math.floor(r() * 2000) - 1000} ${Math.floor(r() * 99)}x`
}

/** Type lines while the step at index k waits (an empty line can leave scanf waiting for more). */
function feed(t: Track, seed: number, k: number): StepInfo | null {
  let info: StepInfo | null = null
  for (let attempt = 0; t.m.pending && attempt < 20; attempt++) {
    expect(t.m.pending.kind).toBe('line')
    t.m.resolve(inputFor(seed, k * 32 + attempt))
    info = t.m.step()
  }
  expect(t.m.pending).toBeNull()
  return info
}

/** One step, typing the lines it waits for. Returns the info of the completing step. */
function stepWithInput(t: Track, seed: number, k: number): StepInfo {
  const info = t.m.step()
  return feed(t, seed, k) ?? info
}

interface Stats {
  programs: number
  steps: number
  undos: number
  waits: number
  faults: number
  runs: number
  internal: string[]
  ends: Record<string, number>
  /** Steps run in Streaming SVE mode, with ZA on, and exceptions by class. */
  streaming: number
  za: number
  ec: Record<string, number>
}

function check(c: ArmCase, stats: Stats): void {
  const t = build(c)
  const { m, env } = t
  const where = (s: string) => `seed ${c.seed} (vl ${c.vl}, svl ${c.svl}): ${s}`
  const same = (got: string, want: string, s: string) => {
    if (got !== want) expect.fail(where(`${s}\n${diff(got, want)}`))
  }
  const snaps = [at(t, 0)]
  const outputs: string[] = []
  const infos: string[] = []
  // Forward, with occasional excursions: undo a few steps and redo them; undo while waiting for input.
  const r = rng(c.seed ^ 0x5eed)
  while (!m.halted && infos.length < MAX_STEPS) {
    const k = infos.length
    let info: StepInfo
    try {
      info = m.step()
    } catch (e) {
      // A fault in the simulator itself (reported separately): the machine must be left as it was.
      const ins = m.program.instructions.find((i) => i.addr === m.programCounter)
      stats.internal.push(`seed ${c.seed} (vl ${c.vl}, svl ${c.svl}) step ${k}, ${ins?.basic} with svcr ${m.readRegister(SVCR)}, smcr ${m.readRegister(SMCR_EL1)}: ${String(e).slice(0, 120)}`)
      same(at(t, k), snaps[k]!, `state after an internal error at step ${k}`)
      break
    }
    if (m.pending) {
      stats.waits++
      if (k > 0 && r() < 0.4) {
        // Undo while waiting (with or without the line typed): back to the state before the previous step.
        if (r() < 0.5) m.resolve(inputFor(c.seed, k * 32))
        const u = m.undo()
        expect(u?.output).toBe(outputs[k - 1])
        env.output = env.output.slice(0, env.output.length - outputs[k - 1]!.length)
        same(at(t, k - 1), snaps[k - 1]!, `undo while waiting at step ${k}`)
        const again = stepWithInput(t, c.seed, k - 1)
        same(infoText(again), infos[k - 1]!, `redo of step ${k - 1} after undo while waiting`)
        same(at(t, k), snaps[k]!, `state after redo of step ${k - 1}`)
        info = m.step()
        expect(m.pending).not.toBeNull()
      }
      info = feed(t, c.seed, k)!
    }
    if (info.nextPc >= 2 ** 48 && info.pc < 2 ** 48) {
      stats.faults++
      const ec = (Number(m.readRegister(ESR_EL1)) >>> 26).toString(16)
      stats.ec[ec] = (stats.ec[ec] ?? 0) + 1
    }
    if (priv(m).smv) stats.streaming++
    if (priv(m).zav) stats.za++
    infos.push(infoText(info))
    outputs.push(info.output)
    expect(env.output.length).toBe(outputs.reduce((n, o) => n + o.length, 0))
    snaps.push(at(t, infos.length))
    if (r() < 0.02 && infos.length > 1) {
      const back = 1 + Math.floor(r() * Math.min(infos.length, 30))
      const top = infos.length
      for (let j = 1; j <= back; j++) {
        const u = m.undo()
        expect(u?.output).toBe(outputs[top - j])
        env.output = env.output.slice(0, env.output.length - outputs[top - j]!.length)
        same(at(t, top - j), snaps[top - j]!, `excursion undo to ${top - j}`)
      }
      for (let j = top - back; j < top; j++) {
        same(infoText(stepWithInput(t, c.seed, j)), infos[j]!, `excursion redo of step ${j}`)
        same(at(t, j + 1), snaps[j + 1]!, `excursion state ${j + 1}`)
      }
    }
  }
  const n = infos.length
  stats.steps += n
  const end = m.halted ? (m.halted.kind === 'error' ? m.halted.code : m.halted.kind) : 'limit'
  stats.ends[end] = (stats.ends[end] ?? 0) + 1
  const finalFull = snapshot(m, env, t.pages, true)
  const finalMem = t.pages.exact()
  // Undo everything the log keeps; one more undo is refused and changes nothing.
  const lo = Math.max(0, n - 2000)
  // At the oldest kept state the step before it is forgotten, so ZA shows no rows written by it.
  const oldest = (text: string) => (lo > 0 ? text.replace(/^rows=.*$/m, '') : text)
  for (let k = n; k > lo; k--) {
    const u = m.undo()
    expect(u?.output).toBe(outputs[k - 1])
    env.output = env.output.slice(0, env.output.length - outputs[k - 1]!.length)
    const got = at(t, k - 1)
    same(k - 1 === lo ? oldest(got) : got, k - 1 === lo ? oldest(snaps[k - 1]!) : snaps[k - 1]!, `undo to step ${k - 1}`)
    stats.undos++
  }
  expect(m.canUndo).toBe(false)
  expect(m.undo()).toBeNull()
  same(oldest(at(t, lo)), oldest(snaps[lo]!), 'state after a refused undo')
  // Replay: every step repeats exactly.
  for (let k = lo; k < n; k++) {
    same(infoText(stepWithInput(t, c.seed, k)), infos[k]!, `replay of step ${k}`)
    same(at(t, k + 1), snaps[k + 1]!, `replayed state ${k + 1}`)
  }
  same(snapshot(m, env, t.pages, true), finalFull, 'final state after replay (all register bytes)')
  expect(t.pages.exact()).toBe(finalMem)
  // Run in slices with breakpoints: every stop equals the stepped state at the same count.
  const t2 = build(c)
  const addrs = t2.m.program.instructions.map((i) => i.addr)
  const bps = new Set<number>()
  for (let i = r() * 6; i >= 1; i--) bps.add(addrs[Math.floor(r() * addrs.length)]!)
  let skip = true
  for (let guard = 0; guard < 10_000 && !t2.m.halted && t2.m.steps < n; guard++) {
    const res = t2.m.run(Math.min(1 + Math.floor(r() * 400), n - t2.m.steps), bps, skip)
    stats.runs++
    const k = t2.m.steps
    // A machine waiting for input is the stepped state plus the request.
    const waiting = (text: string) => (res.stop === 'waiting' ? text.replace(/^(pendingReq|state)=.*$/gm, '') : text)
    same(waiting(at(t2, k)), waiting(snaps[k]!), `run stopped (${res.stop}) at step ${k}`)
    expect(t2.env.output).toBe(outputs.slice(0, k).join(''))
    if (res.stop === 'waiting') {
      feed(t2, c.seed, k)
      same(at(t2, k + 1), snaps[k + 1]!, `step after input at ${k}`)
      skip = false
    } else skip = res.stop === 'breakpoint'
  }
  if (t2.m.steps === n) same(snapshot(t2.m, t2.env, t2.pages, true), finalFull, 'final state of the run')
  stats.programs++
}

describe('AArch64 undo and replay on random programs', () => {
  const count = Number(process.env.UNDO_FUZZ ?? 40)
  const first = Number(process.env.UNDO_SEED ?? 1)
  it(`restores every state, replays every step and runs like it steps (${count} programs)`, () => {
    const stats: Stats = { programs: 0, steps: 0, undos: 0, waits: 0, faults: 0, runs: 0, internal: [], ends: {}, streaming: 0, za: 0, ec: {} }
    for (let s = first; s < first + count; s++) check(armProgram(s), stats)
    if (process.env.UNDO_FUZZ) console.log(stats)
    expect(stats.programs).toBe(count)
  }, 600_000)
})

/* ------------------------------------------------------------------ regressions */

function machine(text: string, settings: Record<string, number> = {}): Track {
  return build({ seed: 0, text, vl: settings.vl ?? 256, svl: settings.svl ?? 512 })
}

/** Step to the end (or to a wait), with a snapshot of every state. */
function stepAll(t: Track, limit = 10_000): string[] {
  const snaps = [at(t, 0)]
  while (!t.m.halted && !t.m.pending && snaps.length <= limit) {
    t.m.step()
    if (!t.m.pending) snaps.push(at(t, snaps.length))
  }
  return snaps
}

describe('AArch64 undo regressions', () => {
  it('keeps the oldest undo record when a step waits for input with the log full', () => {
    const t = machine(`_start:
      mov x19, #0
1:    add x19, x19, #1
      cmp x19, #1100
      b.ne 1b
      mov x0, #0
      adr x1, buf
      mov x2, #4
      mov x8, #63
      svc #0
      mov x8, #93
      svc #0
      .data
buf:  .skip 16
`)
    const snaps = stepAll(t)
    expect(t.m.pending?.kind).toBe('line')
    const n = snaps.length - 1
    expect(n).toBeGreaterThan(2000)
    // Undo while waiting gives up the wait and the step before it; 1999 more reach the oldest kept state.
    for (let k = n - 1; k >= n - 2000; k--) {
      expect(t.m.undo()).not.toBeNull()
      expect(at(t, k)).toBe(snaps[k])
    }
    expect(t.m.undo()).toBeNull()
    expect(t.m.steps).toBe(n - 2000)
  })

  it('remembers the target of a bad branch, which names the fault the next step takes', () => {
    const t = machine(`_start:
      ldr x9, =0x0001000000000000
      br x9
      mov x8, #93
      svc #0
      .section .ktext, "ax"
      .balign 2048
vectors:
      .skip 0x200
      mrs x11, far_el1
      mov x8, #93
      svc #0
      .balign 0x200
      ldr x10, =0x0002000000000000
      br x10
`)
    const snaps = stepAll(t)
    expect(t.m.halted?.kind).toBe('exit')
    expect(t.m.readRegister(11)).toBe(0x0002000000000000n)
    // Back to just after the first bad branch: the fault it takes must name its own target again.
    while (t.m.steps > 2) t.m.undo()
    expect(at(t, 2)).toBe(snaps[2])
    t.m.step()
    expect(at(t, 3)).toBe(snaps[3])
    expect(t.m.readRegister(FAR_EL1)).toBe(0x0001000000000000n)
  })

  it('takes back file opens, writes, seeks and closes, and the file store with them', () => {
    const t = machine(`_start:
      mov x0, #-100
      adr x1, name
      mov x2, #0102
      mov x8, #56
      svc #0
      mov x20, x0
      adr x1, text
      mov x2, #5
      mov x8, #64
      svc #0
      mov x0, x20
      mov x1, #1
      mov x2, #0
      mov x8, #62
      svc #0
      mov x0, x20
      adr x1, text
      mov x2, #2
      mov x8, #64
      svc #0
      mov x0, x20
      mov x8, #57
      svc #0
      mov x8, #93
      svc #0
      .data
name: .asciz "u.txt"
text: .ascii "hello"
`)
    const snaps = stepAll(t)
    expect(new TextDecoder().decode(t.env.files.read('u.txt')!)).toBe('hhelo')
    for (let k = snaps.length - 2; k >= 0; k--) {
      t.m.undo()
      expect(at(t, k)).toBe(snaps[k])
    }
    expect(t.env.files.list()).toEqual([])
    expect(stepAll(t)).toEqual(snaps)
  })

  it('takes back a step that fails inside the simulator, leaving the machine as it was', () => {
    const t = machine(`_start:
      adr x0, buf
      mov w1, #0x41
      mov x2, #32
      bl memset
      mov x8, #93
      svc #0
      .data
buf:  .skip 64
`)
    for (let i = 0; i < 3; i++) t.m.step()
    const before = at(t, 3)
    // Make the fourth byte memset stores fail, as a bug in an instruction or the C library would.
    const mem = priv(t.m).mem
    const setByte = mem.setByte
    let calls = 0
    mem.setByte = (a: number, v: number) => {
      if (++calls === 4) throw new Error('injected')
      setByte(a, v)
    }
    expect(() => t.m.step()).toThrow('injected')
    expect(at(t, 3)).toBe(before)
    mem.setByte = setByte
    t.m.step()
    expect(t.m.readByte(Number(t.m.program.symbols.buf) + 31)).toBe(0x41)
    t.m.undo()
    expect(at(t, 3)).toBe(before)
  })

  it('restarts with a new vector length, and runs like it steps after the change', () => {
    const text = `_start:
      ptrue p0.b
      index z0.b, #1, #3
      cntb x1
      smstart
      cntb x2
      zero {za}
      mov w12, #0
      mova za0h.b[w12, 0], p0/m, z0.b
      smstop
      mov x8, #93
      svc #0
`
    for (const [vl, svl] of [[128, 2048], [2048, 128], [512, 512]]) {
      const a = machine(text, { vl, svl })
      const snaps = stepAll(a)
      expect(a.m.readRegister(1)).toBe(BigInt(vl / 8))
      expect(a.m.readRegister(2)).toBe(BigInt(svl / 8))
      const b = machine(text, { vl, svl })
      b.m.run(1000, new Set())
      expect(at(b, snaps.length - 1)).toBe(snaps.at(-1))
      for (let k = snaps.length - 2; k >= 0; k--) {
        a.m.undo()
        expect(at(a, k)).toBe(snaps[k])
      }
    }
  })
})

describe('AArch64 session: settings, reset and breakpoints', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('restarts with a changed setting, resets, and steps back from a breakpoint to the stepped states', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const c = armProgram(seed)
      const s = new Session(arm64, { name: 'r.s', text: c.text }, { now: () => 1_750_000_000_000 })
      s.setGranularity('instruction')
      s.step()
      s.step()
      // A new vector length starts the program again.
      s.setSetting('vl', c.vl)
      s.setSetting('svl', c.svl)
      expect(s.machine!.steps).toBe(0)
      expect(s.console).toEqual([])
      const ref = build(c)
      const snaps = [at(ref, 0)]
      for (let k = 0; !ref.m.halted && k < 3000; k++) {
        stepWithInput(ref, c.seed, k)
        snaps.push(at(ref, k + 1))
      }
      const env = { files: { files: priv(s.files).map } } as unknown as QuietEnv
      let pages = new PageWatch(s.machine as ArmMachine)
      const here = () => snapshot(s.machine as ArmMachine, env, pages, s.machine!.steps % 32 === 0)
      expect(here()).toBe(snaps[0])
      const lines = s.result!.program!.instructions.filter((i) => i.addr < 2 ** 48).map((i) => i.line)
      const r = rng(seed)
      s.setBreakpoints(Array.from({ length: 3 }, () => lines[Math.floor(r() * lines.length)]!))
      for (let guard = 0; guard < 30 && !s.halted && s.machine!.steps < snaps.length - 1; guard++) {
        s.run()
        vi.runAllTimers()
        // Lines typed at the same step count are its attempts, as in stepWithInput.
        for (let n = 0, at = -1, a = 0; s.pending && n < 40; n++) {
          a = s.machine!.steps === at ? a + 1 : 0
          at = s.machine!.steps
          s.submit(inputFor(c.seed, at * 32 + a))
          vi.runAllTimers()
        }
        if (s.machine!.steps < snaps.length) expect(here()).toBe(snaps[s.machine!.steps])
        for (let j = Math.floor(r() * 3); j > 0 && s.machine!.canUndo; j--) {
          s.back()
          if (s.machine!.steps < snaps.length) expect(here()).toBe(snaps[s.machine!.steps])
        }
      }
      // Reset gives the starting state again (files the program wrote stay, as on a disk).
      s.reset()
      pages = new PageWatch(s.machine as ArmMachine)
      const noFiles = (text: string) => text.replace(/^vfs=.*$/m, '')
      expect(noFiles(here())).toBe(noFiles(snaps[0]!))
    }
  })
})
