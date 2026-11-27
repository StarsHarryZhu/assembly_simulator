/**
 * The built-in C library. A program that calls `printf` (or another function listed here) without defining
 * it gets the built-in one, as a dynamically linked program gets the system's: the assembler resolves the
 * name to an entry point in the stub region, and when the machine reaches that address it runs the
 * function below, with arguments and result in registers as the AAPCS64 calling convention puts them
 * (x0–x7, then the stack; variadic arguments as on Linux), and returns to x30.
 */
import { L, T, type Text } from '../../core/i18n'
import { F128, formatFloat, numberPrefix, parseFloatBits } from './fpformat'
import { F32, F64 } from './softfloat'
import { MALLOC_BASE, MALLOC_LIMIT, readBytes, readCString, STUB_BASE, writeBytes, writeTerminal, type Block, type Host } from './linux'

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
  /** Floating-point argument register v<i> (i < 8), all 128 bits. */
  fp(i: number): bigint
  /** The 8-byte stack slot i above sp, where arguments go once their registers run out. */
  stack(i: number): bigint
}

const M64 = 0xffff_ffff_ffff_ffffn
const i32 = (v: bigint) => Number(BigInt.asIntN(32, v))
const i64 = (v: bigint) => BigInt.asIntN(64, v)
const u64 = (v: bigint | number) => BigInt.asUintN(64, BigInt(v))

/* ------------------------------------------------------------------ printf */

/** Bytes one printf or sprintf call may produce; past this the simulator stops the program instead. */
const MAX_OUT = 1 << 24
/** Float digits past this many are zeros for every format, so they are not computed. */
const FLOAT_DIGITS = 17000
const INT_MAX = 0x7fffffff

/** One conversion specification: `%[n$][flags][width][.precision][length]conversion`. */
interface Spec {
  /** Where it starts (the '%') and ends (after the conversion character). */
  start: number
  end: number
  flags: string
  /** Width and precision written in the format (-1: none), or the argument that holds them (-1: none). */
  width: number
  widthArg: number
  precision: number
  precArg: number
  length: string
  /** The conversion character; empty when the format ends inside the specification. */
  conv: string
  /** The argument it converts (-1: none). */
  arg: number
}

/** How an argument is passed: in an x register, a d register (double) or a q register (long double). */
type Kind = 'x' | 'd' | 'q'

const isDigit = (b: number | undefined) => b !== undefined && b >= 0x30 && b <= 0x39
const FLOAT_CONV = 'fFeEgGaA'
const ARG_CONV = 'diouxXcspn' + FLOAT_CONV

/** Parse every specification and say which argument each one reads (sequentially, or by `n$`). */
function parseFormat(fmt: Uint8Array): { specs: Spec[]; kinds: Kind[]; overflow: boolean } {
  const specs: Spec[] = []
  const kinds: Kind[] = []
  let next = 0
  let overflow = false
  const number = (j: number): [number, number] => {
    let v = 0
    for (; isDigit(fmt[j]); j++) v = Math.min(v * 10 + fmt[j]! - 0x30, INT_MAX + 1)
    return [v, j]
  }
  /** An argument named by `m$` at j, or the next one in order. */
  const argAt = (j: number, kind: Kind): [number, number] => {
    const [v, k] = number(j)
    const index = k > j && fmt[k] === 0x24 && v > 0 ? v - 1 : next++
    kinds[index] ??= kind
    return [index, k > j && fmt[k] === 0x24 && v > 0 ? k + 1 : j]
  }
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== 0x25) continue
    const spec: Spec = { start: i, end: 0, flags: '', width: -1, widthArg: -1, precision: -1, precArg: -1, length: '', conv: '', arg: -1 }
    let j = i + 1
    // %n$: the argument's position.
    let pos = -1
    const [p, k] = number(j)
    if (k > j && fmt[k] === 0x24 && p > 0) {
      pos = p - 1
      j = k + 1
    }
    while (j < fmt.length && "-+ #0'I".includes(String.fromCharCode(fmt[j]!))) spec.flags += String.fromCharCode(fmt[j++]!)
    if (fmt[j] === 0x2a) [spec.widthArg, j] = argAt(j + 1, 'x')
    else [spec.width, j] = isDigit(fmt[j]) ? number(j) : [-1, j]
    if (fmt[j] === 0x2e) {
      if (fmt[j + 1] === 0x2a) [spec.precArg, j] = argAt(j + 2, 'x')
      else [spec.precision, j] = number(j + 1)
    }
    if (spec.width > INT_MAX || spec.precision > INT_MAX) overflow = true
    const two = String.fromCharCode(fmt[j] ?? 0, fmt[j + 1] ?? 0)
    if (two === 'hh' || two === 'll') spec.length = two
    else if ('hlLqjzZt'.includes(two[0]!) && two[0] !== '\0') spec.length = two[0]!
    j += spec.length.length
    spec.conv = j < fmt.length ? String.fromCharCode(fmt[j]!) : ''
    spec.end = Math.min(j + 1, fmt.length)
    if (spec.conv && ARG_CONV.includes(spec.conv)) {
      const kind: Kind = FLOAT_CONV.includes(spec.conv) ? (spec.length === 'L' ? 'q' : 'd') : 'x'
      spec.arg = pos >= 0 ? pos : next++
      kinds[spec.arg] ??= kind
    }
    specs.push(spec)
    i = spec.end - 1
  }
  return { specs, kinds, overflow }
}

/** printf's output: the bytes it keeps, and how many it produced in all. */
class Output {
  bytes: number[] = []
  count = 0
  constructor(
    private keep: number,
    private tooLong: (() => never) | null,
  ) {}
  fill(b: number, n: number) {
    if (n <= 0) return
    if (this.tooLong && this.count + n > this.keep) this.tooLong()
    for (let k = Math.min(n, this.keep - this.count); k > 0; k--) this.bytes.push(b)
    this.count += n
  }
  add(bytes: ArrayLike<number>) {
    if (this.tooLong && this.count + bytes.length > this.keep) this.tooLong()
    for (let k = 0; k < bytes.length && this.count + k < this.keep; k++) this.bytes.push(bytes[k]!)
    this.count += bytes.length
  }
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))

/**
 * Format like glibc's printf; the variadic arguments start at integer slot `first`. As on Linux (AAPCS64),
 * integers come from x registers and floating-point values from v0–v7, each until its registers run out,
 * and then both from the stack in order. `keep` bytes are kept (the rest only counted); `name` is the
 * function, for the message when the output is longer than the simulator produces. `failed` is set where
 * glibc returns -1: a width or precision past INT_MAX, a total past INT_MAX, or a format that ends inside a
 * conversion.
 */
function format(h: Host, fmt: Uint8Array, args: Args, first: number, keep: number, name: string | null): { out: Output; failed: boolean } {
  const tooLong = name === null ? null : (): never => h.abort('limit', L(`${name}：输出超过 ${MAX_OUT} 字节，模拟器不再生成（真正的 glibc 会照常输出）`, `${name}: the output is longer than ${MAX_OUT} bytes, which the simulator does not produce (glibc would print it)`))
  const out = new Output(keep, tooLong)
  const { specs, kinds, overflow } = parseFormat(fmt)
  // Fetch every argument first, in order, each from where its type is passed.
  let gp = first
  let fr = 0
  let st = Math.max(0, first - 8)
  const values: bigint[] = []
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k] ?? 'x'
    if (kind === 'x') values.push(gp < 8 ? args(gp++) : args.stack(st++))
    else if (fr < 8) values.push(args.fp(fr++))
    else if (kind === 'd') values.push(args.stack(st++))
    else {
      // A long double on the stack takes a 16-byte aligned pair of slots.
      st += st & 1
      const lo = args.stack(st++)
      values.push((args.stack(st++) << 64n) | lo)
    }
  }
  if (overflow) return { out, failed: true }
  let at = 0
  for (const s of specs) {
    out.add(fmt.subarray(at, s.start))
    at = s.end
    if (!s.conv) return { out, failed: true }
    let flags = s.flags
    let width = s.width < 0 ? 0 : s.width
    if (s.widthArg >= 0) {
      width = i32(values[s.widthArg]!)
      // A negative width from an argument means '-' and its absolute value.
      if (width < 0) {
        flags += '-'
        width = -width
      }
    }
    let precision = s.precision
    if (s.precArg >= 0) precision = Math.max(-1, i32(values[s.precArg]!))
    const left = flags.includes('-')
    const v = s.arg >= 0 ? values[s.arg]! : 0n
    /** prefix (sign, 0x), then `zeros` zeros, then the body, padded to the width. */
    const pad = (body: ArrayLike<number>, prefix: number[] = [], zeros = 0, zeroOk = false) => {
      const fill = width - prefix.length - zeros - body.length
      if (!left && !(zeroOk && flags.includes('0'))) out.fill(0x20, fill)
      out.add(prefix)
      if (!left && zeroOk && flags.includes('0')) out.fill(0x30, fill)
      out.fill(0x30, zeros)
      out.add(body)
      if (left) out.fill(0x20, fill)
    }
    const bits = s.length === 'hh' ? 8 : s.length === 'h' ? 16 : s.length === '' ? 32 : 64
    /** An integer: its digits, with the precision's leading zeros (none for a zero with precision 0). */
    const integer = (n: bigint, radix: number, prefix: number[], upper = false, alt = false) => {
      let digits = precision === 0 && n === 0n ? '' : n.toString(radix)
      if (upper) digits = digits.toUpperCase()
      let zeros = Math.max(0, precision - digits.length)
      // '#' with o makes the first digit a zero.
      if (alt && zeros === 0 && digits[0] !== '0') zeros = 1
      // A precision turns off the '0' flag.
      pad(ascii(digits), prefix, zeros, precision < 0)
    }
    const sign = (neg: boolean) => (neg ? [0x2d] : flags.includes('+') ? [0x2b] : flags.includes(' ') ? [0x20] : [])
    switch (s.conv) {
      case 'd':
      case 'i': {
        const n = BigInt.asIntN(bits, v)
        integer(n < 0n ? -n : n, 10, sign(n < 0n))
        break
      }
      case 'u':
        integer(BigInt.asUintN(bits, v), 10, [])
        break
      case 'o':
        integer(BigInt.asUintN(bits, v), 8, [], false, flags.includes('#'))
        break
      case 'x':
      case 'X': {
        const n = BigInt.asUintN(bits, v)
        integer(n, 16, flags.includes('#') && n ? ascii(`0${s.conv}`) : [], s.conv === 'X')
        break
      }
      case 'p':
        // glibc prints a pointer as %#lx, keeping the '+' and ' ' flags; NULL is "(nil)".
        if (v === 0n) pad(ascii('(nil)'))
        else integer(v, 16, [...sign(false), 0x30, 0x78])
        break
      case 'c':
        pad([Number(v & 0xffn)])
        break
      case 's': {
        // NULL prints as "(null)", or as nothing when the precision is too short for all of it.
        const text = v !== 0n ? readCString(h, v, precision < 0 ? 1 << 20 : precision) : precision < 0 || precision >= 6 ? ascii('(null)') : []
        pad(text)
        break
      }
      case 'n': {
        // The number of bytes so far, stored at the pointer in the argument's size.
        const size = s.length === 'hh' ? 1 : s.length === 'h' ? 2 : s.length === '' ? 4 : 8
        h.store(v, size, BigInt.asUintN(size * 8, BigInt(out.count)))
        break
      }
      case '%':
        out.add([0x25])
        break
      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G':
      case 'a':
      case 'A': {
        // float arguments arrive promoted to double; %Lf takes a long double (binary128) from a q register.
        const quad = s.length === 'L'
        // Digits past FLOAT_DIGITS are zeros: format with fewer and add the zeros back (before the exponent).
        const capped = Math.min(precision, FLOAT_DIGITS)
        const r = formatFloat(quad ? v : v & M64, quad ? F128 : F64, s.conv, flags, capped)
        const hex = s.conv === 'a' || s.conv === 'A'
        const prefix = ascii(r.sign + (hex && !r.special ? r.body.slice(0, 2) : ''))
        let body = ascii(hex && !r.special ? r.body.slice(2) : r.body)
        const extra = r.special || ((s.conv === 'g' || s.conv === 'G') && !flags.includes('#')) ? 0 : precision - capped
        if (extra > 0) {
          const e = body.findIndex((b) => b === 0x65 || b === 0x45 || b === 0x70 || b === 0x50)
          const cut = e < 0 ? body.length : e
          const tail = body.slice(cut)
          body = body.slice(0, cut)
          // The zeros go between the digits and the exponent: pad with them by hand.
          const fill = width - prefix.length - body.length - extra - tail.length
          if (!left && !flags.includes('0')) out.fill(0x20, fill)
          out.add(prefix)
          if (!left && flags.includes('0')) out.fill(0x30, fill)
          out.add(body)
          out.fill(0x30, extra)
          out.add(tail)
          if (left) out.fill(0x20, fill)
        } else pad(body, prefix, 0, !r.special)
        break
      }
      default: {
        // An unknown conversion prints itself back, as glibc rebuilds it: flags, width, precision.
        const pad0 = flags.includes('0') && !left
        let t = '%'
        if (flags.includes('#')) t += '#'
        if (flags.includes("'")) t += "'"
        if (flags.includes('+')) t += '+'
        else if (flags.includes(' ')) t += ' '
        if (left) t += '-'
        if (pad0) t += '0'
        if (flags.includes('I')) t += 'I'
        if (width) t += width
        if (precision >= 0) t += `.${precision}`
        out.add([...ascii(t), fmt[s.end - 1]!])
      }
    }
  }
  out.add(fmt.subarray(at))
  return { out, failed: out.count > INT_MAX }
}

/* ------------------------------------------------------------------ scanf */

const isSpace = (b: number) => b === 0x20 || (b >= 9 && b <= 13)
const EOF = -1

/** Where scanf reads from: the typed input or a string. `peek` and `next` give EOF (-1) at the end. */
interface Source {
  peek(): number
  next(): number
  /** Bytes consumed so far (for %n). */
  count: number
}

const stdin = (h: Host): Source => {
  const s: Source = {
    peek: () => h.peekByte(),
    next: () => {
      s.count++
      return h.nextByte()
    },
    count: 0,
  }
  return s
}

function bytesSource(bytes: Uint8Array): Source {
  const s: Source = {
    peek: () => (s.count < bytes.length ? bytes[s.count]! : EOF),
    next: () => (s.count < bytes.length ? bytes[s.count++]! : EOF),
    count: 0,
  }
  return s
}

const digitValue = (b: number) => (b >= 0x30 && b <= 0x39 ? b - 0x30 : (b | 0x20) >= 0x61 && (b | 0x20) <= 0x7a ? (b | 0x20) - 0x61 + 10 : 99)

/**
 * Scan like glibc's scanf; pointers start at slot `first`. Returns the number of assignments, or EOF when
 * the input ends before the first one (a mismatch is not an end: it returns what was assigned so far).
 */
function scan(h: Host, fmt: Uint8Array, args: Args, first: number, src: Source): number {
  let next = first
  let done = 0
  const ended = () => (done === 0 ? EOF : done)
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i]!
    if (isSpace(ch)) {
      while (isSpace(src.peek())) src.next()
      continue
    }
    if (ch !== 0x25) {
      if (src.peek() === EOF) return ended()
      if (src.peek() !== ch) return done
      src.next()
      continue
    }
    // %[n$][*][width][length]conversion
    let j = i + 1
    let pos = -1
    let n = 0
    let k = j
    for (; isDigit(fmt[k]); k++) n = Math.min(n * 10 + fmt[k]! - 0x30, INT_MAX)
    if (k > j && fmt[k] === 0x24 && n > 0) {
      pos = n - 1
      j = k + 1
    }
    const suppress = fmt[j] === 0x2a
    if (suppress) j++
    let width = 0
    for (; isDigit(fmt[j]); j++) width = Math.min(width * 10 + fmt[j]! - 0x30, INT_MAX)
    const max = width || Infinity
    let length = ''
    const two = String.fromCharCode(fmt[j] ?? 0, fmt[j + 1] ?? 0)
    if (two === 'hh' || two === 'll') length = two
    else if ('hlLqjzZt'.includes(two[0]!)) length = two[0]!
    j += length.length
    const conv = String.fromCharCode(fmt[j] ?? 0)
    i = j
    const size = length === 'hh' ? 1 : length === 'h' ? 2 : length === '' ? 4 : 8
    const target = () => (pos >= 0 ? args(first + pos) : args(next++))
    // Every conversion but %c, %[ and %n skips white space first.
    if (conv !== 'c' && conv !== '[' && conv !== 'n') while (isSpace(src.peek())) src.next()
    switch (conv) {
      case '%':
        if (src.peek() === EOF) return ended()
        if (src.peek() !== 0x25) return done
        src.next()
        break
      case 'n':
        if (!suppress) h.store(target(), size, BigInt.asUintN(size * 8, BigInt(src.count)))
        break
      case 'c': {
        if (src.peek() === EOF) return ended()
        const want = width || 1
        const bytes: number[] = []
        while (bytes.length < want && src.peek() !== EOF) bytes.push(src.next())
        const p = suppress ? 0n : target()
        if (!suppress) writeBytes(h, p, bytes)
        // Fewer characters than the width is an input failure (what was read is stored, but not counted).
        if (bytes.length < want) return ended()
        if (!suppress) done++
        break
      }
      case 's':
      case '[': {
        let set: Set<number> | null = null
        let negate = false
        if (conv === '[') {
          // A ']' or '-' first is a member; 'a-z' is a range when a <= z, otherwise three members.
          set = new Set()
          if (fmt[i + 1] === 0x5e) {
            negate = true
            i++
          }
          if (fmt[i + 1] === 0x5d || fmt[i + 1] === 0x2d) set.add(fmt[++i]!)
          for (;;) {
            const c = fmt[++i]
            if (c === undefined) return done
            if (c === 0x5d) break
            if (c === 0x2d && fmt[i + 1] !== undefined && fmt[i + 1] !== 0x5d && fmt[i - 1]! <= fmt[i + 1]!) for (let b = fmt[i - 1]!; b < fmt[i + 1]!; b++) set.add(b)
            else set.add(c)
          }
        }
        if (src.peek() === EOF) return ended()
        const takes = (b: number) => b !== EOF && (set ? set.has(b) !== negate : !isSpace(b))
        const bytes: number[] = []
        while (bytes.length < max && takes(src.peek())) bytes.push(src.next())
        if (!bytes.length) return done
        if (!suppress) {
          writeBytes(h, target(), [...bytes, 0])
          done++
        }
        break
      }
      case 'd':
      case 'i':
      case 'u':
      case 'o':
      case 'x':
      case 'X':
      case 'p': {
        if (src.peek() === EOF) return ended()
        let left = max
        let neg = false
        if (src.peek() === 0x2d || src.peek() === 0x2b) {
          neg = src.next() === 0x2d
          left--
        }
        let base = conv === 'i' ? 0 : conv === 'o' ? 8 : conv === 'd' || conv === 'u' ? 10 : 16
        let digits = ''
        if (left > 0 && src.peek() === 0x30 && (base === 0 || base === 16)) {
          src.next()
          left--
          digits = '0'
          if (left > 0 && (src.peek() | 0x20) === 0x78) {
            // "0x" is a prefix, not a digit: with no hex digits after it, nothing was converted.
            src.next()
            left--
            digits = ''
            base = 16
          } else if (base === 0) base = 8
        }
        if (base === 0) base = 10
        while (left > 0 && digitValue(src.peek()) < base) {
          digits += String.fromCharCode(src.next())
          left--
        }
        if (!digits) return done
        // As glibc, through strtol (d, i) or strtoul (the others): out-of-range values clamp, then the
        // value is cut to the destination's size.
        const mag = [...digits].reduce((acc, c) => acc * BigInt(base) + BigInt(digitValue(c.charCodeAt(0))), 0n)
        let value: bigint
        if (conv === 'd' || conv === 'i') value = neg ? (mag > 1n << 63n ? -(1n << 63n) : -mag) : mag >= 1n << 63n ? (1n << 63n) - 1n : mag
        else value = mag > M64 ? M64 : neg ? -mag : mag
        if (!suppress) {
          const bytes = conv === 'p' ? 8 : size
          h.store(target(), bytes, BigInt.asUintN(bytes * 8, value))
          done++
        }
        break
      }
      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G':
      case 'a':
      case 'A': {
        if (src.peek() === EOF) return ended()
        let text = ''
        while (text.length < max && src.peek() !== EOF && numberPrefix(text + String.fromCharCode(src.peek()))) text += String.fromCharCode(src.next())
        const fmtOf = length === 'L' ? F128 : length === 'l' ? F64 : F32
        const bits = parseFloatBits(text, fmtOf)
        if (bits === null) return done
        if (!suppress) {
          h.store(target(), fmtOf.n / 8, bits)
          done++
        }
        break
      }
      default:
        return done
    }
  }
  return done
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

/** strtol: null for a base other than 0 and 2–36 (glibc then returns 0 and leaves *end alone). */
function strtol(h: Host, p: bigint, base: number): { value: bigint; end: bigint } | null {
  if (base < 0 || base === 1 || base > 36) return null
  let i = 0n
  const at = () => Number(h.load(p + i, 1))
  while (isSpace(at())) i++
  let neg = false
  if (at() === 0x2d || at() === 0x2b) {
    neg = at() === 0x2d
    i++
  }
  let hex = false
  if ((base === 0 || base === 16) && at() === 0x30 && (Number(h.load(p + i + 1n, 1)) | 0x20) === 0x78) {
    i += 2n
    base = 16
    hex = true
  } else if (base === 0) base = at() === 0x30 ? 8 : 10
  let v = 0n
  let any = false
  for (;;) {
    const d = digitValue(at())
    if (d >= base) break
    v = v * BigInt(base) + BigInt(d)
    any = true
    i++
  }
  if (v > 0x7fffffffffffffffn) v = neg ? 0x8000000000000000n : 0x7fffffffffffffffn
  // "0x" with no hex digit after it converts the "0": *end points at the 'x'.
  return { value: neg ? -v : v, end: any ? p + i : hex ? p + i - 1n : p }
}

/** Copy n bytes one at a time, so a bad range faults where the real copy would. */
function copy(h: Host, dst: bigint, src: bigint, n: bigint, backwards: boolean): void {
  if (backwards) for (let i = n - 1n; i >= 0n; i--) h.store(dst + i, 1, h.load(src + i, 1))
  else for (let i = 0n; i < n; i++) h.store(dst + i, 1, h.load(src + i, 1))
}

/* ------------------------------------------------------------------ the functions */

export const LIBC: LibcFunction[] = [
  {
    name: 'printf',
    proto: 'int printf(const char *format, ...)',
    desc: T(
      '按格式输出：%d %i %u %x %X %o %c %s %p %n %% 和浮点数 %f %e %g %a，可带标志、宽度、精度（包括 *）、长度 hh h l ll z j t L 和位置参数 %1$d；返回输出的字节数',
      'Formatted output: %d %i %u %x %X %o %c %s %p %n %% and floats %f %e %g %a, with flags, width and precision (also *), lengths hh h l ll z j t L and positional arguments %1$d; returns the number of bytes',
    ),
    run: (h, a) => {
      const { out, failed } = format(h, readCString(h, a(0)), a, 1, MAX_OUT, 'printf')
      if (failed) return M64
      writeTerminal(h, out.bytes)
      return BigInt(out.count)
    },
  },
  {
    name: 'sprintf',
    proto: 'int sprintf(char *str, const char *format, ...)',
    desc: T('按格式写进字符串（末尾加 0）', 'Formatted output into a string (with a terminating 0)'),
    run: (h, a) => {
      const { out, failed } = format(h, readCString(h, a(1)), a, 2, MAX_OUT, 'sprintf')
      writeBytes(h, a(0), [...out.bytes, 0])
      return failed ? M64 : BigInt(out.count)
    },
  },
  {
    name: 'snprintf',
    proto: 'int snprintf(char *str, size_t size, const char *format, ...)',
    desc: T('按格式写进字符串，最多写 size − 1 个字符；返回完整结果的长度', 'Formatted output into a string, at most size − 1 characters; returns the full length'),
    run: (h, a) => {
      const size = a(1)
      // Only what fits is kept; the rest is counted for the result.
      const small = size <= BigInt(MAX_OUT)
      const { out, failed } = format(h, readCString(h, a(2)), a, 3, small ? Math.max(0, Number(size) - 1) : MAX_OUT, small ? null : 'snprintf')
      if (size > 0n) writeBytes(h, a(0), [...out.bytes, 0])
      return failed ? M64 : BigInt(out.count)
    },
  },
  {
    name: 'puts',
    proto: 'int puts(const char *s)',
    desc: T('输出字符串，再输出换行；返回输出的字节数', 'Print a string and a newline; returns the number of bytes'),
    run: (h, a) => {
      const s = readCString(h, a(0))
      writeTerminal(h, [...s, 10])
      return BigInt(s.length + 1)
    },
  },
  {
    name: 'putchar',
    proto: 'int putchar(int c)',
    desc: T('输出一个字符（字节）', 'Print one character (byte)'),
    run: (h, a) => {
      writeTerminal(h, [Number(a(0) & 0xffn)])
      return a(0) & 0xffn
    },
  },
  {
    name: 'scanf',
    proto: 'int scanf(const char *format, ...)',
    desc: T(
      '按格式读入：%d %i %u %x %o %p %c %s %[…] %n %% 和浮点数 %f %e %g %a，可带宽度、*、长度 hh h l ll z j t L 和位置参数；返回成功存入的个数',
      'Formatted input: %d %i %u %x %o %p %c %s %[…] %n %% and floats %f %e %g %a, with width, *, lengths hh h l ll z j t L and positional arguments; returns how many were stored',
    ),
    run: (h, a) => u64(scan(h, readCString(h, a(0)), a, 1, stdin(h))),
  },
  {
    name: 'sscanf',
    proto: 'int sscanf(const char *str, const char *format, ...)',
    desc: T('像 scanf 一样，从字符串里读；字符串在第一次存入之前就结束时返回 EOF（−1）', 'Like scanf, reading from a string; returns EOF (−1) when the string ends before the first value is stored'),
    run: (h, a) => u64(scan(h, readCString(h, a(1)), a, 2, bytesSource(readCString(h, a(0))))),
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
      const before = h.os
      free(h, p, 'realloc')
      const q = malloc(h, n)
      // On failure the old block stays as it was.
      if (q === 0n) {
        h.os = before
        return 0n
      }
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
      let end = false
      for (let i = 0n; i < a(2); i++) {
        const b: bigint = end ? 0n : h.load(a(1) + i, 1)
        end ||= b === 0n
        h.store(a(0) + i, 1, b)
      }
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
      copy(h, a(0), a(1), a(2), false)
      return a(0)
    },
  },
  {
    name: 'memmove',
    proto: 'void *memmove(void *dst, const void *src, size_t n)',
    desc: T('复制 n 个字节，两块内存可以重叠', 'Copy n bytes; the two blocks may overlap'),
    run: (h, a) => {
      // Copying from the end first when dst is above src never overwrites a byte before it is read.
      copy(h, a(0), a(1), a(2), a(0) > a(1))
      return a(0)
    },
  },
  {
    name: 'memset',
    proto: 'void *memset(void *p, int c, size_t n)',
    desc: T('把 n 个字节都设成 c，返回 p', 'Set n bytes to c; returns p'),
    run: (h, a) => {
      const c = a(1) & 0xffn
      for (let i = 0n; i < a(2); i++) h.store(a(0) + i, 1, c)
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
    run: (h, a) => u64(BigInt.asIntN(32, strtol(h, a(0), 10)!.value)),
  },
  {
    name: 'atol',
    proto: 'long atol(const char *s)',
    desc: T('把十进制字符串转成 long（64 位）', 'Convert a decimal string to a long (64-bit)'),
    run: (h, a) => u64(strtol(h, a(0), 10)!.value),
  },
  {
    name: 'strtol',
    proto: 'long strtol(const char *s, char **end, int base)',
    desc: T('按进制 base（0 表示自动识别 0x、0 前缀）转换字符串，*end 指向没用到的部分', 'Convert a string in base base (0: detect 0x and 0 prefixes); *end points past the digits used'),
    run: (h, a) => {
      const r = strtol(h, a(0), i32(a(2)))
      if (!r) return 0n
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
