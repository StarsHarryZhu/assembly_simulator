#!/usr/bin/env node
/**
 * native-golden — regenerate tests/arm64/golden/native/*.json by running instructions on this Mac's CPU
 * (the AArch64 behaviour oracle). Needs an Apple silicon Mac with clang; `npm test` only reads the result.
 *
 *   node scripts/native-golden.mjs
 *
 * Cases come from scripts/native/cases.ts. Each becomes a function in a generated cases.s that loads the
 * registers and NZCV, runs the instruction word, and stores them back; scripts/native/harness.c runs them
 * all with a 256-byte buffer and catches faults. Per catalog group the fixture holds
 * `{ cases: [[text, word, seed, ptr, small, signal, nzcv, regs, memory]] }`: the signal name or null, the
 * NZCV after, the registers that changed (`n: value`, buffer pointers as `p<offset>`), and the buffer
 * bytes that changed (`[offset, byte]`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
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
const cases = lib.nativeCases()
const states = cases.map((c) => lib.initialState(c.seed, c.ptr, c.small))
const tmp = mkdtempSync(join(tmpdir(), 'native-golden-'))

// The case functions: save callee-saved registers, load the state, run the word, store the state.
const asm = ['.text']
cases.forEach((c, i) => {
  asm.push(`.globl _case_${i}`, `.p2align 2`, `_case_${i}:`, 'sub sp, sp, #112')
  for (let r = 19; r < 30; r += 2) asm.push(`stp x${r}, x${r + 1}, [sp, #${(r - 19) * 8}]`)
  asm.push('str x0, [sp, #96]', 'ldr x1, [x0, #248]', 'msr nzcv, x1')
  for (let r = 2; r <= 30; r++) if (r !== 18) asm.push(`ldr x${r}, [x0, #${r * 8}]`)
  asm.push('ldp x0, x1, [x0]', `.inst 0x${c.word.toString(16).padStart(8, '0')}`)
  asm.push('stp x0, x1, [sp, #-16]!', 'ldr x1, [sp, #112]')
  for (let r = 2; r <= 30; r++) if (r !== 18) asm.push(`str x${r}, [x1, #${r * 8}]`)
  asm.push('mrs x2, nzcv', 'str x2, [x1, #248]', 'ldp x2, x3, [sp], #16', 'stp x2, x3, [x1]')
  for (let r = 19; r < 30; r += 2) asm.push(`ldp x${r}, x${r + 1}, [sp, #${(r - 19) * 8}]`)
  asm.push('add sp, sp, #112', 'ret')
})
writeFileSync(join(tmp, 'cases.s'), asm.join('\n') + '\n')

const hex = (v) => '0x' + v.toString(16) + 'ULL'
const h = [`#define CASE_COUNT ${cases.length}`, `#define BUF_BYTES ${lib.BUF_SIZE}`]
cases.forEach((_, i) => h.push(`extern void case_${i}(State *) __asm__("_case_${i}");`))
h.push(`static const uint64_t INPUT_X[][31] = {${states.map((s) => `{${s.x.map(hex).join(',')}}`).join(',\n')}};`)
h.push(`static const uint32_t INPUT_PTR[] = {${cases.map((c) => c.ptr.reduce((m, n) => m | (1 << n), 0) >>> 0).join(',')}};`)
h.push(`static const uint8_t INPUT_NZCV[] = {${states.map((s) => s.nzcv).join(',')}};`)
h.push(`static const uint8_t INPUT_MEM[][${lib.BUF_SIZE}] = {${states.map((s) => `{${[...s.memory].join(',')}}`).join(',\n')}};`)
h.push(`static const CaseFn CASES[] = {${cases.map((_, i) => `case_${i}`).join(',')}};`)
writeFileSync(join(tmp, 'inputs.h'), h.join('\n') + '\n')
copyFileSync(join(ROOT, 'scripts', 'native', 'harness.c'), join(tmp, 'harness.c'))

execFileSync(CLANG, ['-O1', '-arch', 'arm64', '-I', tmp, join(tmp, 'harness.c'), join(tmp, 'cases.s'), '-o', join(tmp, 'harness')])
const out = execFileSync(join(tmp, 'harness'), { maxBuffer: 1 << 28 }).toString()

const repr = (s, ptr, n) => (ptr.includes(n) ? `p${s.x[n]}` : s.x[n].toString(16))
const byGroup = new Map()
const unsupported = new Set()
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
  const list = byGroup.get(c.group) ?? []
  list.push([c.text, '0x' + c.word.toString(16).padStart(8, '0'), c.seed, c.ptr, c.small, signal, Number(parts[2]), regs, memory])
  byGroup.set(c.group, list)
}
mkdirSync(OUT, { recursive: true })
for (const name of readdirSync(OUT)) if (name.endsWith('.json')) rmSync(join(OUT, name))
for (const [group, list] of byGroup) {
  writeFileSync(join(OUT, `${group}.json`), JSON.stringify({ cases: list }) + '\n')
  console.log(`${group}: ${list.length} cases`)
}
// SIGILL means the CPU lacks the feature, or chose UNDEFINED for an UNPREDICTABLE register choice; check which.
if (unsupported.size) console.log(`SIGILL on this CPU: ${[...unsupported].join(', ')}`)
rmSync(tmp, { recursive: true, force: true })
