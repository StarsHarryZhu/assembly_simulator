#!/usr/bin/env node
/**
 * mars-golden — regenerate tests/golden/expected/*.json by running MARS 4.5.
 *
 * MARS is only a test oracle: nothing it produces ships with the site. The jar is
 * not in the repository; point MARS_JAR at it (default ~/.cache/assembly-simulator/Mars4_5.jar).
 *
 *   node scripts/mars-golden.mjs              # every program in tests/golden/programs
 *   node scripts/mars-golden.mjs loops traps  # only these (file names without .asm)
 *
 * The IDE's example programs (src/isa/mips/examples) are included as "example-<name>".
 *
 * Per program it records:
 *   assemble.ok / errors      — MARS assembler errors ("line L column C: message")
 *   assemble.text / ktext     — [address, word, source line] for every basic instruction
 *   assemble.data             — .data words from 0x10010000, trailing zeros trimmed
 *   run.stdout                — console output (stdin from <name>.in when present)
 *   run.regs                  — final value of every integer and float register
 *   run.mem                   — words of any address range named by a "# golden: mem=A-B" header
 *
 * Header comments in the program steer the run:
 *   # golden: norun           assemble only
 *   # golden: steps=N         stop after N basic instructions (default 1,000,000)
 *   # golden: mem=0x10010000-0x1001003c
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROGRAMS = join(ROOT, 'tests', 'golden', 'programs')
const EXPECTED = join(ROOT, 'tests', 'golden', 'expected')
// The IDE's example programs are checked too, as "example-<id>"; their stdin lives next to the other programs.
const EXAMPLES = join(ROOT, 'src', 'isa', 'mips', 'examples')

function sourceOf(name) {
  return name.startsWith('example-') ? join(EXAMPLES, `${name.slice(8)}.asm`) : join(PROGRAMS, `${name}.asm`)
}
const JAR = process.env.MARS_JAR || join(homedir(), '.cache', 'assembly-simulator', 'Mars4_5.jar')

if (!existsSync(JAR)) {
  console.error(`mars-golden: MARS jar not found at ${JAR} (set MARS_JAR)`)
  process.exit(1)
}

const INT_REGS = Array.from({ length: 32 }, (_, i) => `$${i}`)
const FLOAT_REGS = Array.from({ length: 32 }, (_, i) => `$f${i}`)
// MARS's command line cannot print HI, LO or the PC; programs move them into general registers instead.

function mars(args, input) {
  const r = spawnSync('java', ['-Djava.awt.headless=true', '-jar', JAR, 'nc', ...args], {
    input: input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) throw r.error
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

function parseErrors(text) {
  const errors = []
  for (const line of text.split('\n')) {
    // MARS omits the column for a few whole-line errors (an unclosed .macro, for example), and
    // writes "line 6->2" for a line inside a macro expanded at line 6.
    const m = line.match(/^Error in .*? line (\d+)(?:->\d+)*(?: column (\d+))?: (.*)$/)
    if (m) errors.push({ line: Number(m[1]), col: m[2] === undefined ? 0 : Number(m[2]), message: m[3] })
  }
  return errors
}

function parseSegmentWindow(text) {
  const rows = []
  let line = 0
  for (const raw of text.split('\n')) {
    const m = raw.match(/^0x([0-9a-f]{8})\s+0x([0-9a-f]{8})\s+(.*)$/i)
    if (!m) continue
    // "basic text" then optionally "<line number>    <source>"; the source column starts at a fixed offset.
    const rest = m[3]
    const src = rest.slice(22).match(/^\s*(\d+)\s/)
    if (src) line = Number(src[1])
    rows.push([parseInt(m[1], 16), parseInt(m[2], 16), line])
  }
  return rows
}

function parseHexWords(text) {
  const words = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 16) >>> 0)
  while (words.length && words[words.length - 1] === 0) words.pop()
  return words
}

function parseRegisterDump(text) {
  const regs = {}
  const mem = {}
  const out = []
  for (const line of text.split('\n')) {
    // Even float registers carry a second column (the double in the pair); the first is the single.
    const r = line.match(/^(\$\w+)\t0x([0-9a-f]{8})(\t0x[0-9a-f]{16})?$/i)
    if (r) {
      regs[r[1].toLowerCase()] = parseInt(r[2], 16) >>> 0
      continue
    }
    const m = line.match(/^Mem\[0x([0-9a-f]{8})\]\t(.*)$/i)
    if (m) {
      let addr = parseInt(m[1], 16)
      for (const w of m[2].trim().split(/\s+/)) {
        mem[`0x${addr.toString(16).padStart(8, '0')}`] = parseInt(w, 16) >>> 0
        addr += 4
      }
      continue
    }
    out.push(line)
  }
  return { regs, mem, rest: out.join('\n') }
}

function headers(source) {
  const h = { norun: false, steps: 0, mem: [] }
  for (const m of source.matchAll(/^#\s*golden:\s*(.+)$/gim)) {
    for (const part of m[1].split(/\s+/)) {
      if (part === 'norun') h.norun = true
      else if (part.startsWith('steps=')) h.steps = Number(part.slice(6))
      else if (part.startsWith('mem=')) h.mem.push(part.slice(4))
    }
  }
  return h
}

function golden(name) {
  const file = sourceOf(name)
  const source = readFileSync(file, 'utf8')
  const h = headers(source)
  const work = mkdtempSync(join(tmpdir(), 'mars-golden-'))
  try {
    const sw = join(work, 'text.txt')
    const kt = join(work, 'ktext.txt')
    const dt = join(work, 'data.txt')
    const asm = mars(['a', 'dump', '.text', 'SegmentWindow', sw, 'dump', '.data', 'HexText', dt, file])
    const errors = parseErrors(asm.stdout + asm.stderr)
    const result = { name, assemble: { ok: errors.length === 0, errors } }
    if (errors.length) return result
    result.assemble.text = existsSync(sw) ? parseSegmentWindow(readFileSync(sw, 'utf8')) : []
    result.assemble.data = existsSync(dt) ? parseHexWords(readFileSync(dt, 'utf8')) : []
    void kt
    if (h.norun) return result

    const input = existsSync(join(PROGRAMS, `${name}.in`)) ? readFileSync(join(PROGRAMS, `${name}.in`), 'utf8') : ''
    // A step cap keeps a runaway program from hanging the script (MARS stops and says so).
    const args = ['me', String(h.steps || 1_000_000), ...INT_REGS, ...FLOAT_REGS, ...h.mem, file]
    const run = mars(args, input)
    // With "me", MARS messages and the final register/memory dump go to stderr; stdout is exactly
    // the program's own output.
    const dump = parseRegisterDump(run.stderr.replace(/\r/g, ''))
    result.run = {
      stdout: run.stdout,
      // Keep fixtures free of this machine's paths.
      messages: dump.rest.trim().split(`${PROGRAMS}/`).join('').split(`${EXAMPLES}/`).join(''),
      regs: dump.regs,
      mem: dump.mem,
    }
    return result
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

mkdirSync(EXPECTED, { recursive: true })
const only = process.argv.slice(2)
const names = [
  ...readdirSync(PROGRAMS).filter((f) => f.endsWith('.asm')).map((f) => basename(f, '.asm')),
  ...readdirSync(EXAMPLES).filter((f) => f.endsWith('.asm')).map((f) => `example-${basename(f, '.asm')}`),
]
  .filter((n) => only.length === 0 || only.includes(n))
  .sort()

for (const name of names) {
  const t0 = Date.now()
  const g = golden(name)
  writeFileSync(join(EXPECTED, `${name}.json`), JSON.stringify(g, null, 1) + '\n')
  const what = g.assemble.ok ? `${g.assemble.text.length} instr${g.run ? ', ran' : ''}` : `${g.assemble.errors.length} error(s)`
  console.log(`mars-golden: ${name} — ${what} (${Date.now() - t0} ms)`)
}
void execFileSync
