/**
 * The C library and the Linux system calls against glibc and the kernel. Expected values come from the host
 * C library where it agrees with glibc (differential runs of random printf and sscanf calls), and otherwise
 * from glibc's and Linux's documented behaviour: printf's (nil), (null), %p flags and -nan, scanf's EOF
 * rules and partial %c, strtol's invalid bases, srandom's seeding, and the system calls' errors.
 */
import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/isa/arm64/assembler'
import { createMachine } from '../../src/isa/arm64/cpu'
import { F128, parseFloatBits } from '../../src/isa/arm64/fpformat'
import { LIBC } from '../../src/isa/arm64/libc'
import { INITIAL_OS, type Host, type OsState } from '../../src/isa/arm64/linux'
import { ConsoleEnv } from '../helpers'

/* ------------------------------------------------------------------ calling the library directly */

class TestHost implements Host {
  mem = new Map<number, number>()
  os: OsState = INITIAL_OS
  output = ''
  env = new ConsoleEnv()
  x = () => 0n
  setX() {}
  load(addr: bigint, size: number) {
    let v = 0n
    for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.mem.get(Number(addr) + i) ?? 0)
    return v
  }
  store(addr: bigint, size: number, v: bigint) {
    for (let i = 0; i < size; i++) this.mem.set(Number(addr) + i, Number((v >> BigInt(8 * i)) & 0xffn))
  }
  peekByte = () => 10
  nextByte = () => 10
  out(text: string) {
    this.output += text
  }
  sleep() {}
  exit() {}
  abort(code: string, message: string): never {
    throw new Error(`${code}: ${message}`)
  }
  put(addr: number, text: string) {
    const bytes = new TextEncoder().encode(text)
    bytes.forEach((b, i) => this.mem.set(addr + i, b))
    this.mem.set(addr + bytes.length, 0)
    return BigInt(addr)
  }
  string(addr: number) {
    const out: number[] = []
    for (let a = addr; this.mem.get(a); a++) out.push(this.mem.get(a)!)
    return String.fromCharCode(...out)
  }
}

/** Call a library function: integer arguments (strings are placed in memory), fp registers, stack slots. */
function call(h: TestHost, name: string, ints: (bigint | number | string)[], fps: bigint[] = [], stack: bigint[] = []) {
  let at = 0x40000
  const xs = ints.map((v) => (typeof v === 'string' ? h.put((at += 0x1000), v) : BigInt.asUintN(64, BigInt(v))))
  // Integer arguments past the eighth go on the stack, before any given stack slots.
  const slots = [...xs.slice(8), ...stack]
  const slot = (i: number) => slots[i] ?? 0n
  const args = Object.assign((i: number) => (i < 8 ? xs[i] ?? 0n : slot(i - 8)), { fp: (i: number) => fps[i] ?? 0n, stack: slot })
  const r = LIBC.find((f) => f.name === name)!.run(h, args)
  return r === null ? null : BigInt.asIntN(64, r)
}

const BUF = 0x10000
const f64 = (v: number) => new BigUint64Array(new Float64Array([v]).buffer)[0]!

/** snprintf into a 4 KB buffer: [result, text]. */
function sp(fmt: string, ints: (bigint | number | string)[] = [], fps: bigint[] = [], size = 4096): [number, string] {
  const h = new TestHost()
  const r = call(h, 'snprintf', [BUF, size, fmt, ...ints], fps)
  return [Number(r), h.string(BUF)]
}

describe('printf', () => {
  it('prints pointers as glibc does: (nil), and %#lx keeping the + and space flags', () => {
    expect(sp('[%p|%10p|%-7p|%.2p]', [0, 0, 0, 0])[1]).toBe('[(nil)|     (nil)|(nil)  |(nil)]')
    expect(sp('[%p|%+p|% p|%010p|%.8p|%#p]', [0x1234, 0x1234, 0x1234, 0x1234, 0x1234, 0x1234])[1]).toBe('[0x1234|+0x1234| 0x1234|0x00001234|0x00001234|0x1234]')
  })

  it('prints a NULL string as (null), or nothing when the precision is shorter', () => {
    expect(sp('[%s|%.6s|%.3s|%8.3s|%-8s]', [0, 0, 0, 0, 0])[1]).toBe('[(null)|(null)||        |(null)  ]')
  })

  it('pads %s and %c with spaces even with the 0 flag, and ignores + on unsigned', () => {
    expect(sp('[%05s|%05c|%+u|% x]', ['ab', 0x41, 7, 255])[1]).toBe('[   ab|    A|7|ff]')
  })

  it("accepts the ' and I flags (no grouping in the C locale)", () => {
    expect(sp("[%'d|%'.2f|%Id]", [1234567, 42], [f64(1234.5)])[1]).toBe('[1234567|1234.50|42]')
  })

  it('stores the count so far with %n in the size its length names', () => {
    const h = new TestHost()
    for (let i = 0; i < 24; i++) h.mem.set(0x30000 + i, 0xaa)
    expect(call(h, 'snprintf', [BUF, 100, 'ab%ncde%hhnf%ln', 0x30000, 0x30008, 0x30010])).toBe(6n)
    expect(h.string(BUF)).toBe('abcdef')
    expect(h.load(0x30000n, 8)).toBe(0xaaaaaaaa_00000002n)
    expect(h.load(0x30008n, 2)).toBe(0xaa05n)
    expect(h.load(0x30010n, 8)).toBe(6n)
  })

  it('takes positional arguments, in registers by type', () => {
    expect(sp('[%2$d %1$d]', [1, 2])[1]).toBe('[2 1]')
    expect(sp('[%3$*1$.*2$d]', [6, 3, 7])[1]).toBe('[   007]')
    expect(sp('[%2$.1f %1$d %2$g]', [7], [f64(2.5)])[1]).toBe('[2.5 7 2.5]')
    expect(sp('[%1$s %1$s]', ['ab'])[1]).toBe('[ab ab]')
  })

  it('keeps the point with %#a and rounds hex digits to nearest even on all dropped bits', () => {
    expect(sp('[%#a|%#.0a|%#.0A|%.0a|%.0a|%.1a|%.0a]', [], [f64(1), f64(1.5), f64(2.5), f64(1.5), f64(-50294.25), f64(1.4548700838349760e-7), f64(1.5 + 2 ** -52)])[1]).toBe(
      '[0x1.p+0|0x2.p+0|0X1.P+1|0x2p+0|-0x2p+15|0x1.4p-23|0x2p+0]',
    )
    // Subnormals keep a leading 0 and the minimum exponent.
    expect(sp('[%a]', [], [1n])[1]).toBe('[0x0.0000000000001p-1022]')
  })

  it('prints NaN with its sign and the sign flags, and pads inf and nan with spaces', () => {
    expect(sp('[%f|%+f|% F|%05f|%e]', [], [0x7ff8000000000000n, 0x7ff8000000000000n, 0x7ff8000000000000n, 0xfff0000000000000n, 0xfff8000000000000n])[1]).toBe('[nan|+nan| NAN| -inf|-nan]')
  })

  it('prints binary128 long doubles exactly', () => {
    const tenth = parseFloatBits('0.1', F128)!
    expect(sp('[%.40Lf|%La|%.30Le]', [], [tenth, tenth, tenth])[1]).toBe('[0.1000000000000000000000000000000000048148|0x1.999999999999999999999999999ap-4|1.000000000000000000000000000000e-01]')
  })

  it('prints unknown conversions back as glibc rebuilds them', () => {
    expect(sp('[%y|%5ly|%-+3.2k]', [])[1]).toBe('[%y|%5y|%+-3.2k]')
  })

  it('returns -1 for a format that ends inside a conversion, and for widths past INT_MAX', () => {
    expect(sp('abc%')).toEqual([-1, 'abc'])
    expect(sp('%2147483648d', [1])[0]).toBe(-1)
    expect(sp('%2147483647d%d', [1, 2], [], 8)[0]).toBe(-1)
    expect(sp('%2147483646d', [1], [], 8)).toEqual([2147483646, '       '])
  })

  it('handles huge widths and precisions without building them (snprintf counts the rest)', () => {
    const [n, text] = sp('%200000d|%.20000f|%.30000e', [5], [f64(1), f64(1)], 4096)
    expect(n).toBe(200000 + 1 + 20002 + 30007)
    expect(text).toBe(' '.repeat(4095))
    const h = new TestHost()
    call(h, 'sprintf', [BUF, '%.20000f|%#.20000g', 0], [f64(0.5), f64(0.5)])
    expect(h.string(BUF)).toBe(`0.5${'0'.repeat(19999)}|0.5${'0'.repeat(19999)}`)
  })

  it('returns the length for snprintf with size 0 and NULL', () => {
    const h = new TestHost()
    expect(call(h, 'snprintf', [0, 0, '%d-%s', 12345, 'xyz'])).toBe(9n)
    expect(sp('%d', [123456], [], 4)).toEqual([6, '123'])
  })
})

/* ------------------------------------------------------------------ scanf */

/** sscanf with pointers to 0x30000, 0x30100, …: [result, the host]. */
function ss(input: string, fmt: string, n = 4): [number, TestHost] {
  const h = new TestHost()
  for (let i = 0; i < n * 0x100; i++) h.mem.set(0x30000 + i, 0xaa)
  const r = call(h, 'sscanf', [input, fmt, ...Array.from({ length: n }, (_, i) => 0x30000 + 0x100 * i)])
  return [Number(BigInt.asIntN(32, r!)), h]
}
const word = (h: TestHost, i: number, size = 4) => BigInt.asIntN(size * 8, h.load(BigInt(0x30000 + 0x100 * i), size))

describe('scanf', () => {
  it('stops %s and %[ at the end of the string (they used to read past it forever)', () => {
    const [r, h] = ss('abc', '%s')
    expect(r).toBe(1)
    expect(h.string(0x30000)).toBe('abc')
    const [r2, h2] = ss('hello world', '%[^\n]')
    expect(r2).toBe(1)
    expect(h2.string(0x30000)).toBe('hello world')
    expect(ss('', '%[^]]')[0]).toBe(-1)
  })

  it('returns EOF when the input ends before the first assignment, and the count after a mismatch', () => {
    expect(ss('', '%d')[0]).toBe(-1)
    expect(ss('   ', '%d')[0]).toBe(-1)
    expect(ss('x', '%d')[0]).toBe(0)
    expect(ss('5', '%d%d')[0]).toBe(1)
    // Suppressed conversions are not assignments.
    expect(ss('5', '%*d%d')[0]).toBe(-1)
    expect(ss('abc', 'abc%d')[0]).toBe(-1)
    expect(ss('abc ', '%s %s')[0]).toBe(1)
    expect(ss('ab', 'a%%')[0]).toBe(0)
  })

  it('treats a %c that gets fewer characters than its width as an input failure', () => {
    const [r, h] = ss('ab', '%5c')
    expect(r).toBe(-1)
    expect(h.load(0x30000n, 4)).toBe(0xaaaa6261n)
    expect(ss('xab', '%c%5c')[0]).toBe(1)
    expect(ss('', '%c')[0]).toBe(-1)
  })

  it('clamps out-of-range integers as strtol and strtoul do, then cuts them to size', () => {
    const [r, h] = ss('99999999999999999999 -1 18446744073709551616 -9223372036854775809', '%d %u %lu %ld')
    expect(r).toBe(4)
    expect(word(h, 0)).toBe(-1n)
    expect(word(h, 1)).toBe(-1n)
    expect(word(h, 2, 8)).toBe(-1n)
    expect(word(h, 3, 8)).toBe(-(2n ** 63n))
    const [, h2] = ss('300 -0x10 0x', '%hhd %i %i')
    expect(word(h2, 0, 1)).toBe(44n)
    expect(word(h2, 1)).toBe(-16n)
  })

  it('does not take "0x" without hex digits as a number', () => {
    expect(ss('0xg', '%x')[0]).toBe(0)
    expect(ss('0xg', '%i')[0]).toBe(0)
    const [r, h] = ss('0x1f 017 08', '%x %i %i')
    expect(r).toBe(3)
    expect([word(h, 0), word(h, 1), word(h, 2)]).toEqual([31n, 15n, 0n])
  })

  it('reads %n, %p and positional arguments', () => {
    const [r, h] = ss('  42 x', '%d%n')
    expect(r).toBe(1)
    expect(word(h, 1)).toBe(4n)
    const [, h2] = ss('0x1f', '%p')
    expect(word(h2, 0, 8)).toBe(31n)
    const [r3, h3] = ss('1 2', '%2$d %1$d')
    expect(r3).toBe(2)
    expect([word(h3, 0), word(h3, 1)]).toEqual([2n, 1n])
  })

  it('builds %[ sets as glibc: a reversed range is three members, ranges chain', () => {
    expect(ss('a-z!', '%[z-a]')[1].string(0x30000)).toBe('a-z')
    expect(ss('abcdef', '%[a-c-e]')[1].string(0x30000)).toBe('abcde')
    expect(ss(']x-', '%[]x-]')[1].string(0x30000)).toBe(']x-')
  })

  it('keeps the payload of nan(n-char-sequence)', () => {
    const [, h] = ss('nan(12) -nan(0x1f) nan(abc)', '%f %lf %f')
    expect(h.load(0x30000n, 4)).toBe(0x7fc0000cn)
    expect(h.load(0x30100n, 8)).toBe(0xfff800000000001fn)
    expect(h.load(0x30200n, 4)).toBe(0x7fc00000n)
  })
})

describe('strtol and friends', () => {
  const strtol = (s: string, base: number): [bigint, number] => {
    const h = new TestHost()
    h.store(0x30000n, 8, 0x1111n)
    const r = call(h, 'strtol', [s, 0x30000, base])!
    const end = h.load(0x30000n, 8)
    return [r, end === 0x1111n ? -1 : Number(end) - 0x41000]
  }

  it('points end at the x of a "0x" with no hex digits', () => {
    expect(strtol('0x', 16)).toEqual([0n, 1])
    expect(strtol(' 0xg', 0)).toEqual([0n, 2])
    expect(strtol('0x1G', 0)).toEqual([1n, 3])
  })

  it('returns 0 and leaves end alone for an invalid base', () => {
    for (const base of [1, 37, -1, 0x110]) expect(strtol('12', base)).toEqual([0n, -1])
    expect(strtol('z', 36)).toEqual([35n, 1])
  })

  it('clamps overflow to LONG_MAX and LONG_MIN, with end after all the digits', () => {
    expect(strtol('99999999999999999999x', 10)).toEqual([2n ** 63n - 1n, 20])
    expect(strtol('-99999999999999999999', 10)).toEqual([-(2n ** 63n), 21])
    expect(call(new TestHost(), 'atoi', ['4294967297'])).toBe(1n)
    expect(call(new TestHost(), 'atoi', ['  -12abc'])).toBe(-12n)
  })
})

describe('glibc rand', () => {
  it('seeds as srandom does, including seeds of 2^31 and above', () => {
    const seq = (seed: number) => {
      const h = new TestHost()
      call(h, 'srand', [BigInt(seed) | 0xabcd_0000_0000n])
      return [0, 1, 2].map(() => Number(call(h, 'rand', [])))
    }
    expect(seq(42)).toEqual([71876166, 708592740, 1483128881])
    expect(seq(0)).toEqual(seq(1))
    expect(seq(0x80000000)).toEqual([1336741213, 1210407648, 1447044896])
    expect(seq(0xffffffff)).toEqual([254925627, 1205188300, 366127624])
  })
})

/* ------------------------------------------------------------------ whole programs */

function run(src: string, stdin = '') {
  const r = assemble({ name: 't.s', text: src })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  const env = new ConsoleEnv(stdin)
  const m = createMachine(r.program!, env)
  m.run(2_000_000, new Set())
  return { m, env, out: env.output, halt: m.halted, x: (i: number) => BigInt.asIntN(64, BigInt(m.readRegister(i))) }
}

/** A program that runs `body` and exits; x19… keep results. */
const prog = (body: string, data = '') => `
      .global main
main:
      stp x29, x30, [sp, #-16]!
${body}
      ldp x29, x30, [sp], #16
      mov w0, #0
      ret
      .data
      .balign 16
buf:  .space 256
${data}
`

/** svc with x8 = nr and the arguments (numbers, or labels by adr). */
const svc = (nr: number, ...args: (number | string)[]) => `${args.map((v, i) => (typeof v === 'string' ? `      adr x${i}, ${v}` : `      ldr x${i}, =${v}`)).join('\n')}\n      mov x8, #${nr}\n      svc #0\n`

describe('C library in programs', () => {
  it('prints UTF-8 that arrives one byte at a time as whole characters', () => {
    const bytes = [...new TextEncoder().encode('中文')]
    const { out } = run(prog(bytes.map((b) => `      mov w0, #${b}\n      bl putchar`).join('\n') + '\n' + svc(64, 1, 'e1', 1) + svc(64, 1, 'e2', 2), 'e1: .byte 0xe2\ne2: .byte 0x82, 0xac'))
    expect(out).toBe('中文€')
  })

  it('returns the byte count from puts', () => {
    const { x, out } = run(prog('      adr x0, s\n      bl puts\n      mov x19, x0', 's: .asciz "hey"'))
    expect(out).toBe('hey\n')
    expect(x(19)).toBe(4n)
  })

  it('passes printf arguments past the registers on the stack, in order', () => {
    const { out } = run(
      prog(
        `      sub sp, sp, #32
      mov x0, #8
      str x0, [sp]
      fmov d0, #0.5
      str d0, [sp, #8]
      mov x0, #9
      str x0, [sp, #16]
      adr x0, fmt
      mov x1, #1
      mov x2, #2
      mov x3, #3
      mov x4, #4
      mov x5, #5
      mov x6, #6
      mov x7, #7
      fmov d0, #1.0
      fmov d1, #2.0
      fmov d2, #3.0
      fmov d3, #4.0
      fmov d4, #5.0
      fmov d5, #6.0
      fmov d6, #7.0
      fmov d7, #8.0
      bl printf
      add sp, sp, #32`,
        'fmt: .asciz "%d %d %d %d %d %d %d %g %g %g %g %g %g %g %g %d %g %d\\n"',
      ),
    )
    expect(out).toBe('1 2 3 4 5 6 7 1 2 3 4 5 6 7 8 8 0.5 9\n')
  })

  it('reads typed input with scanf, leaving the newline for the next %c', () => {
    const { x } = run(prog('      adr x0, fmt\n      adr x1, buf\n      add x2, x1, #8\n      bl scanf\n      mov x19, x0\n      adr x1, buf\n      ldr w20, [x1]\n      ldrb w21, [x1, #8]', 'fmt: .asciz "%d%c"'), '42\n')
    expect([x(19), x(20), x(21)]).toEqual([2n, 42n, 10n])
  })

  it('keeps the old block when realloc fails, and copies with memmove in either direction', () => {
    const { x, halt } = run(
      prog(`      mov x0, #16
      bl malloc
      mov x19, x0
      mov x1, #1
      lsl x1, x1, #40
      bl realloc
      mov x20, x0
      mov x0, x19
      bl free
      adr x0, s
      add x1, x0, #1
      mov x2, #4
      bl memmove
      adr x0, s
      add x0, x0, #2
      adr x1, s
      mov x2, #3
      bl memmove
      adr x0, s
      ldr x21, [x0]`, 's: .asciz "abcdefg"'),
    )
    expect(halt).toEqual({ kind: 'exit', code: 0 })
    expect(x(20)).toBe(0n)
    // "abcdefg" → memmove(s, s+1, 4) → "bcdeefg" → memmove(s+2, s, 3) → "bcbcdfg"
    expect(x(21)).toBe(BigInt('0x' + [...'bcbcdfg\0'].reverse().map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')))
  })

  it('pads strncpy with zeros up to n and no further', () => {
    const { x } = run(prog('      adr x0, d\n      adr x1, s\n      mov x2, #5\n      bl strncpy\n      adr x0, d\n      ldr x19, [x0]', 's: .asciz "ab"\nd: .ascii "xxxxxxxx"'))
    expect(x(19)).toBe(0x7878_7800_0000_6261n)
  })

  it('faults (SIGSEGV) instead of crashing on a huge memset or memcpy length', () => {
    expect(run(prog('      adr x0, buf\n      mov x1, #0\n      mov x2, #-1\n      bl memset')).halt).toMatchObject({ kind: 'error', code: 'sigsegv' })
    expect(run(prog('      adr x0, buf\n      adr x1, buf\n      mov x2, #-1\n      bl memcpy')).halt).toMatchObject({ kind: 'error', code: 'sigsegv' })
  })

  it('stops printf output past the simulator limit with a message instead of crashing', () => {
    const { halt } = run(prog('      adr x0, fmt\n      mov x1, #1\n      lsl x1, x1, #30\n      mov x2, #1\n      bl printf', 'fmt: .asciz "%*d"'))
    expect(halt).toMatchObject({ kind: 'error', code: 'limit' })
  })
})

describe('system calls', () => {
  /**
   * Run a sequence of system calls and return their results. Result i is also in x19 + i for the first
   * eight (later calls can use them), and all of them are stored at `res`.
   */
  const results = (calls: string[], data = '', files: Record<string, string> = {}) => {
    const env = new ConsoleEnv()
    for (const [name, text] of Object.entries(files)) env.files.write(name, new TextEncoder().encode(text))
    const keep = (i: number) => `${i < 8 ? `      mov x${19 + i}, x0\n` : ''}      adr x9, res\n      str x0, [x9, #${8 * i}]\n`
    const src = `_start:\n${calls.map((c, i) => c + keep(i)).join('')}${svc(93, 0)}      .data\n      .balign 16\nres: .space 256\nbuf: .space 64\nts: .quad 0, 0\n${data}`
    const r = assemble({ name: 't.s', text: src })
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
    const m = createMachine(r.program!, env)
    m.run(1_000_000, new Set())
    expect(m.halted).toEqual({ kind: 'exit', code: 0 })
    const res = r.program!.symbols.res!
    const word = (a: number) => [7, 6, 5, 4, 3, 2, 1, 0].reduce((v, k) => (v << 8n) | BigInt(m.readByte(a + k)), 0n)
    return { r: calls.map((_, i) => BigInt.asIntN(64, word(res + 8 * i))), env, m }
  }

  it('returns -EFAULT for bad pointers instead of a signal', () => {
    expect(results([svc(63, 0, 0, 4), svc(64, 1, 0, 4), svc(101, 0, 0), svc(113, 0, 0), svc(278, 0, 4, 0)]).r).toEqual([-14n, -14n, -14n, -14n, -14n])
  })

  it('checks descriptors and arguments as Linux does', () => {
    const { r } = results([svc(63, 9, 'buf', 4), svc(64, 9, 'buf', 4), svc(62, 0, 0, 0), svc(57, 9), svc(63, 0, 'buf', -1), svc(113, 99, 'ts'), svc(113, 1, 'ts'), svc(278, 'buf', 4, 8), svc(278, 'buf', 4, 6)])
    // EBADF, EBADF, ESPIPE (a terminal), EBADF, EFAULT (count past SSIZE_MAX), EINVAL (clock), 0, EINVAL, EINVAL
    expect(r).toEqual([-9n, -9n, -29n, -9n, -14n, -22n, 0n, -22n, -22n])
  })

  it('rejects a nanosleep with tv_nsec out of range', () => {
    const { r } = results(['      adr x0, ts\n      ldr x1, =1000000000\n      str x1, [x0, #8]\n' + svc(101, 'ts', 0), '      adr x0, ts\n      mov x1, #-1\n      str x1, [x0]\n      str xzr, [x0, #8]\n' + svc(101, 'ts', 0)])
    expect(r).toEqual([-22n, -22n])
  })

  it('validates mmap and splits a mapping on a partial munmap', () => {
    const { r, m } = results([
      svc(222, 0, 4096, 3, 0x20, -1, 0), // neither MAP_SHARED nor MAP_PRIVATE
      svc(222, 0, 4096, 3, 0x22, -1, 1), // offset not page aligned
      svc(222, 0, -1, 3, 0x22, -1, 0), // too long
      svc(222, 0, 3 * 4096, 3, 0x22, -1, 0),
      '      mov x0, x22\n      add x0, x0, #4096\n      mov x1, #4096\n      mov x8, #215\n      svc #0\n',
    ])
    expect(r.slice(0, 3)).toEqual([-22n, -22n, -12n])
    const base = Number(r[3])
    expect(r[4]).toBe(0n)
    expect(m.heapBlocks().filter((b) => b.note === 'mmap').map((b) => [b.addr - base, b.size])).toEqual([
      [0, 4096],
      [8192, 4096],
    ])
  })

  it('maps MAP_FIXED where asked (zeroed), and refuses MAP_FIXED_NOREPLACE over a mapping', () => {
    const { r } = results(
      [
        svc(222, 0, 4096, 3, 0x22, -1, 0),
        '      mov x1, #7\n      str x1, [x19]\n' + svc(215, 0, 0, 0).replace('ldr x0, =0', 'mov x0, x19').replace('ldr x1, =0', 'mov x1, #4096'),
        '      mov x0, x19\n' + svc(222, 0, 4096, 3, 0x32, -1, 0).replace('      ldr x0, =0\n', ''),
        '      ldr x0, [x19]\n',
        '      mov x0, x19\n' + svc(222, 0, 4096, 3, 0x100022, -1, 0).replace('      ldr x0, =0\n', ''),
      ],
      '',
    )
    expect(r[1]).toBe(0n)
    expect(r[2]).toBe(r[0])
    expect(r[3]).toBe(0n)
    expect(r[4]).toBe(-17n)
  })

  it('gives pages that brk unmapped back zeroed', () => {
    const { r } = results([
      svc(214, 0),
      '      add x0, x19, #8192\n      mov x8, #214\n      svc #0\n',
      '      mov x1, #5\n      add x2, x19, #4096\n      str x1, [x2]\n      add x0, x19, #4096\n      mov x8, #214\n      svc #0\n',
      '      add x0, x19, #8192\n      mov x8, #214\n      svc #0\n      add x2, x19, #4096\n      ldr x0, [x2]\n',
      svc(214, 4096),
    ])
    expect(r[3]).toBe(0n)
    // A break below the heap's start is refused: the current one comes back.
    expect(r[4]).toBe(r[1])
  })

  it('shares a file between descriptors, and handles O_EXCL, O_TRUNC, O_APPEND, holes and SEEK_DATA/SEEK_HOLE', () => {
    const { r, env } = results(
      [
        svc(56, -100, 'name', 0o102, 0o644), // fd 3: read-write, create
        svc(56, -100, 'name', 0), // fd 4: read-only
        svc(64, 3, 'abc', 3),
        svc(63, 4, 'buf', 10), // sees fd 3's write
        svc(56, -100, 'name', 0o302, 0o644), // O_CREAT|O_EXCL on an existing file
        svc(62, 3, 6, 0),
        svc(64, 3, 'abc', 1), // "abc\0\0\0a"
        svc(62, 4, 1, 3), // SEEK_DATA
        svc(62, 4, 1, 4), // SEEK_HOLE
        svc(62, 4, 7, 3), // past the end: ENXIO
        svc(56, -100, 'other', 0o2001), // write-only, append
        svc(64, 5, 'abc', 2), // fd 5
        svc(56, -100, 'trunc', 0o1000), // O_TRUNC even when read-only
      ],
      'name: .asciz "data.bin"\nother: .asciz "other"\ntrunc: .asciz "trunc"\nabc: .ascii "abc"\n',
      { other: 'xy', trunc: 'gone' },
    )
    expect(r[0]).toBe(3n)
    expect(r[1]).toBe(4n)
    expect(r[3]).toBe(3n)
    expect(r[4]).toBe(-17n)
    expect(r.slice(5, 10)).toEqual([6n, 1n, 1n, 7n, -6n])
    expect([...env.files.read('data.bin')!]).toEqual([97, 98, 99, 0, 0, 0, 97])
    expect(new TextDecoder().decode(env.files.read('other')!)).toBe('xyab')
    expect(env.files.read('trunc')!.length).toBe(0)
  })

  it('puts back file positions on undo', () => {
    const env = new ConsoleEnv()
    env.files.write('f', new TextEncoder().encode('abcd'))
    const src = `_start:\n${svc(56, -100, 'name', 0)}      mov x19, x0\n${[0, 1].map(() => `      mov x0, x19\n      adr x1, buf\n      mov x2, #2\n      mov x8, #63\n      svc #0\n      mov x2, x0\n      mov x0, #1\n      adr x1, buf\n      mov x8, #64\n      svc #0\n`).join('')}${svc(93, 0)}      .data\nname: .asciz "f"\nbuf: .space 8\n`
    const r = assemble({ name: 't.s', text: src })
    const m = createMachine(r.program!, env)
    m.run(1000, new Set())
    expect(env.output).toBe('abcd')
    // Take back both reads and writes (and the exit), then run them again.
    for (let k = 0; k < 2 * 10 + 3; k++) m.undo()
    m.run(1000, new Set())
    expect(env.output).toBe('abcdabcd')
  })
})
