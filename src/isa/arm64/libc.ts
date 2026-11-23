/**
 * The built-in C library. A program that calls `printf` (or another function listed here) without defining
 * it gets the built-in one, as a dynamically linked program gets the system's: the assembler resolves the
 * name to an entry point in the stub region, and when the machine reaches that address it runs the
 * function below, with arguments and result in registers as the AAPCS64 calling convention puts them
 * (x0–x7, then the stack; variadic arguments as on Linux), and returns to x30.
 */
import { L, T, type Text } from '../../core/i18n'
import { MALLOC_BASE, MALLOC_LIMIT, readBytes, readCString, STUB_BASE, toUtf8, utf8, writeBytes, type Block, type Host } from './linux'

export interface LibcFunction {
  name: string
  /** C prototype, for the reference table. */
  proto: string
  desc: Text
  run: (h: Host, args: Args) => bigint | null
}

/** Integer arguments in order: x0–x7, then 8-byte stack slots from sp. */
export interface Args {
  (i: number): bigint
}

const M64 = 0xffff_ffff_ffff_ffffn
const i32 = (v: bigint) => Number(BigInt.asIntN(32, v))
const i64 = (v: bigint) => BigInt.asIntN(64, v)
const u64 = (v: bigint | number) => BigInt.asUintN(64, BigInt(v))

/* ------------------------------------------------------------------ printf */

/** Format like printf; the variadic arguments start at slot `first`. Returns the bytes. */
function format(h: Host, fmt: Uint8Array, args: Args, first: number): number[] {
  const out: number[] = []
  let next = first
  const arg = () => args(next++)
  let floatNoted = false
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i]!
    if (ch !== 0x25 /* % */) {
      out.push(ch)
      continue
    }
    const start = i
    let flags = ''
    while (i + 1 < fmt.length && '-+ #0'.includes(String.fromCharCode(fmt[i + 1]!))) flags += String.fromCharCode(fmt[++i]!)
    let width = 0
    if (fmt[i + 1] === 0x2a) {
      i++
      width = i32(arg())
      if (width < 0) {
        flags += '-'
        width = -width
      }
    } else while (fmt[i + 1]! >= 0x30 && fmt[i + 1]! <= 0x39) width = width * 10 + fmt[++i]! - 0x30
    let precision = -1
    if (fmt[i + 1] === 0x2e) {
      i++
      precision = 0
      if (fmt[i + 1] === 0x2a) {
        i++
        precision = i32(arg())
        if (precision < 0) precision = -1
      } else while (fmt[i + 1]! >= 0x30 && fmt[i + 1]! <= 0x39) precision = precision * 10 + fmt[++i]! - 0x30
    }
    let length = ''
    while (i + 1 < fmt.length && 'hljztLq'.includes(String.fromCharCode(fmt[i + 1]!))) length += String.fromCharCode(fmt[++i]!)
    const conv = String.fromCharCode(fmt[++i] ?? 0)
    const bits = length === 'hh' ? 8 : length === 'h' ? 16 : length === '' ? 32 : 64
    const pad = (body: number[], prefix: number[] = [], zeroOk = true) => {
      const n = prefix.length + body.length
      if (n >= width) return out.push(...prefix, ...body)
      const fill = width - n
      if (flags.includes('-')) out.push(...prefix, ...body, ...Array(fill).fill(0x20))
      else if (flags.includes('0') && zeroOk) out.push(...prefix, ...Array(fill).fill(0x30), ...body)
      else out.push(...Array(fill).fill(0x20), ...prefix, ...body)
    }
    const digits = (v: bigint, radix: number, upper: boolean): number[] => {
      let s = v.toString(radix)
      if (upper) s = s.toUpperCase()
      if (precision === 0 && v === 0n) s = ''
      if (precision > s.length) s = '0'.repeat(precision - s.length) + s
      return [...s].map((c) => c.charCodeAt(0))
    }
    switch (conv) {
      case 'd':
      case 'i': {
        const v = BigInt.asIntN(bits, arg())
        const sign = v < 0n ? [0x2d] : flags.includes('+') ? [0x2b] : flags.includes(' ') ? [0x20] : []
        pad(digits(v < 0n ? -v : v, 10, false), sign, precision < 0)
        break
      }
      case 'u':
      case 'x':
      case 'X':
      case 'o': {
        const v = BigInt.asUintN(bits, arg())
        const radix = conv === 'u' ? 10 : conv === 'o' ? 8 : 16
        let body = digits(v, radix, conv === 'X')
        let prefix: number[] = []
        if (flags.includes('#') && conv === 'o' && body[0] !== 0x30) body = [0x30, ...body]
        if (flags.includes('#') && (conv === 'x' || conv === 'X') && v !== 0n) prefix = conv === 'x' ? [0x30, 0x78] : [0x30, 0x58]
        pad(body, prefix, precision < 0)
        break
      }
      case 'c':
        pad([Number(arg() & 0xffn)], [], false)
        break
      case 's': {
        const p = arg()
        let s = p === 0n ? [...toUtf8('(null)')] : [...readCString(h, p)]
        if (precision >= 0) s = s.slice(0, precision)
        pad(s, [], false)
        break
      }
      case 'p': {
        const v = arg()
        if (v === 0n) pad([...toUtf8('(nil)')], [], false)
        else pad(digits(v, 16, false), [0x30, 0x78], false)
        break
      }
      case '%':
        out.push(0x25)
        break
      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G':
      case 'a':
      case 'A':
        // Floating-point arguments travel in v0–v7, which arrive with the floating-point phase.
        out.push(...fmt.subarray(start, i + 1))
        if (!floatNoted) h.out(L('\n[printf 的浮点格式还不支持]\n', '\n[printf floating-point formats are not supported yet]\n'))
        floatNoted = true
        break
      default:
        out.push(...fmt.subarray(start, i + 1))
    }
  }
  return out
}

/* ------------------------------------------------------------------ scanf */

const isSpace = (b: number) => b === 0x20 || (b >= 9 && b <= 13)

/** Scan the typed input like scanf; pointers start at slot `first`. Returns the number of assignments. */
function scan(h: Host, fmt: Uint8Array, args: Args, first: number, src: Source): number {
  let next = first
  let assigned = 0
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i]!
    if (isSpace(ch)) {
      while (isSpace(src.peek())) src.next()
      continue
    }
    if (ch !== 0x25) {
      if (src.peek() !== ch) return assigned
      src.next()
      continue
    }
    let suppress = false
    if (fmt[i + 1] === 0x2a) {
      suppress = true
      i++
    }
    let width = 0
    while (fmt[i + 1]! >= 0x30 && fmt[i + 1]! <= 0x39) width = width * 10 + fmt[++i]! - 0x30
    let length = ''
    while (i + 1 < fmt.length && 'hljztLq'.includes(String.fromCharCode(fmt[i + 1]!))) length += String.fromCharCode(fmt[++i]!)
    const conv = String.fromCharCode(fmt[++i] ?? 0)
    const size = length === 'hh' ? 1 : length === 'h' ? 2 : length === '' ? 4 : 8
    const max = width || Infinity
    switch (conv) {
      case '%':
        while (isSpace(src.peek())) src.next()
        if (src.peek() !== 0x25) return assigned
        src.next()
        break
      case 'd':
      case 'i':
      case 'u':
      case 'x':
      case 'X':
      case 'o': {
        while (isSpace(src.peek())) src.next()
        let text = ''
        let n = 0
        if ((src.peek() === 0x2d || src.peek() === 0x2b) && n < max) {
          text += String.fromCharCode(src.next())
          n++
        }
        let radix = conv === 'x' || conv === 'X' ? 16 : conv === 'o' ? 8 : 10
        if (conv === 'i' && src.peek() === 0x30 && n < max) {
          text += String.fromCharCode(src.next())
          n++
          radix = 8
          if ((src.peek() | 0x20) === 0x78 && n < max) {
            src.next()
            n++
            radix = 16
            text = text.slice(0, -1)
          }
        } else if (radix === 16 && src.peek() === 0x30 && n < max) {
          text += String.fromCharCode(src.next())
          n++
          if ((src.peek() | 0x20) === 0x78 && n < max) {
            src.next()
            n++
            text = text.slice(0, -1)
          }
        }
        const valid = (b: number) => {
          const d = b >= 0x30 && b <= 0x39 ? b - 0x30 : (b | 0x20) >= 0x61 && (b | 0x20) <= 0x7a ? (b | 0x20) - 0x61 + 10 : 99
          return d < radix
        }
        while (n < max && valid(src.peek())) {
          text += String.fromCharCode(src.next())
          n++
        }
        const body = text.replace(/^[+-]/, '')
        if (!body) return assigned
        let v = BigInt(radix === 10 ? body : (radix === 16 ? '0x' : '0o') + body)
        if (text.startsWith('-')) v = -v
        if (!suppress) {
          h.store(args(next++), size, BigInt.asUintN(size * 8, v))
          assigned++
        }
        break
      }
      case 'c': {
        const n = width || 1
        const bytes: number[] = []
        for (let k = 0; k < n; k++) bytes.push(src.next())
        if (!suppress) {
          writeBytes(h, args(next++), bytes)
          assigned++
        }
        break
      }
      case 's': {
        while (isSpace(src.peek())) src.next()
        const bytes: number[] = []
        while (bytes.length < max && !isSpace(src.peek())) bytes.push(src.next())
        if (!suppress) {
          writeBytes(h, args(next++), [...bytes, 0])
          assigned++
        }
        break
      }
      case '[': {
        let negate = false
        if (fmt[i + 1] === 0x5e) {
          negate = true
          i++
        }
        const set = new Set<number>()
        if (fmt[i + 1] === 0x5d) set.add(fmt[++i]!)
        while (i + 1 < fmt.length && fmt[i + 1] !== 0x5d) {
          const a = fmt[++i]!
          if (fmt[i + 1] === 0x2d && fmt[i + 2] !== undefined && fmt[i + 2] !== 0x5d) {
            const b = fmt[i + 2]!
            for (let c = a; c <= b; c++) set.add(c)
            i += 2
          } else set.add(a)
        }
        i++
        const bytes: number[] = []
        while (bytes.length < max && set.has(src.peek()) !== negate) bytes.push(src.next())
        if (!bytes.length) return assigned
        if (!suppress) {
          writeBytes(h, args(next++), [...bytes, 0])
          assigned++
        }
        break
      }
      default:
        return assigned
    }
  }
  return assigned
}

interface Source {
  peek(): number
  next(): number
}

const stdin = (h: Host): Source => ({ peek: () => h.peekByte(), next: () => h.nextByte() })
function bytesSource(bytes: Uint8Array): Source {
  let i = 0
  // A NUL past the end reads as "no more input": it is neither a space nor a digit.
  return { peek: () => (i < bytes.length ? bytes[i]! : 0), next: () => (i < bytes.length ? bytes[i++]! : 0) }
}

/* ------------------------------------------------------------------ malloc */

const ALIGN = 16

function malloc(h: Host, n: bigint): bigint {
  const want = Number(n > 0x10000000n ? 0x10000000n : n)
  if (n > 0x10000000n) return 0n
  const size = Math.max(ALIGN, Math.ceil(want / ALIGN) * ALIGN)
  // First fit between live blocks, with a 16-byte gap between blocks (where a real malloc keeps its header).
  let at = MALLOC_BASE + ALIGN
  const blocks = h.os.allocs
  let k = 0
  for (; k < blocks.length; k++) {
    const b = blocks[k]!
    if (at + size + ALIGN <= b.addr) break
    at = Math.max(at, b.addr + Math.ceil(b.size / ALIGN) * ALIGN + ALIGN)
  }
  if (at + size > MALLOC_LIMIT) return 0n
  const block: Block = { addr: at, size: want, serial: h.os.serial + 1 }
  const allocs = [...blocks.slice(0, k), block, ...blocks.slice(k)]
  h.os = { ...h.os, allocs, serial: block.serial, arenaTop: Math.max(h.os.arenaTop, at + size) }
  return BigInt(at)
}

function findBlock(h: Host, p: bigint, what: string): number {
  const a = Number(p)
  const k = h.os.allocs.findIndex((b) => b.addr === a)
  if (k < 0) h.abort('sigabrt', L(`${what}(): 无效的指针 0x${p.toString(16)}（不是 malloc 返回的地址，或者已经释放过）`, `${what}(): invalid pointer 0x${p.toString(16)} (not from malloc, or already freed)`))
  return k
}

function free(h: Host, p: bigint, what = 'free'): void {
  if (p === 0n) return
  const k = findBlock(h, p, what)
  h.os = { ...h.os, allocs: h.os.allocs.filter((_, i) => i !== k) }
}

/* ------------------------------------------------------------------ glibc random() */

/** srand(seed): glibc's TYPE_3 additive generator, seeded with a Park–Miller sequence. */
function seed(h: Host, s: number): void {
  const r: number[] = [s === 0 ? 1 : s | 0]
  for (let i = 1; i < 31; i++) {
    const prev = r[i - 1]!
    const hi = Math.trunc(prev / 127773)
    const lo = prev % 127773
    let word = 16807 * lo - 2836 * hi
    if (word < 0) word += 2147483647
    r.push(word)
  }
  let state = { ring: r, at: 3 }
  for (let k = 0; k < 310; k++) state = step(state)[0]
  h.os = { ...h.os, rand: state }
}

/** One output: r[k] = r[k-31] + r[k-3], keeping the last 31 values. */
function step(s: { ring: readonly number[]; at: number }): [{ ring: number[]; at: number }, number] {
  const ring = s.ring.slice()
  const v = (ring[s.at]! + ring[(s.at + 28) % 31]!) | 0
  ring[s.at] = v
  return [{ ring, at: (s.at + 1) % 31 }, v >>> 1]
}

/* ------------------------------------------------------------------ helpers */

function strtol(h: Host, p: bigint, base: number): { value: bigint; end: bigint } {
  let i = 0n
  const at = () => Number(h.load(p + i, 1))
  while (isSpace(at())) i++
  let neg = false
  if (at() === 0x2d || at() === 0x2b) {
    neg = at() === 0x2d
    i++
  }
  if ((base === 0 || base === 16) && at() === 0x30 && (Number(h.load(p + i + 1n, 1)) | 0x20) === 0x78) {
    i += 2n
    base = 16
  } else if (base === 0) base = at() === 0x30 ? 8 : 10
  let v = 0n
  let any = false
  for (;;) {
    const b = at()
    const d = b >= 0x30 && b <= 0x39 ? b - 0x30 : (b | 0x20) >= 0x61 && (b | 0x20) <= 0x7a ? (b | 0x20) - 0x61 + 10 : 99
    if (d >= base) break
    v = v * BigInt(base) + BigInt(d)
    any = true
    i++
  }
  if (v > 0x7fffffffffffffffn) v = neg ? 0x8000000000000000n : 0x7fffffffffffffffn
  return { value: neg ? -v : v, end: any ? p + i : p }
}

const out = (h: Host, bytes: ArrayLike<number>) => h.out(utf8.decode(Uint8Array.from(bytes as number[])))

/* ------------------------------------------------------------------ the functions */

export const LIBC: LibcFunction[] = [
  {
    name: 'printf',
    proto: 'int printf(const char *format, ...)',
    desc: T('按格式输出：%d %i %u %x %X %o %c %s %p %%，可带宽度、精度、标志和 hh/h/l/ll 长度', 'Formatted output: %d %i %u %x %X %o %c %s %p %%, with width, precision, flags and hh/h/l/ll lengths'),
    run: (h, a) => {
      const bytes = format(h, readCString(h, a(0)), a, 1)
      out(h, bytes)
      return BigInt(bytes.length)
    },
  },
  {
    name: 'sprintf',
    proto: 'int sprintf(char *str, const char *format, ...)',
    desc: T('按格式写进字符串（末尾加 0）', 'Formatted output into a string (with a terminating 0)'),
    run: (h, a) => {
      const bytes = format(h, readCString(h, a(1)), a, 2)
      writeBytes(h, a(0), [...bytes, 0])
      return BigInt(bytes.length)
    },
  },
  {
    name: 'snprintf',
    proto: 'int snprintf(char *str, size_t size, const char *format, ...)',
    desc: T('按格式写进字符串，最多写 size − 1 个字符；返回完整结果的长度', 'Formatted output into a string, at most size − 1 characters; returns the full length'),
    run: (h, a) => {
      const bytes = format(h, readCString(h, a(2)), a, 3)
      const size = Number(a(1) > 0x10000000n ? 0x10000000n : a(1))
      if (size > 0) writeBytes(h, a(0), [...bytes.slice(0, size - 1), 0])
      return BigInt(bytes.length)
    },
  },
  {
    name: 'puts',
    proto: 'int puts(const char *s)',
    desc: T('输出字符串，再输出换行', 'Print a string and a newline'),
    run: (h, a) => {
      out(h, [...readCString(h, a(0)), 10])
      return 1n
    },
  },
  {
    name: 'putchar',
    proto: 'int putchar(int c)',
    desc: T('输出一个字符（字节）', 'Print one character (byte)'),
    run: (h, a) => {
      out(h, [Number(a(0) & 0xffn)])
      return a(0) & 0xffn
    },
  },
  {
    name: 'scanf',
    proto: 'int scanf(const char *format, ...)',
    desc: T('按格式读入：%d %i %u %x %o %c %s %[…]，可带宽度、* 和 hh/h/l/ll；返回成功读入的个数', 'Formatted input: %d %i %u %x %o %c %s %[…], with width, * and hh/h/l/ll; returns how many were read'),
    run: (h, a) => BigInt(scan(h, readCString(h, a(0)), a, 1, stdin(h))),
  },
  {
    name: 'sscanf',
    proto: 'int sscanf(const char *str, const char *format, ...)',
    desc: T('像 scanf 一样，从字符串里读', 'Like scanf, reading from a string'),
    run: (h, a) => BigInt(scan(h, readCString(h, a(1)), a, 2, bytesSource(readCString(h, a(0))))),
  },
  {
    name: 'getchar',
    proto: 'int getchar(void)',
    desc: T('读入一个字符（字节）；输入以行为单位，回车之后才读得到', 'Read one character (byte); input arrives a line at a time, after Enter'),
    run: (h) => BigInt(h.nextByte()),
  },
  {
    name: 'malloc',
    proto: 'void *malloc(size_t size)',
    desc: T('分配 size 字节的内存（按 16 字节对齐），失败返回 NULL', 'Allocate size bytes (16-byte aligned); NULL on failure'),
    run: (h, a) => malloc(h, a(0)),
  },
  {
    name: 'calloc',
    proto: 'void *calloc(size_t n, size_t size)',
    desc: T('分配 n × size 字节并清零', 'Allocate n × size bytes, zeroed'),
    run: (h, a) => {
      const n = a(0) * a(1)
      const p = malloc(h, n)
      // Freed blocks are reused, so the memory may hold old bytes.
      if (p) writeBytes(h, p, new Uint8Array(Number(n)))
      return p
    },
  },
  {
    name: 'realloc',
    proto: 'void *realloc(void *p, size_t size)',
    desc: T('改变一块内存的大小，内容保留；可能搬到新地址', 'Resize a block, keeping its contents; it may move'),
    run: (h, a) => {
      const p = a(0)
      const n = a(1)
      if (p === 0n) return malloc(h, n)
      if (n === 0n) {
        free(h, p, 'realloc')
        return 0n
      }
      const old = h.os.allocs[findBlock(h, p, 'realloc')]!
      const bytes = readBytes(h, p, Math.min(old.size, Number(n)))
      free(h, p, 'realloc')
      const q = malloc(h, n)
      if (q === 0n) return 0n
      writeBytes(h, q, bytes)
      return q
    },
  },
  {
    name: 'free',
    proto: 'void free(void *p)',
    desc: T('释放 malloc 分配的内存；释放两次或释放别的地址会让程序中止', 'Free memory from malloc; freeing twice or freeing another address aborts the program'),
    run: (h, a) => {
      free(h, a(0))
      return null
    },
  },
  {
    name: 'exit',
    proto: 'void exit(int status)',
    desc: T('结束程序，退出码是 status 的低 8 位', 'End the program with exit code status (its low 8 bits)'),
    run: (h, a) => {
      h.exit(Number(a(0) & 0xffn))
      return null
    },
  },
  {
    name: 'abort',
    proto: 'void abort(void)',
    desc: T('立即中止程序（SIGABRT）', 'Stop the program at once (SIGABRT)'),
    run: (h) => h.abort('sigabrt', L('程序调用了 abort()（SIGABRT）', 'The program called abort() (SIGABRT)')),
  },
  {
    name: 'strlen',
    proto: 'size_t strlen(const char *s)',
    desc: T('字符串的长度（不算结尾的 0）', 'Length of a string (not counting the terminating 0)'),
    run: (h, a) => BigInt(readCString(h, a(0)).length),
  },
  {
    name: 'strcmp',
    proto: 'int strcmp(const char *a, const char *b)',
    desc: T('比较两个字符串：相等返回 0，否则返回第一个不同字节之差', 'Compare two strings: 0 if equal, otherwise the difference of the first differing bytes'),
    run: (h, a) => {
      for (let i = 0n; ; i++) {
        const x = Number(h.load(a(0) + i, 1))
        const y = Number(h.load(a(1) + i, 1))
        if (x !== y || x === 0) return u64(x - y)
      }
    },
  },
  {
    name: 'strncmp',
    proto: 'int strncmp(const char *a, const char *b, size_t n)',
    desc: T('比较两个字符串的前 n 个字节', 'Compare at most n bytes of two strings'),
    run: (h, a) => {
      for (let i = 0n; i < a(2); i++) {
        const x = Number(h.load(a(0) + i, 1))
        const y = Number(h.load(a(1) + i, 1))
        if (x !== y || x === 0) return u64(x - y)
      }
      return 0n
    },
  },
  {
    name: 'strcpy',
    proto: 'char *strcpy(char *dst, const char *src)',
    desc: T('把字符串复制到 dst（连同结尾的 0），返回 dst', 'Copy a string to dst (with its terminating 0); returns dst'),
    run: (h, a) => {
      writeBytes(h, a(0), [...readCString(h, a(1)), 0])
      return a(0)
    },
  },
  {
    name: 'strncpy',
    proto: 'char *strncpy(char *dst, const char *src, size_t n)',
    desc: T('最多复制 n 个字节，不够的用 0 补齐', 'Copy at most n bytes, padding with zeros'),
    run: (h, a) => {
      const n = Number(a(2))
      const s = [...readCString(h, a(1), n)]
      writeBytes(h, a(0), [...s, ...Array(Math.max(0, n - s.length)).fill(0)].slice(0, n))
      return a(0)
    },
  },
  {
    name: 'strcat',
    proto: 'char *strcat(char *dst, const char *src)',
    desc: T('把 src 接到 dst 后面，返回 dst', 'Append src to dst; returns dst'),
    run: (h, a) => {
      const end = a(0) + BigInt(readCString(h, a(0)).length)
      writeBytes(h, end, [...readCString(h, a(1)), 0])
      return a(0)
    },
  },
  {
    name: 'strchr',
    proto: 'char *strchr(const char *s, int c)',
    desc: T('找字符 c 第一次出现的位置，找不到返回 NULL', 'Find the first occurrence of c; NULL if none'),
    run: (h, a) => {
      const c = Number(a(1) & 0xffn)
      for (let i = 0n; ; i++) {
        const b = Number(h.load(a(0) + i, 1))
        if (b === c) return a(0) + i
        if (b === 0) return 0n
      }
    },
  },
  {
    name: 'memcpy',
    proto: 'void *memcpy(void *dst, const void *src, size_t n)',
    desc: T('复制 n 个字节，返回 dst', 'Copy n bytes; returns dst'),
    run: (h, a) => {
      writeBytes(h, a(0), readBytes(h, a(1), Number(a(2))))
      return a(0)
    },
  },
  {
    name: 'memmove',
    proto: 'void *memmove(void *dst, const void *src, size_t n)',
    desc: T('复制 n 个字节，两块内存可以重叠', 'Copy n bytes; the two blocks may overlap'),
    run: (h, a) => {
      writeBytes(h, a(0), readBytes(h, a(1), Number(a(2))))
      return a(0)
    },
  },
  {
    name: 'memset',
    proto: 'void *memset(void *p, int c, size_t n)',
    desc: T('把 n 个字节都设成 c，返回 p', 'Set n bytes to c; returns p'),
    run: (h, a) => {
      writeBytes(h, a(0), new Uint8Array(Number(a(2))).fill(Number(a(1) & 0xffn)))
      return a(0)
    },
  },
  {
    name: 'memcmp',
    proto: 'int memcmp(const void *a, const void *b, size_t n)',
    desc: T('比较 n 个字节', 'Compare n bytes'),
    run: (h, a) => {
      for (let i = 0n; i < a(2); i++) {
        const x = Number(h.load(a(0) + i, 1))
        const y = Number(h.load(a(1) + i, 1))
        if (x !== y) return u64(x - y)
      }
      return 0n
    },
  },
  {
    name: 'atoi',
    proto: 'int atoi(const char *s)',
    desc: T('把十进制字符串转成整数', 'Convert a decimal string to an int'),
    run: (h, a) => u64(BigInt.asIntN(32, strtol(h, a(0), 10).value)),
  },
  {
    name: 'atol',
    proto: 'long atol(const char *s)',
    desc: T('把十进制字符串转成 long（64 位）', 'Convert a decimal string to a long (64-bit)'),
    run: (h, a) => u64(strtol(h, a(0), 10).value),
  },
  {
    name: 'strtol',
    proto: 'long strtol(const char *s, char **end, int base)',
    desc: T('按进制 base（0 表示自动识别 0x、0 前缀）转换字符串，*end 指向没用到的部分', 'Convert a string in base base (0: detect 0x and 0 prefixes); *end points past the digits used'),
    run: (h, a) => {
      const r = strtol(h, a(0), Number(a(2) & 0xffn))
      if (a(1) !== 0n) h.store(a(1), 8, r.end)
      return u64(r.value)
    },
  },
  {
    name: 'abs',
    proto: 'int abs(int x)',
    desc: T('绝对值', 'Absolute value'),
    run: (_h, a) => u64(Math.abs(i32(a(0))) | 0) & 0xffffffffn,
  },
  {
    name: 'labs',
    proto: 'long labs(long x)',
    desc: T('绝对值（64 位）', 'Absolute value (64-bit)'),
    run: (_h, a) => {
      const v = i64(a(0))
      return u64(v < 0n ? -v : v) & M64
    },
  },
  {
    name: 'rand',
    proto: 'int rand(void)',
    desc: T('0 到 2147483647 之间的伪随机数（和 glibc 的序列相同）', 'Pseudo-random number from 0 to 2147483647 (the same sequence as glibc)'),
    run: (h) => {
      if (!h.os.rand) seed(h, 1)
      const [state, v] = step(h.os.rand!)
      h.os = { ...h.os, rand: state }
      return BigInt(v)
    },
  },
  {
    name: 'srand',
    proto: 'void srand(unsigned seed)',
    desc: T('设置 rand 的种子；同一个种子得到同一串数', 'Seed rand; the same seed gives the same sequence'),
    run: (h, a) => {
      seed(h, Number(a(0) & 0xffffffffn) | 0)
      return null
    },
  },
  {
    name: 'time',
    proto: 'time_t time(time_t *t)',
    desc: T('当前时间（从 1970 年起的秒数）；t 不是 NULL 时也存到 *t', 'Current time in seconds since 1970; also stored in *t when t is not NULL'),
    run: (h, a) => {
      const now = BigInt(Math.floor(h.env.now() / 1000))
      if (a(0) !== 0n) h.store(a(0), 8, now)
      return now
    },
  },
]

export const LIBC_FUNCTIONS = LIBC.map((f) => f.name)
const BY_ADDR = new Map(LIBC.map((f, i) => [STUB_BASE + 16 * (i + 1), f]))

/** The entry point of a library function. */
export function stubAddress(name: string): number {
  return STUB_BASE + 16 * (LIBC_FUNCTIONS.indexOf(name) + 1)
}

export function libcAt(addr: number): LibcFunction | undefined {
  return BY_ADDR.get(addr)
}
