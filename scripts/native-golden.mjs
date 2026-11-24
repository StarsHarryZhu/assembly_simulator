#!/usr/bin/env node
/**
 * native-golden — regenerate tests/arm64/golden/native/*.json by running instructions on this Mac's CPU
 * (the AArch64 behaviour oracle). Needs an Apple silicon Mac with clang; `npm test` only reads the result.
 *
 *   node scripts/native-golden.mjs
 *   ONLY=sve,sve2 node scripts/native-golden.mjs   (just those groups)
 *
 * Cases come from scripts/native/cases.ts. Each becomes a function in a generated cases.s that loads the
 * registers and NZCV, runs the instruction word, and stores them back; scripts/native/harness.c runs them
 * all with a 256-byte buffer and catches faults. Per catalog group the fixture holds
 * `{ cases: [[text, word, seed, ptr, small, signal, nzcv, regs, memory, fpcr, vregs, fpsr]] }`: the signal
 * name or null, the NZCV after, the registers that changed (`n: value`, buffer pointers as `p<offset>`),
 * the buffer bytes that changed (`[offset, byte]`), the FPCR the case ran with, the vector registers that
 * changed (`n: hex`) and FPSR after (it starts at 0).
 *
 * The SVE groups run in streaming mode (this CPU has SVE only there) through scripts/native/sve-harness.c,
 * at the CPU's streaming vector length, with a larger buffer. Their fixtures are
 * `{ vl, buf, cases: [[text, word, seed, ptr, small, signal, nzcv, regs, memory, fpcr, zregs, pregs, fpsr]] }`
 * with the Z and P registers that changed; cases that streaming mode forbids (SIGILL) are left out.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport } from 'vite'

if (platform() !== 'darwin' || arch() !== 'arm64') {
  console.error('native-golden runs on an Apple silicon Mac only')
  process.exit(1)
}
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'tests', 'arm64', 'golden', 'native')
const CLANG = process.env.CLANG ?? 'clang'
const SIGNALS = { 4: 'sigill', 5: 'sigtrap', 10: 'sigbus', 11: 'sigsegv' }

const { module: lib } = await runnerImport(join(ROOT, 'scripts', 'native', 'cases.ts'), { root: ROOT, logLevel: 'error', configFile: false })
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
const wanted = (group) => !only || only.has(group)
mkdirSync(OUT, { recursive: true })
if (!only) for (const name of readdirSync(OUT)) if (name.endsWith('.json')) rmSync(join(OUT, name))
const cases = lib.nativeCases().filter((c) => wanted(c.group))
const states = cases.map((c) => lib.initialState(c.seed, c.ptr, c.small))
const vstates = cases.map((c) => lib.vectorState(c.seed))
const M64 = (1n << 64n) - 1n
/** A register's starting value as the fixtures write it: buffer pointers as p<offset>. */
const repr = (s, ptr, n) => (ptr.includes(n) ? `p${s.x[n]}` : s.x[n].toString(16))
const tmp = mkdtempSync(join(tmpdir(), 'native-golden-'))
const unsupported = new Set()
if (cases.length) runBase()
await runSve()
// SIGILL means the CPU lacks the feature, or chose UNDEFINED for an UNPREDICTABLE register choice; check which.
if (unsupported.size) console.log(`SIGILL on this CPU: ${[...unsupported].join(', ')}`)
rmSync(tmp, { recursive: true, force: true })

function runBase() {
  // The case functions: save callee-saved registers (x19–x30, d8–d15), load the state (FPCR and FPSR first,
  // then v0–v31 through x1, then NZCV and the general registers), run the word, store everything back.
  const vecs = (op, base) => [0, 4, 8, 12, 16, 20, 24, 28].map((n) => `${op} {v${n}.16b-v${n + 3}.16b}, [${base}], #64`)
  const asm = ['.text']
  cases.forEach((c, i) => {
    asm.push(`.globl _case_${i}`, `.p2align 2`, `_case_${i}:`, 'sub sp, sp, #176')
    for (let r = 19; r < 30; r += 2) asm.push(`stp x${r}, x${r + 1}, [sp, #${(r - 19) * 8}]`)
    for (let r = 8; r < 16; r += 2) asm.push(`stp d${r}, d${r + 1}, [sp, #${112 + (r - 8) * 8}]`)
    asm.push('str x0, [sp, #96]', 'ldr x1, [x0, #256]', 'msr fpcr, x1', 'ldr x1, [x0, #264]', 'msr fpsr, x1', 'add x1, x0, #272', ...vecs('ld1', 'x1'))
    asm.push('ldr x1, [x0, #248]', 'msr nzcv, x1')
    for (let r = 2; r <= 30; r++) if (r !== 18) asm.push(`ldr x${r}, [x0, #${r * 8}]`)
    asm.push('ldp x0, x1, [x0]', `.inst 0x${c.word.toString(16).padStart(8, '0')}`)
    asm.push('stp x0, x1, [sp, #-16]!', 'ldr x1, [sp, #112]')
    for (let r = 2; r <= 30; r++) if (r !== 18) asm.push(`str x${r}, [x1, #${r * 8}]`)
    asm.push('mrs x2, nzcv', 'str x2, [x1, #248]', 'mrs x2, fpsr', 'str x2, [x1, #264]', 'add x2, x1, #272', ...vecs('st1', 'x2'))
    asm.push('ldp x2, x3, [sp], #16', 'stp x2, x3, [x1]', 'msr fpcr, xzr')
    for (let r = 19; r < 30; r += 2) asm.push(`ldp x${r}, x${r + 1}, [sp, #${(r - 19) * 8}]`)
    for (let r = 8; r < 16; r += 2) asm.push(`ldp d${r}, d${r + 1}, [sp, #${112 + (r - 8) * 8}]`)
    asm.push('add sp, sp, #176', 'ret')
  })
  writeFileSync(join(tmp, 'cases.s'), asm.join('\n') + '\n')

  const hex = (v) => '0x' + v.toString(16) + 'ULL'
  const h = [`#define CASE_COUNT ${cases.length}`, `#define BUF_BYTES ${lib.BUF_SIZE}`]
  cases.forEach((_, i) => h.push(`extern void case_${i}(State *) __asm__("_case_${i}");`))
  h.push(`static const uint64_t INPUT_X[][31] = {${states.map((s) => `{${s.x.map(hex).join(',')}}`).join(',\n')}};`)
  h.push(`static const uint32_t INPUT_PTR[] = {${cases.map((c) => c.ptr.reduce((m, n) => m | (1 << n), 0) >>> 0).join(',')}};`)
  h.push(`static const uint8_t INPUT_NZCV[] = {${states.map((s) => s.nzcv).join(',')}};`)
  h.push(`static const uint64_t INPUT_FPCR[] = {${cases.map((c) => c.fpcr).join(',')}};`)
  h.push(`static const uint64_t INPUT_V[][32][2] = {${vstates.map((v) => `{${v.v.map((x) => `{${hex(x & M64)},${hex(x >> 64n)}}`).join(',')}}`).join(',\n')}};`)
  h.push(`static const uint8_t INPUT_MEM[][${lib.BUF_SIZE}] = {${states.map((s) => `{${[...s.memory].join(',')}}`).join(',\n')}};`)
  h.push(`static const CaseFn CASES[] = {${cases.map((_, i) => `case_${i}`).join(',')}};`)
  writeFileSync(join(tmp, 'inputs.h'), h.join('\n') + '\n')
  copyFileSync(join(ROOT, 'scripts', 'native', 'harness.c'), join(tmp, 'harness.c'))

  execFileSync(CLANG, ['-O1', '-arch', 'arm64', '-I', tmp, join(tmp, 'harness.c'), join(tmp, 'cases.s'), '-o', join(tmp, 'harness')])
  const out = execFileSync(join(tmp, 'harness'), { maxBuffer: 1 << 28 }).toString()

  const byGroup = new Map()
  for (const line of out.trim().split('\n')) {
    const parts = line.split(' ')
    const i = Number(parts[0])
    const c = cases[i]
    const s = states[i]
    const signal = SIGNALS[Number(parts[1])] ?? (Number(parts[1]) ? `signal ${parts[1]}` : null)
    if (signal === 'sigill') unsupported.add(c.text.split(' ')[0])
    const regs = {}
    for (let n = 0; n < 31; n++) {
      const v = parts[3 + n].startsWith('p') ? parts[3 + n] : BigInt('0x' + parts[3 + n]).toString(16)
      if (v !== repr(s, c.ptr, n)) regs[n] = v
    }
    const mem = parts[34]
    const memory = []
    for (let b = 0; b < lib.BUF_SIZE; b++) {
      const v = parseInt(mem.slice(2 * b, 2 * b + 2), 16)
      if (v !== s.memory[b]) memory.push([b, v])
    }
    const fpsr = parseInt(parts[35], 16)
    const vregs = {}
    for (let n = 0; n < 32; n++) {
      const v = BigInt('0x' + parts[36 + n])
      if (v !== vstates[i].v[n]) vregs[n] = v.toString(16)
    }
    const list = byGroup.get(c.group) ?? []
    list.push([c.text, '0x' + c.word.toString(16).padStart(8, '0'), c.seed, c.ptr, c.small, signal, Number(parts[2]), regs, memory, c.fpcr, vregs, fpsr])
    byGroup.set(c.group, list)
  }
  for (const [group, list] of byGroup) {
    writeFileSync(join(OUT, `${group}.json`), JSON.stringify({ cases: list }) + '\n')
    console.log(`${group}: ${list.length} cases`)
  }
}

/** The SVE groups, in streaming mode. */
async function runSve() {
  if (![...lib.SVE_GROUPS].some(wanted)) return
  // The C part is built for the plain CPU: with SVE enabled clang would vectorise its loops with SVE, which
  // this CPU runs only in streaming mode. The cases name the features in the assembly instead.
  const FLAGS = ['-O1', '-arch', 'arm64', '-I', tmp]
  const shared = [
    '.arch armv9.4-a+sme2p1+sve2p1',
    '.text',
    '.globl _streaming_vl',
    '_streaming_vl:',
    'rdsvl x0, #1',
    'ret',
    // x0: the State. Enter streaming mode, load p0–p15 and z0–z31, then FPCR and FPSR (smstart resets FPSR,
    // and macOS can restore the streaming state lazily on the first vector access, FPSR included).
    '_load_zp:',
    'smstart sm',
    'add x1, x0, #784',
    ...Array.from({ length: 32 }, (_, n) => `ldr z${n}, [x1, #${n}, mul vl]`),
    'add x1, x0, #272',
    ...Array.from({ length: 16 }, (_, n) => `ldr p${n}, [x1, #${n}, mul vl]`),
    'ldr x1, [x0, #256]',
    'msr fpcr, x1',
    'ldr x1, [x0, #264]',
    'msr fpsr, x1',
    'ret',
    // x1: the State. Store FPSR, z0–z31 and p0–p15, then leave streaming mode.
    '_store_zp:',
    'mrs x2, fpsr',
    'str x2, [x1, #264]',
    'add x2, x1, #784',
    ...Array.from({ length: 32 }, (_, n) => `str z${n}, [x2, #${n}, mul vl]`),
    'add x2, x1, #272',
    ...Array.from({ length: 16 }, (_, n) => `str p${n}, [x2, #${n}, mul vl]`),
    'smstop sm',
    'ret',
  ]
  // The streaming vector length first: the cases' states depend on it.
  writeFileSync(join(tmp, 'sve-cases.s'), shared.join('\n') + '\n')
  writeFileSync(join(tmp, 'sve-cases.h'), '#define CASE_COUNT 0\nstatic const CaseFn CASES[] = {0};\n')
  copyFileSync(join(ROOT, 'scripts', 'native', 'sve-harness.c'), join(tmp, 'sve-harness.c'))
  execFileSync(CLANG, [...FLAGS, join(tmp, 'sve-harness.c'), join(tmp, 'sve-cases.s'), '-o', join(tmp, 'sve-harness')])
  const vl = Number(execFileSync(join(tmp, 'sve-harness')).toString().trim())
  const sve = lib.sveCases(vl).filter((c) => wanted(c.group))
  const inputs = sve.map((c) => lib.sveInputs(c.seed, c.ptr, c.small, vl))

  const asm = [...shared]
  sve.forEach((c, i) => {
    asm.push(`.globl _sve_case_${i}`, '.p2align 2', `_sve_case_${i}:`, 'sub sp, sp, #176')
    for (let r = 19; r < 30; r += 2) asm.push(`stp x${r}, x${r + 1}, [sp, #${(r - 19) * 8}]`)
    for (let r = 8; r < 16; r += 2) asm.push(`stp d${r}, d${r + 1}, [sp, #${112 + (r - 8) * 8}]`)
    asm.push('str x0, [sp, #96]', 'bl _load_zp', 'ldr x1, [x0, #248]', 'msr nzcv, x1')
    for (let r = 2; r <= 30; r++) if (r !== 18) asm.push(`ldr x${r}, [x0, #${r * 8}]`)
    asm.push('ldp x0, x1, [x0]', `.inst 0x${c.word.toString(16).padStart(8, '0')}`)
    asm.push('stp x0, x1, [sp, #-16]!', 'ldr x1, [sp, #112]')
    for (let r = 2; r <= 30; r++) if (r !== 18) asm.push(`str x${r}, [x1, #${r * 8}]`)
    asm.push('mrs x2, nzcv', 'str x2, [x1, #248]', 'bl _store_zp', 'ldp x2, x3, [sp], #16', 'stp x2, x3, [x1]', 'msr fpcr, xzr')
    for (let r = 19; r < 30; r += 2) asm.push(`ldp x${r}, x${r + 1}, [sp, #${(r - 19) * 8}]`)
    for (let r = 8; r < 16; r += 2) asm.push(`ldp d${r}, d${r + 1}, [sp, #${112 + (r - 8) * 8}]`)
    asm.push('add sp, sp, #176', 'ret')
  })
  writeFileSync(join(tmp, 'sve-cases.s'), asm.join('\n') + '\n')
  const h = [`#define CASE_COUNT ${sve.length}`]
  sve.forEach((_, i) => h.push(`extern void sve_case_${i}(State *) __asm__("_sve_case_${i}");`))
  h.push(`static const CaseFn CASES[] = {${sve.map((_, i) => `sve_case_${i}`).join(',')}};`)
  writeFileSync(join(tmp, 'sve-cases.h'), h.join('\n') + '\n')

  // The inputs, little-endian, in the order sve-harness.c reads them.
  const le = (v, bytes) => {
    const b = Buffer.alloc(bytes)
    for (let i = 0; i < bytes; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn)
    return b
  }
  const parts = [Buffer.from(new Uint32Array([sve.length, vl, lib.SVE_BUF, 0]).buffer)]
  sve.forEach((c, i) => {
    const { state, sve: zs, fpcr } = inputs[i]
    for (const x of state.x) parts.push(le(x, 8))
    parts.push(Buffer.from(new Uint32Array([c.ptr.reduce((m, n) => m | (1 << n), 0) >>> 0, state.nzcv]).buffer), le(BigInt(fpcr), 8))
    for (const p of zs.p) parts.push(le(p, vl / 8))
    for (const z of zs.z) parts.push(le(z, vl))
    parts.push(Buffer.from(state.memory))
  })
  writeFileSync(join(tmp, 'sve-inputs.bin'), Buffer.concat(parts))
  execFileSync(CLANG, [...FLAGS, join(tmp, 'sve-harness.c'), join(tmp, 'sve-cases.s'), '-o', join(tmp, 'sve-harness')])
  const out = execFileSync(join(tmp, 'sve-harness'), [join(tmp, 'sve-inputs.bin')], { maxBuffer: 1 << 30 }).toString()

  const byGroup = new Map()
  const illegal = new Map()
  for (const line of out.trim().split('\n')) {
    const parts = line.split(' ')
    const i = Number(parts[0])
    const c = sve[i]
    const { state: s, sve: zs } = inputs[i]
    const signal = SIGNALS[Number(parts[1])] ?? (Number(parts[1]) ? `signal ${parts[1]}` : null)
    if (signal === 'sigill') {
      const m = c.text.split(' ')[0]
      illegal.set(m, (illegal.get(m) ?? 0) + 1)
      continue
    }
    const regs = {}
    for (let n = 0; n < 31; n++) {
      const v = parts[3 + n].startsWith('p') ? parts[3 + n] : BigInt('0x' + parts[3 + n]).toString(16)
      if (v !== repr(s, c.ptr, n)) regs[n] = v
    }
    const mem = parts[34]
    const memory = []
    for (let b = 0; b < lib.SVE_BUF; b++) {
      const v = parseInt(mem.slice(2 * b, 2 * b + 2), 16)
      if (v !== s.memory[b]) memory.push([b, v])
    }
    const fpsr = parseInt(parts[35], 16)
    const zregs = {}
    for (let n = 0; n < 32; n++) {
      const v = BigInt('0x' + parts[36 + n])
      if (v !== zs.z[n]) zregs[n] = v.toString(16)
    }
    const pregs = {}
    for (let n = 0; n < 16; n++) {
      const v = BigInt('0x' + parts[68 + n])
      if (v !== zs.p[n]) pregs[n] = v.toString(16)
    }
    const list = byGroup.get(c.group) ?? []
    list.push([c.text, '0x' + c.word.toString(16).padStart(8, '0'), c.seed, c.ptr, c.small, signal, Number(parts[2]), regs, memory, c.fpcr, zregs, pregs, fpsr])
    byGroup.set(c.group, list)
  }
  for (const [group, list] of byGroup) {
    writeFileSync(join(OUT, `${group}.json`), JSON.stringify({ vl, buf: lib.SVE_BUF, cases: list }) + '\n')
    console.log(`${group}: ${list.length} cases (streaming, VL ${vl * 8} bits)`)
  }
  if (illegal.size) console.log(`Illegal in streaming mode (SIGILL, left out): ${[...illegal].map(([m, n]) => `${m}×${n}`).join(', ')}`)
}
