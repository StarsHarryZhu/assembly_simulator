/**
 * Machine-state consistency of the MIPS machine and of the IDE session: random programs (integer, HI/LO,
 * unaligned memory, floating point, traps, sbrk, typed input, dialogs, files, seeded random streams, and
 * exceptions taken by a .ktext handler) are stepped with a full-state snapshot before every step, undone
 * step by step, replayed, and run in slices with breakpoints; every state must match. The session is
 * checked the same way through its own controls, by line and by instruction.
 *
 * UNDO_FUZZ=<count> (and UNDO_SEED=<first seed>) runs more programs than the default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DialogRequest, DialogResponse, Environment, InputRequest, StepInfo } from '../../src/core/isa'
import { Session } from '../../src/core/session'
import { mips } from '../../src/isa/mips'
import type { MipsMachine } from '../../src/isa/mips/cpu'
import { REGISTER_COUNT } from '../../src/isa/mips/registers'
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

function digest(b: Uint8Array): string {
  let h1 = 0x811c9dc5
  let h2 = 0x2545f491
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!
    h1 = Math.imul(h1 ^ x, 0x01000193)
    h2 = Math.imul(h2 ^ x, 0x5bd1e995) ^ (h2 >>> 15)
  }
  return `${b.length}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`
}

/** The machine's store counts word by word (it keeps one count per word in each 4 KB page; 0 is never). */
function wordCounts(pages: Map<number, Uint32Array>): Map<number, number> {
  const out = new Map<number, number>()
  for (const [key, page] of pages) page.forEach((n, i) => n && out.set((key * 4096 + i * 4) >>> 0, n))
  return out
}

/** An order-independent digest of a map of numbers to numbers (the words written and how often). */
function mapDigest(map: Map<number, number>): string {
  let sum = 0
  let mix = 0
  for (const [k, v] of map) {
    const h = Math.imul(k ^ Math.imul(v, 0x85ebca6b), 0xc2b2ae35)
    sum = (sum + h) | 0
    mix ^= Math.imul(h ^ (h >>> 16), 0x27d4eb2d)
  }
  return `${map.size}:${sum >>> 0}:${mix >>> 0}`
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? digest(x) : x))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (m: object) => m as unknown as Record<string, any>

/** The IDE's file store can delete a file (undoing a step that created one does). */
class Files extends MemoryFiles {
  remove(name: string) {
    this.files.delete(name)
  }
}

/** A console like the IDE's: input and dialogs never answer synchronously, the clock stands still. */
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

/** Page digests, rehashing only pages written through the memory's two primitive writers since the last call. */
class PageWatch {
  private dirty = new Set<number>()
  private pages = new Map<number, string>()
  constructor(private m: MipsMachine) {}
  private attach() {
    const mem = priv(this.m).mem
    if (mem.__watched) return
    mem.__watched = true
    this.pages.clear()
    const setByte = mem.setByte.bind(mem)
    const setWord = mem.setWord.bind(mem)
    mem.setByte = (a: number, v: number) => {
      this.dirty.add((a >>> 0) >>> 12)
      setByte(a, v)
    }
    mem.setWord = (a: number, v: number) => {
      this.dirty.add((a >>> 0) >>> 12)
      this.dirty.add(((a + 3) >>> 0) >>> 12)
      setWord(a, v)
    }
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
}

const objText = (v: unknown) => (v === null || typeof v !== 'object' ? String(v) : json(v))

/** Everything a step may change; with `full`, also what the panels read through the Machine interface. */
function snapshot(m: MipsMachine, env: QuietEnv, pages: PageWatch, full = false): string {
  const p = priv(m)
  const out = [
    `gpr=${p.gpr.join(',')} hi=${p.hiReg} lo=${p.loReg}`,
    `fpr=${p.fpr.join(',')} fcc=${p.fccBits} c0=${p.c0Regs.join(',')}`,
    `pc=${p.pcReg} steps=${p.stepCount} halt=${objText(p.haltReason)}`,
    `pendingReq=${objText(p.pendingReq)}`,
    `provided=${objText(p.provided)}`,
    `status=${p.status.join('')}`,
    `heap=${p.heapTop} ${json(p.blocks)}`,
    `randoms=${[...p.randoms].map(([id, r]: [number, object]) => `${id}:${json(r)}`).join(' ')}`,
    `files=${p.openFiles.size ? json([...p.openFiles].map(([fd, f]: [number, { data: Uint8Array; length: number }]) => [fd, { ...f, data: digest(f.data.subarray(0, f.length)) }])) : ''}`,
    `written=${mapDigest(wordCounts(p.written))}`,
    `mem=${pages.text()}`,
    `vfs=${env.files.files.size ? [...env.files.files].sort().map(([n, d]) => `${n}:${digest(d)}`).join(' ') : ''}`,
  ]
  if (full) {
    out.push(`regs=${Array.from({ length: REGISTER_COUNT }, (_, id) => m.readRegister(id)).join(',')}`)
    out.push(`colours=${Array.from({ length: REGISTER_COUNT }, (_, id) => m.registerStatus(id)).join('')}`)
    out.push(`state=${m.state} pc=${m.programCounter} blocks=${json(m.heapBlocks())} words=${m.writtenWords().length}`)
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

/* ------------------------------------------------------------------ random programs */

const POOL = ['$t0', '$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7', '$t8', '$t9', '$s0', '$s1', '$s2', '$s3', '$s4', '$v1', '$a1', '$a2', '$a3']

/** Random programs in the style of the MARS differential runs, plus sbrk, input, dialogs, files and random streams. */
function mipsProgram(seed: number): string {
  const r = rng(seed)
  const int = (n: number) => Math.floor(r() * n)
  const pick = <T>(a: readonly T[]): T => a[int(a.length)]!
  const R = () => pick(POOL)
  const fr = () => `$f${int(32)}`
  const dr = () => `$f${int(16) * 2}`
  const s16 = () => int(65536) - 32768
  const u16 = () => int(65536)
  const v32 = () => {
    const k = int(8)
    if (k === 0) return pick([0, 1, -1, 0x7fffffff, -0x80000000, 0x8000, 0xffff, -32768, 32767])
    if (k < 3) return int(200) - 100
    return int(2 ** 32) | 0
  }
  const fval = () => (int(10) === 0 ? pick(['0.0', '-0.0', '1.0', '-1.5', '3.4e38', '1.0e-40', '0.1']) : ((r() - 0.5) * 10 ** (int(12) - 6)).toPrecision(int(9) + 1))
  const L: string[] = ['.data', 'D: .word ' + Array.from({ length: 64 }, v32).join(', ')]
  L.push('F: .float ' + Array.from({ length: 16 }, fval).join(', '), '.align 3', 'G: .double ' + Array.from({ length: 8 }, fval).join(', '))
  L.push('BUF: .space 64', 'S: .asciiz "random run"', 'N0: .asciiz "a.txt"', 'N1: .asciiz "b.dat"', 'Q: .asciiz "value? "')
  L.push('.text', 'main:', '    la $s7, D', '    la $s6, F', '    la $s5, G')
  for (const x of POOL) L.push(`    li ${x}, ${v32()}`)
  for (let i = 0; i < 8; i++) L.push(`    lwc1 $f${i * 2 + 1}, ${int(16) * 4}($s6)`, `    ldc1 $f${i * 2}, ${int(8) * 8}($s5)`)
  const n = r() < 0.12 ? 900 + int(400) : 60 + int(200)
  const body: string[] = []
  const e = (...l: string[]) => body.push(...l.map((s) => `    ${s}`))
  for (let i = 0; i < n; i++) {
    body.push(`L${i}:`)
    const k = int(100)
    const ahead = () => `L${Math.min(n, i + 1 + int(6))}`
    if (k < 18) e(`${pick(['addu', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu', 'sllv', 'srlv', 'srav', 'mul', 'movn', 'movz', 'add', 'sub'])} ${R()}, ${R()}, ${R()}`)
    else if (k < 24) e(`${pick(['sll', 'srl', 'sra'])} ${R()}, ${R()}, ${int(32)}`)
    else if (k < 30) {
      const op = pick(['addiu', 'addi', 'andi', 'ori', 'xori', 'slti', 'sltiu', 'lui'])
      e(op === 'lui' ? `lui ${R()}, ${u16()}` : `${op} ${R()}, ${R()}, ${['andi', 'ori', 'xori'].includes(op) ? u16() : s16()}`)
    } else if (k < 36) {
      const op = pick(['mult', 'multu', 'div', 'divu', 'madd', 'maddu', 'msub', 'msubu', 'mfhi', 'mflo', 'mthi', 'mtlo', 'clz', 'clo'])
      e(['mfhi', 'mflo', 'mthi', 'mtlo'].includes(op) ? `${op} ${R()}` : `${op} ${R()}, ${R()}`)
    } else if (k < 42) {
      const p = int(6)
      if (p === 0) e(`li ${R()}, ${v32()}`)
      else if (p === 1) e(`rem ${R()}, ${R()}, ${R()}`)
      else if (p === 2) e(`${pick(['seq', 'sne', 'sge', 'sgt', 'sle', 'sgeu'])} ${R()}, ${R()}, ${R()}`)
      else if (p === 3) e(`${pick(['ror', 'rol'])} ${R()}, ${R()}, ${int(32)}`)
      else if (p === 4) e(`${pick(['mulo', 'mulou', 'remu', 'divu'])} ${R()}, ${R()}, ${R()}`)
      else e(`${pick(['beq', 'bne', 'blt', 'bgt', 'ble', 'bge'])} ${R()}, ${s16()}, ${ahead()}`)
    } else if (k < 54) {
      const p = int(6)
      const mis = int(12) === 0
      if (p === 0) e(`${pick(['lw', 'sw'])} ${R()}, ${int(64) * 4 + (mis ? 1 + int(3) : 0)}($s7)`)
      else if (p === 1) e(`${pick(['lh', 'lhu', 'sh'])} ${R()}, ${int(128) * 2 + (mis ? 1 : 0)}($s7)`)
      else if (p === 2) e(`${pick(['lb', 'lbu', 'sb'])} ${R()}, ${int(256)}($s7)`)
      else if (p === 3) e(`${pick(['lwl', 'lwr', 'swl', 'swr'])} ${R()}, ${int(250)}($s7)`)
      else if (p === 4) e(`${pick(['ulw', 'usw', 'ulh', 'ulhu', 'ush'])} ${R()}, ${int(250)}($s7)`)
      else e(`${pick(['lwc1', 'swc1'])} ${fr()}, ${int(64) * 4 + (mis ? 2 : 0)}($s7)`, `${pick(['ldc1', 'sdc1'])} ${dr()}, ${int(32) * 8 + (mis ? 4 : 0)}($s7)`)
    } else if (k < 66) {
      const p = int(8)
      const sd = pick(['s', 'd'])
      const f = sd === 's' ? fr : dr
      if (p < 3) e(`${pick(['add', 'sub', 'mul', 'div'])}.${sd} ${f()}, ${f()}, ${f()}`)
      else if (p === 3) e(`${pick(['sqrt', 'abs', 'neg', 'mov'])}.${sd} ${f()}, ${f()}`)
      else if (p === 4) e(`${pick(['c.eq', 'c.lt', 'c.le'])}.${sd} ${int(8)}, ${f()}, ${f()}`)
      else if (p === 5) e(`${pick(['movt', 'movf'])} ${R()}, ${R()}, ${int(8)}`)
      else if (p === 6) e(`${pick(['mtc1', 'mfc1'])} ${R()}, ${fr()}`)
      else e(`${pick(['bc1t', 'bc1f'])} ${int(8)}, ${ahead()}`)
    } else if (k < 70) e(`${pick(['beq', 'bne'])} ${R()}, ${R()}, ${ahead()}`)
    else if (k < 73) e(int(2) ? `${pick(['teq', 'tne', 'tge', 'tlt'])} ${R()}, ${R()}` : `${pick(['teqi', 'tnei', 'tgei', 'tlti'])} ${R()}, ${s16()}`)
    else if (k < 80) {
      const p = int(6)
      const x = R()
      if (p === 0) e('li $v0, 1', `move $a0, ${x}`, 'syscall')
      else if (p === 1) e('li $v0, 34', `move $a0, ${x}`, 'syscall')
      else if (p === 2) e('li $v0, 2', `mov.s $f12, ${fr()}`, 'syscall')
      else if (p === 3) e('li $v0, 3', `mov.d $f12, ${dr()}`, 'syscall')
      else if (p === 4) e('li $v0, 4', 'la $a0, S', 'syscall')
      else e('li $v0, 11', 'li $a0, 10', 'syscall')
    } else if (k < 84) {
      // sbrk, then a store into the new block (and sometimes a request that fails).
      e('li $v0, 9', `li $a0, ${pick([0, 1, 7, 64, 4096, 100000, -4, 0x7ffffff0])}`, 'syscall', `sw ${R()}, 0($v0)`)
    } else if (k < 88) {
      // Typed input, and the dialogs.
      const p = int(9)
      if (p === 0) e('li $v0, 5', 'syscall', `move ${R()}, $v0`)
      else if (p === 1) e('li $v0, 6', 'syscall')
      else if (p === 2) e('li $v0, 7', 'syscall')
      else if (p === 3) e('li $v0, 8', 'la $a0, BUF', `li $a1, ${int(20)}`, 'syscall')
      else if (p === 4) e('li $v0, 12', 'syscall', `move ${R()}, $v0`)
      else if (p === 5) e('li $v0, 14', 'li $a0, 0', 'la $a1, BUF', `li $a2, ${int(30)}`, 'syscall')
      else if (p === 6) e(`li $v0, ${pick([50, 51, 52, 53])}`, 'la $a0, Q', 'syscall')
      else if (p === 7) e('li $v0, 54', 'la $a0, Q', 'la $a1, BUF', `li $a2, ${int(20)}`, 'syscall')
      else e(`li $v0, ${pick([55, 56, 57, 58, 59])}`, 'la $a0, Q', 'la $a1, S', 'li $a1, 1', 'syscall')
    } else if (k < 92) {
      // Files: open (read, write, append), write, read, close; the descriptor lives in $fp.
      const p = int(4)
      if (p === 0) e('li $v0, 13', `la $a0, N${int(2)}`, `li $a1, ${pick([0, 1, 9, 9, 1, 0, 5])}`, 'li $a2, 0', 'syscall', 'move $fp, $v0')
      else if (p === 1) e('li $v0, 15', int(3) ? 'move $a0, $fp' : `li $a0, ${3 + int(2)}`, 'la $a1, D', `li $a2, ${int(40)}`, 'syscall')
      else if (p === 2) e('li $v0, 14', int(3) ? 'move $a0, $fp' : `li $a0, ${3 + int(2)}`, `addiu $a1, $s7, ${int(32) * 4}`, `li $a2, ${int(40)}`, 'syscall')
      else e('li $v0, 16', int(3) ? 'move $a0, $fp' : `li $a0, ${3 + int(2)}`, 'syscall')
    } else if (k < 96) {
      // Random streams: seed, int, bounded int, float, double; stream ids 0-2.
      const p = int(5)
      e(`li $a0, ${int(3)}`)
      if (p === 0) e(`li $a1, ${v32()}`, 'li $v0, 40', 'syscall')
      else if (p === 1) e('li $v0, 41', 'syscall', `move ${R()}, $a0`)
      else if (p === 2) e(`li $a1, ${pick([1, 7, 100, 0, -3])}`, 'li $v0, 42', 'syscall', `move ${R()}, $a0`)
      else e(`li $v0, ${pick([43, 44])}`, 'syscall')
    } else e(pick(['li $v0, 30', 'li $v0, 32\n    li $a0, 1', 'li $v0, 99', 'li $v0, 36\n    move $a0, $t0']), 'syscall')
  }
  body.push(`L${n}:`, '    li $v0, 10', '    syscall')
  L.push(...body)
  L.push('.ktext 0x80000180', '    mfc0 $k0, $13', '    addu $k1, $k1, $k0', '    mfc0 $k0, $14', '    addiu $k0, $k0, 4', '    mtc0 $k0, $14', '    eret')
  return L.join('\n') + '\n'
}

/** The answer typed at step k, attempt a, to a request (the same in every pass). */
function answer(seed: number, k: number, req: InputRequest): string | number | DialogResponse {
  const r = rng(seed * 7919 + k)
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!
  if (req.kind === 'char') return pick([65, 10, 0x4e2d, 0x7f, 48 + Math.floor(r() * 10)])
  if (req.kind === 'line') {
    if (req.purpose === 'int') return pick(['42', '-7', ' 12 ', 'x', '99999999999', '０１２'])
    if (req.purpose === 'float' || req.purpose === 'double') return pick(['3.25', '-1e10', 'NaN', 'abc', '0x1.8p3', '1e-45'])
    return pick(['', 'hello', 'a much longer line of typed text', '中文'])
  }
  if (req.kind === 'dialog') {
    const d: DialogRequest = req.dialog
    if (d.type === 'confirm') return { type: 'confirm', choice: pick(['yes', 'no', 'cancel'] as const) }
    if (d.type === 'input') return { type: 'input', text: pick([null, '', '17', '2.5', 'text', 'NaN']) }
    return { type: 'message' }
  }
  return ''
}

/* ------------------------------------------------------------------ machine checks */

const MAX_STEPS = 2600

interface Track {
  m: MipsMachine
  env: QuietEnv
  pages: PageWatch
}

function build(text: string): Track {
  const res = mips.assemble({ name: 'fuzz.asm', text }, {})
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics.slice(0, 3)))
  const env = new QuietEnv()
  const m = mips.createMachine(res.program!, env) as MipsMachine
  return { m, env, pages: new PageWatch(m) }
}

const at = (t: Track, k: number) => snapshot(t.m, t.env, t.pages, k % 32 === 0)

function feed(t: Track, seed: number, k: number): StepInfo | null {
  let info: StepInfo | null = null
  for (let attempt = 0; t.m.pending && attempt < 20; attempt++) {
    t.m.resolve(answer(seed, k * 32 + attempt, t.m.pending))
    info = t.m.step()
  }
  expect(t.m.pending).toBeNull()
  return info
}

function stepWithInput(t: Track, seed: number, k: number): StepInfo {
  const info = t.m.step()
  return feed(t, seed, k) ?? info
}

interface Stats {
  programs: number
  steps: number
  undos: number
  waits: number
  handled: number
  runs: number
  ends: Record<string, number>
}

function check(seed: number, stats: Stats): void {
  const text = mipsProgram(seed)
  const t = build(text)
  const { m, env } = t
  const same = (got: string, want: string, s: string) => {
    if (got !== want) expect.fail(`seed ${seed}: ${s}\n${diff(got, want)}`)
  }
  const snaps = [at(t, 0)]
  const outputs: string[] = []
  const infos: string[] = []
  const r = rng(seed ^ 0x5eed)
  while (!m.halted && infos.length < MAX_STEPS) {
    const k = infos.length
    let info = m.step()
    if (m.pending) {
      stats.waits++
      if (k > 0 && r() < 0.4) {
        if (r() < 0.5) m.resolve(answer(seed, k * 32, m.pending))
        const u = m.undo()
        expect(u?.output).toBe(outputs[k - 1])
        env.output = env.output.slice(0, env.output.length - outputs[k - 1]!.length)
        same(at(t, k - 1), snaps[k - 1]!, `undo while waiting at step ${k}`)
        same(json(stepWithInput(t, seed, k - 1)), infos[k - 1]!, `redo of step ${k - 1} after undo while waiting`)
        same(at(t, k), snaps[k]!, `state after redo of step ${k - 1}`)
        info = m.step()
        expect(m.pending).not.toBeNull()
      }
      info = feed(t, seed, k)!
    }
    if (info.nextPc === 0x80000180 && info.pc !== 0x80000180) stats.handled++
    infos.push(json(info))
    outputs.push(info.output)
    expect(env.output.length).toBe(outputs.reduce((n, o) => n + o.length, 0))
    snaps.push(at(t, infos.length))
    if (r() < 0.02 && infos.length > 1) {
      const back = 1 + Math.floor(r() * Math.min(infos.length, 30))
      const top = infos.length
      for (let j = 1; j <= back; j++) {
        expect(m.undo()?.output).toBe(outputs[top - j])
        env.output = env.output.slice(0, env.output.length - outputs[top - j]!.length)
        same(at(t, top - j), snaps[top - j]!, `excursion undo to ${top - j}`)
      }
      for (let j = top - back; j < top; j++) {
        same(json(stepWithInput(t, seed, j)), infos[j]!, `excursion redo of step ${j}`)
        same(at(t, j + 1), snaps[j + 1]!, `excursion state ${j + 1}`)
      }
    }
  }
  const n = infos.length
  stats.steps += n
  const end = m.halted ? (m.halted.kind === 'error' ? m.halted.code : m.halted.kind) : 'limit'
  stats.ends[end] = (stats.ends[end] ?? 0) + 1
  const finalFull = snapshot(m, env, t.pages, true)
  const lo = Math.max(0, n - 2000)
  for (let k = n; k > lo; k--) {
    expect(m.undo()?.output).toBe(outputs[k - 1])
    env.output = env.output.slice(0, env.output.length - outputs[k - 1]!.length)
    same(at(t, k - 1), snaps[k - 1]!, `undo to step ${k - 1}`)
    stats.undos++
  }
  expect(m.canUndo).toBe(false)
  expect(m.undo()).toBeNull()
  same(at(t, lo), snaps[lo]!, 'state after a refused undo')
  for (let k = lo; k < n; k++) {
    same(json(stepWithInput(t, seed, k)), infos[k]!, `replay of step ${k}`)
    same(at(t, k + 1), snaps[k + 1]!, `replayed state ${k + 1}`)
  }
  same(snapshot(m, env, t.pages, true), finalFull, 'final state after replay')
  // Run in slices with breakpoints.
  const t2 = build(text)
  const addrs = t2.m.program.instructions.map((i) => i.addr)
  const bps = new Set<number>()
  for (let i = r() * 6; i >= 1; i--) bps.add(addrs[Math.floor(r() * addrs.length)]!)
  let skip = true
  for (let guard = 0; guard < 10_000 && !t2.m.halted && t2.m.steps < n; guard++) {
    const res = t2.m.run(Math.min(1 + Math.floor(r() * 400), n - t2.m.steps), bps, skip)
    stats.runs++
    const k = t2.m.steps
    const waiting = (s: string) => (res.stop === 'waiting' ? s.replace(/^(pendingReq|state)=.*$/gm, '') : s)
    same(waiting(at(t2, k)), waiting(snaps[k]!), `run stopped (${res.stop}) at step ${k}`)
    expect(t2.env.output).toBe(outputs.slice(0, k).join(''))
    if (res.stop === 'waiting') {
      feed(t2, seed, k)
      same(at(t2, k + 1), snaps[k + 1]!, `step after input at ${k}`)
      skip = false
    } else skip = res.stop === 'breakpoint'
  }
  if (t2.m.steps === n) same(snapshot(t2.m, t2.env, t2.pages, true), finalFull, 'final state of the run')
  stats.programs++
}

describe('MIPS undo and replay on random programs', () => {
  const count = Number(process.env.UNDO_FUZZ ?? 40)
  const first = Number(process.env.UNDO_SEED ?? 1)
  it(`restores every state, replays every step and runs like it steps (${count} programs)`, () => {
    const stats: Stats = { programs: 0, steps: 0, undos: 0, waits: 0, handled: 0, runs: 0, ends: {} }
    for (let s = first; s < first + count; s++) check(s, stats)
    if (process.env.UNDO_FUZZ) console.log(stats)
    expect(stats.programs).toBe(count)
  }, 600_000)
})

/* ------------------------------------------------------------------ regressions */

function stepAll(t: Track, limit = 10_000): string[] {
  const snaps = [at(t, 0)]
  while (!t.m.halted && !t.m.pending && snaps.length <= limit) {
    t.m.step()
    if (!t.m.pending) snaps.push(at(t, snaps.length))
  }
  return snaps
}

function undoAll(t: Track, snaps: string[]): void {
  for (let k = snaps.length - 2; k >= 0; k--) {
    expect(t.m.undo()).not.toBeNull()
    expect(at(t, k)).toBe(snaps[k])
  }
}

describe('MIPS undo regressions', () => {
  it('takes back random numbers: a seeded stream and one the step created from the clock', () => {
    const t = build(`main:
      li $a0, 1
      li $a1, 42
      li $v0, 40
      syscall
      li $v0, 41
      syscall
      move $t0, $a0
      li $a0, 2
      li $a1, 1000
      li $v0, 42
      syscall
      li $v0, 10
      syscall
`)
    const snaps = stepAll(t)
    undoAll(t, snaps)
    expect(priv(t.m).randoms.size).toBe(0)
    expect(stepAll(t)).toEqual(snaps)
    // Undo just the draws and draw again: the same numbers.
    const first = t.m.readRegister(8)
    for (let i = 0; i < 8; i++) t.m.undo()
    while (!t.m.halted) t.m.step()
    expect(t.m.readRegister(8)).toBe(first)
    expect(at(t, snaps.length - 1)).toBe(snaps.at(-1))
  })

  it('takes back file opens, writes and closes, and the file store with them', () => {
    const t = build(`.data
name: .asciiz "o.txt"
text: .ascii "hello"
.text
main:
      li $v0, 13
      la $a0, name
      li $a1, 1
      syscall
      move $s0, $v0
      li $v0, 15
      move $a0, $s0
      la $a1, text
      li $a2, 5
      syscall
      li $v0, 16
      move $a0, $s0
      syscall
      li $v0, 13
      la $a0, name
      li $a1, 9
      syscall
      move $s0, $v0
      li $v0, 15
      move $a0, $s0
      la $a1, text
      li $a2, 2
      syscall
      li $v0, 10
      syscall
`)
    const snaps = stepAll(t)
    expect(new TextDecoder().decode(t.env.files.read('o.txt')!)).toBe('hellohe')
    undoAll(t, snaps)
    expect(t.env.files.list()).toEqual([])
    expect(stepAll(t)).toEqual(snaps)
  })

  it('keeps the oldest undo record when a step waits for input with the log full', () => {
    const t = build(`main:
      li $t0, 0
loop: addi $t0, $t0, 1
      blt $t0, 1100, loop
      li $v0, 5
      syscall
      li $v0, 10
      syscall
`)
    const snaps = stepAll(t)
    expect(t.m.pending?.kind).toBe('line')
    const n = snaps.length - 1
    expect(n).toBeGreaterThan(2000)
    for (let k = n - 1; k >= n - 2000; k--) {
      expect(t.m.undo()).not.toBeNull()
      expect(at(t, k)).toBe(snaps[k])
    }
    expect(t.m.undo()).toBeNull()
    expect(t.m.steps).toBe(n - 2000)
  })

  it('takes back a step that fails inside the simulator, leaving the machine as it was', () => {
    const t = build(`.data
buf: .space 32
.text
main:
      li $v0, 8
      la $a0, buf
      li $a1, 20
      syscall
      li $v0, 10
      syscall
`)
    for (let i = 0; i < 5; i++) t.m.step()
    expect(t.m.pending?.kind).toBe('line')
    t.m.resolve('abcdefgh')
    const before = at(t, 4)
    const mem = priv(t.m).mem
    const setByte = mem.setByte
    let calls = 0
    mem.setByte = (a: number, v: number) => {
      if (++calls === 4) throw new Error('injected')
      setByte(a, v)
    }
    expect(() => t.m.step()).toThrow('injected')
    // Only the typed line is still there, waiting to be used.
    expect(at(t, 4).replace(/^provided=.*$/m, '')).toBe(before.replace(/^provided=.*$/m, ''))
    mem.setByte = setByte
    feed(t, 0, 0)
    expect(t.m.readByte(0x10010000 + 3)).not.toBe(0)
  })
})

/* ------------------------------------------------------------------ the session */

/** The machine checks' clock, so time and clock-seeded random numbers agree. */
const CLOCK = { now: () => 1_750_000_000_000 }

/** The session's machine state, console and position, for comparing states reached in different ways. */
function sessionState(s: Session, pages: Map<object, PageWatch>): string {
  const m = s.machine as MipsMachine
  if (!pages.has(m)) pages.set(m, new PageWatch(m))
  const env = { files: { files: priv(s.files).map } } as unknown as QuietEnv
  const out = json(s.console)
  return `${snapshot(m, env, pages.get(m)!, true)}\nconsole=${out}\nline=${s.currentLine} mode=${s.mode} pending=${json(s.pending)}`
}

/** Answer what the session's machine waits for (the same answers as the machine checks give). */
function answerSession(s: Session, seed: number, k: number): void {
  for (let attempt = 0; s.pending && attempt < 20; attempt++) {
    const a = answer(seed, k * 32 + attempt, s.pending)
    if (typeof a === 'object') s.answerDialog(a)
    else if (typeof a === 'number') s.submit(String.fromCharCode(a))
    else s.submit(a)
  }
}

describe('Session undo', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  for (const granularity of ['line', 'instruction'] as const) {
    it(`steps back to every state it stepped through (by ${granularity})`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const s = new Session(mips, { name: 'r.asm', text: mipsProgram(seed) }, CLOCK)
        s.setGranularity(granularity)
        const pages = new Map<object, PageWatch>()
        s.step()
        const states: string[] = []
        for (let k = 0; k < 400 && !s.halted; k++) {
          states.push(sessionState(s, pages))
          s.step()
          if (s.pending) answerSession(s, seed, k)
        }
        for (let k = states.length - 1; k >= 0; k--) {
          s.back()
          expect(sessionState(s, pages), `seed ${seed}, back to ${k}`).toBe(states[k])
        }
      }
    })
  }

  it('runs to breakpoints, waits for input in run mode, and steps back to the stepped states', () => {
    const console_ = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let seed = 20; seed <= 32; seed++) {
      const text = mipsProgram(seed)
      // Reference: the machine stepped one instruction at a time.
      const ref = build(text)
      const snaps = [at(ref, 0)]
      while (!ref.m.halted && snaps.length < 3000) {
        stepWithInput(ref, seed, snaps.length - 1)
        snaps.push(at(ref, snaps.length))
      }
      const s = new Session(mips, { name: 'r.asm', text }, CLOCK)
      s.setGranularity('instruction')
      s.assemble()
      const lines = s.result!.program!.instructions.map((i) => i.line)
      const r = rng(seed)
      s.setBreakpoints(Array.from({ length: 4 }, () => lines[Math.floor(r() * lines.length)]!))
      const pages = new PageWatch(s.machine as MipsMachine)
      const env = { files: { files: priv(s.files).map } } as unknown as QuietEnv
      const here = () => snapshot(s.machine as MipsMachine, env, pages, s.machine!.steps % 32 === 0)
      for (let guard = 0; guard < 200 && !s.halted && s.machine!.steps < snaps.length - 1; guard++) {
        s.run()
        vi.runAllTimers()
        const k = s.machine!.steps
        if (s.pending) {
          expect(s.mode).toBe('running')
          // Back while waiting in run mode: the run stops and the state before the previous step returns.
          if (k > 0 && r() < 0.5) {
            s.back()
            expect(s.mode).toBe('idle')
            expect(s.pending).toBeNull()
            expect(here()).toBe(snaps[k - 1])
            continue
          }
          answerSession(s, seed, k)
          vi.runAllTimers()
        }
        if (!s.pending && s.machine!.steps < snaps.length) expect(here()).toBe(snaps[s.machine!.steps])
        // A few steps back from wherever the run stopped.
        const back = Math.floor(r() * 4)
        for (let j = 0; j < back && s.machine!.canUndo; j++) {
          s.back()
          expect(here()).toBe(snaps[s.machine!.steps])
        }
      }
    }
    console_.mockRestore()
  })

  it('stops a run on a fault inside the simulator and keeps the session usable', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = new Session(mips, { name: 'f.asm', text: '.data\nb: .space 8\n.text\nmain:\n li $t0, 7\n la $t1, b\n sb $t0, 0($t1)\n li $v0, 10\n syscall\n' })
    s.assemble()
    const mem = priv(s.machine!).mem
    const setByte = mem.setByte
    mem.setByte = () => {
      throw new Error('injected')
    }
    s.run()
    vi.runAllTimers()
    expect(s.mode).toBe('idle')
    expect(s.console.at(-1)?.kind).toBe('error')
    expect(s.console.at(-1)?.text).toContain('injected')
    expect(s.machine!.halted).toBeNull()
    const pc = s.machine!.programCounter
    expect(s.machine!.lineAt(pc)).toBe(7)
    mem.setByte = setByte
    s.run()
    vi.runAllTimers()
    expect(s.halted?.kind).toBe('exit')
    expect(s.machine!.readByte(0x10010000)).toBe(7)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('reassembles after an edit, and keeps the run when only comments change', () => {
    const text = 'main:\n li $t0, 1 # one\n li $t1, 2\n add $t2, $t0, $t1\n li $v0, 10\n syscall\n'
    const s = new Session(mips, { name: 'e.asm', text })
    s.setGranularity('instruction')
    s.step()
    s.step()
    const m = s.machine
    s.replaceComments(text.replace('# one', '# uno'))
    expect(s.machine).toBe(m)
    s.back()
    expect(s.machine!.steps).toBe(1)
    expect(s.machine!.readRegister(9)).toBe(0)
    s.setSource(text.replace('li $t1, 2', 'li $t1, 5'))
    s.back()
    expect(s.machine).not.toBe(m)
    expect(s.machine!.steps).toBe(0)
    s.run()
    vi.runAllTimers()
    expect(s.machine!.readRegister(10)).toBe(6)
  })
})
