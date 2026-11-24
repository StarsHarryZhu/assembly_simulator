#!/usr/bin/env node
/**
 * llvm-golden — regenerate tests/arm64/golden/llvm/*.json with clang and objdump (the AArch64 oracle).
 *
 * Nothing from LLVM ships with the site: this only records what LLVM says about words and lines our own
 * table produces, so `npm test` can compare without clang.
 *
 *   node scripts/llvm-golden.mjs
 *   ONLY=fp,simd node scripts/llvm-golden.mjs   (just those groups)
 *
 * Writes, per catalog group, `{ cases: [[word, addr, text]] }` — LLVM's disassembly of random words inside
 * each of our encodings — and, per instruction class, the same for random words across the class (text
 * null where LLVM finds no instruction). scripts/llvm/asm/<name>.s files become `asm-<name>.json`:
 * `{ lines: [[source, word | null]] }`, the word clang assembles each line to (null for an error).
 * scripts/llvm/programs/<name>.s files become `prog-<name>.json`: `{ sections: { ".text": hex, ... } }`,
 * the bytes clang puts in each section of the object file (so the programs avoid relocations).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport } from 'vite'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'tests', 'arm64', 'golden', 'llvm')
const ASM = join(ROOT, 'scripts', 'llvm', 'asm')
const PROGRAMS = join(ROOT, 'scripts', 'llvm', 'programs')
const CLANG = process.env.CLANG ?? 'clang'
const OBJDUMP = process.env.OBJDUMP ?? 'objdump'
// The features we implement (Armv9.4-A with SVE2.1 and SME2.1); clang then refuses what we leave out.
const FEATURES = 'sve2p1+sme2p1+sme-i16i64+sme-f64f64+sme-b16b16+sme-f16f16+sve-b16b16+cssc+mops+crypto+sha3+sm4+aes+fp16+bf16+i8mm+f32mm+f64mm+sve2-aes+sve2-sha3+sve2-sm4+sve2-bitperm+fp16fml+predres+rng+ssbs+sb+flagm+pauth+bti+rcpc'
const TARGET = ['--target=aarch64-linux-gnu', `-march=armv9.4-a+${FEATURES}`]

const tmp = mkdtempSync(join(tmpdir(), 'llvm-golden-'))

/** Disassemble words at consecutive addresses; returns LLVM's text per word (null for <unknown>). */
function disassemble(words) {
  const src = join(tmp, 'w.s')
  const obj = join(tmp, 'w.o')
  writeFileSync(src, words.map((w) => `.inst 0x${w.toString(16).padStart(8, '0')}`).join('\n') + '\n')
  execFileSync(CLANG, ['-c', ...TARGET, src, '-o', obj])
  const out = execFileSync(OBJDUMP, ['-d', '--no-show-raw-insn', obj], { maxBuffer: 1 << 28 }).toString()
  const texts = new Map()
  for (const line of out.split('\n')) {
    const m = /^\s*([0-9a-f]+):\s+(.*)$/.exec(line)
    if (!m) continue
    const text = m[2].replace(/\t/g, ' ').trim()
    texts.set(parseInt(m[1], 16), text === '<unknown>' ? null : text)
  }
  return words.map((w, i) => [`0x${w.toString(16).padStart(8, '0')}`, i * 4, texts.has(i * 4) ? texts.get(i * 4) : null])
}

/** Assemble lines one per instruction; returns the word for each (null where clang refuses it). */
function assemble(lines) {
  const src = join(tmp, 'a.s')
  const obj = join(tmp, 'a.o')
  // Every line goes in its own numbered section so an error in one leaves the others' places alone.
  writeFileSync(src, lines.map((l, i) => `.section .t${i},"ax"\n${l}`).join('\n') + '\n')
  const r = spawnSync(CLANG, ['-c', ...TARGET, src, '-o', obj], { encoding: 'utf8' })
  const bad = new Set()
  for (const m of r.stderr.matchAll(/a\.s:(\d+):\d+: error/g)) bad.add(Math.floor((Number(m[1]) - 1) / 2))
  if (bad.size) {
    const good = lines.map((l, i) => (bad.has(i) ? '' : l))
    writeFileSync(src, good.map((l, i) => `.section .t${i},"ax"\n${l}`).join('\n') + '\n')
    execFileSync(CLANG, ['-c', ...TARGET, src, '-o', obj])
  } else if (r.status !== 0) throw new Error(r.stderr)
  const out = execFileSync(OBJDUMP, ['-s', obj], { maxBuffer: 1 << 28 }).toString()
  const words = new Map()
  let section = -1
  for (const line of out.split('\n')) {
    const s = /^Contents of section \.t(\d+):/.exec(line)
    if (s) {
      section = Number(s[1])
      continue
    }
    const m = /^\s*0000 ([0-9a-f]{8})/.exec(line)
    if (m && section >= 0 && !words.has(section)) {
      const b = m[1]
      words.set(section, '0x' + b.slice(6, 8) + b.slice(4, 6) + b.slice(2, 4) + b.slice(0, 2))
    }
  }
  return lines.map((l, i) => [l, bad.has(i) ? null : (words.get(i) ?? null)])
}

/** Assemble a whole program; returns the bytes of each section with contents, as hex. */
function sectionBytes(file) {
  const obj = join(tmp, 'p.o')
  execFileSync(CLANG, ['-c', ...TARGET, file, '-o', obj])
  const out = execFileSync(OBJDUMP, ['-s', obj], { maxBuffer: 1 << 28 }).toString()
  const sections = {}
  let name = null
  for (const line of out.split('\n')) {
    const s = /^Contents of section (\S+):/.exec(line)
    if (s) {
      name = /^\.(text|data|rodata)$/.test(s[1]) ? s[1] : null
      if (name) sections[name] = ''
      continue
    }
    const m = /^ [0-9a-f]{4,} ((?:[0-9a-f]{2,8} ?){1,4})/.exec(line)
    if (m && name) sections[name] += m[1].replace(/\s/g, '')
  }
  return sections
}

/** Disassembly plus, for words LLVM prints in a non-canonical way, the word clang assembles its text to. */
function cases_(words) {
  const rows = disassemble(words)
  // PC-relative operands print as addresses (with <…>), which clang would read as offsets: leave them out.
  const todo = rows.filter((r) => r[2] !== null && !r[2].includes('<'))
  const back = assemble(todo.map((r) => r[2].replace(/\/\/.*$/, '').trim()))
  // A fourth element: the canonical word when it differs, or null when clang refuses the text (registers
  // that make the instruction UNPREDICTABLE, for example).
  todo.forEach((r, i) => {
    const w = back[i][1]
    if (w === null || w !== r[0]) r.push(w)
  })
  return rows
}

const { module: cases } = await runnerImport(join(ROOT, 'scripts', 'llvm', 'cases.ts'), { root: ROOT, logLevel: 'error', configFile: false })
mkdirSync(OUT, { recursive: true })
// ONLY=fp,simd regenerates just those groups and leaves every other fixture alone.
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
if (!only) for (const name of readdirSync(OUT)) if (name.endsWith('.json')) rmSync(join(OUT, name))
for (const { group, words } of [...cases.wordCases(), ...cases.classCases(), ...cases.sysCases()]) {
  if (only && !only.has(group)) continue
  writeFileSync(join(OUT, `${group}.json`), JSON.stringify({ cases: cases_(words) }, null, 0) + '\n')
  console.log(`${group}: ${words.length} words`)
}
if (existsSync(ASM) && !only) {
  for (const file of readdirSync(ASM).filter((f) => f.endsWith('.s'))) {
    const lines = readFileSync(join(ASM, file), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
    writeFileSync(join(OUT, `asm-${file.replace(/\.s$/, '')}.json`), JSON.stringify({ lines: assemble(lines) }, null, 0) + '\n')
    console.log(`asm ${file}: ${lines.length} lines`)
  }
}
if (existsSync(PROGRAMS) && !only) {
  for (const file of readdirSync(PROGRAMS).filter((f) => f.endsWith('.s'))) {
    writeFileSync(join(OUT, `prog-${file.replace(/\.s$/, '')}.json`), JSON.stringify({ sections: sectionBytes(join(PROGRAMS, file)) }, null, 0) + '\n')
    console.log(`program ${file}`)
  }
}
rmSync(tmp, { recursive: true, force: true })
