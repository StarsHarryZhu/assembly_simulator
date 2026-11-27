/** Number formatting shared by every panel. Values are raw 32-bit patterns unless a name says otherwise. */
import type { RegValue } from './isa'

export function u32(v: number): number {
  return v >>> 0
}

export function hex8(v: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(8, '0')
}

export function hexN(v: number, digits: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(digits, '0').slice(-digits)
}

/** Sixteen hex digits: a 64-bit value (a bigint, or a number taken as unsigned). */
export function hex16(v: bigint | number): string {
  const b = typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt(v >>> 0)
  return '0x' + b.toString(16).padStart(16, '0')
}

/** A value of the given width as hex: eight digits for 32 bits and fewer, sixteen for 64. */
export function hexBits(v: RegValue, bits: number): string {
  if (bits <= 32) return hex8(Number(typeof v === 'bigint' ? BigInt.asUintN(32, v) : v))
  return '0x' + BigInt.asUintN(bits, BigInt(v)).toString(16).padStart(Math.ceil(bits / 4), '0')
}

/** A value of the given width read as a two's-complement signed number, in decimal. */
export function signedText(v: RegValue, bits: number): string {
  return BigInt.asIntN(bits, BigInt(v)).toString()
}

/** A value of the given width read as unsigned, in decimal. */
export function unsignedText(v: RegValue, bits: number): string {
  return BigInt.asUintN(bits, BigInt(v)).toString()
}

const TWO48 = 2 ** 48
const TOP_HALF = 0xffff000000000000n

/**
 * The 64-bit virtual address an address number stands for: numbers at or above 2^48 are the top half of the
 * address space (see MemoryLayout.addressBits).
 */
export function vaOf(addr: number): bigint {
  return addr >= TWO48 ? TOP_HALF + BigInt(addr - TWO48) : BigInt(addr)
}

/** A scratch cell: storing a bigint keeps it modulo 2^64, and the halves read back as numbers. */
const VA64 = new BigUint64Array(1)
const VA32 = new Uint32Array(VA64.buffer)

/**
 * The address number for a 64-bit virtual address, or null between the two halves. Every load and store
 * calls this, so it avoids BigInt arithmetic and Number(), a slow runtime call.
 */
export function addrOf(va: bigint): number | null {
  VA64[0] = va
  const hi = VA32[1]!
  const lo = VA32[0]!
  if (hi < 0x10000) return hi * 0x1_0000_0000 + lo
  if (hi >= 0xffff0000) return (hi - 0xffff0000) * 0x1_0000_0000 + lo + TWO48
  return null
}

/** An address as hex: eight digits in a 32-bit address space, sixteen in a 64-bit one. */
export function hexAddr(addr: number, bits: 32 | 64 = 32): string {
  return bits === 64 ? hex16(vaOf(addr)) : hex8(addr)
}

/** `n` little-endian bytes from `offset` as an unsigned bigint. */
export function bigOfBytes(bytes: ArrayLike<number>, offset: number, n: number): bigint {
  let v = 0n
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]! & 0xff)
  return v
}

export function bin32(v: number): string {
  return (v >>> 0).toString(2).padStart(32, '0')
}

export function binBits(v: number, n: number): string {
  return bin32(v).slice(32 - n)
}

/** Four groups of eight bits, most significant first. */
export function binGroups(v: number): string[] {
  const b = bin32(v)
  return [b.slice(0, 8), b.slice(8, 16), b.slice(16, 24), b.slice(24)]
}

/** Groups of eight bits of a value of the given width, most significant first. */
export function binGroupsOf(v: RegValue, bits: number): string[] {
  if (bits <= 32) return binGroups(Number(typeof v === 'bigint' ? BigInt.asUintN(32, v) : v)).slice(4 - Math.ceil(bits / 8))
  const b = BigInt.asUintN(bits, BigInt(v)).toString(2).padStart(bits, '0')
  return Array.from({ length: Math.ceil(bits / 8) }, (_, i) => b.slice(i * 8, i * 8 + 8))
}

/** Bytes as hex, most significant (last) byte first: how a vector register reads as one number. */
export function hexOfBytes(bytes: ArrayLike<number>): string {
  let s = ''
  for (let i = bytes.length - 1; i >= 0; i--) s += (bytes[i]! & 0xff).toString(16).padStart(2, '0')
  return '0x' + s
}

export function signed(v: number): number {
  return v | 0
}

export function unsigned(v: number): number {
  return v >>> 0
}

/** Printable form of one byte: the character, or an escape for control bytes. */
export function charOf(byte: number): string {
  byte &= 0xff
  const named: Record<number, string> = { 0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r' }
  if (named[byte]) return named[byte]!
  if (byte < 32 || byte === 127) return '·'
  return String.fromCharCode(byte)
}

/** The four bytes of a word as characters, most significant first. */
export function asciiOfWord(v: number): string {
  return [24, 16, 8, 0].map((s) => charOf(v >>> s)).join(' ')
}

const f32 = new Float32Array(1)
const i32 = new Int32Array(f32.buffer)
const f64 = new Float64Array(1)
const i64 = new Int32Array(f64.buffer)

export function floatFromBits(bits: number): number {
  i32[0] = bits
  return f32[0]!
}

export function bitsFromFloat(value: number): number {
  f32[0] = value
  return i32[0]!
}

/** An IEEE 754 half-precision value from its 16 bits. */
export function halfFromBits(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exp = (bits >>> 10) & 0x1f
  const frac = bits & 0x3ff
  if (exp === 0) return sign * frac * 2 ** -24
  if (exp === 31) return frac ? NaN : sign * Infinity
  return sign * (1 + frac / 1024) * 2 ** (exp - 15)
}

/** A bfloat16 value from its 16 bits (the top half of a single). */
export function bfloatFromBits(bits: number): number {
  return floatFromBits((bits & 0xffff) << 16)
}

/** Little-endian host: low word first. MIPS keeps the low word in the even register. */
export function doubleFromBits(low: number, high: number): number {
  i64[0] = low
  i64[1] = high
  return f64[0]!
}

export function bitsFromDouble(value: number): [low: number, high: number] {
  f64[0] = value
  return [i64[0]!, i64[1]!]
}

/** Format shortest round-trip digits the way Java's Double.toString / Float.toString do. */
function javaFormat(value: number, digits: string, exp: number): string {
  const sign = value < 0 || Object.is(value, -0) ? '-' : ''
  if (exp >= -3 && exp < 7) {
    let intPart: string
    let frac: string
    if (exp >= 0) {
      const padded = digits.padEnd(exp + 1, '0')
      intPart = padded.slice(0, exp + 1)
      frac = padded.slice(exp + 1)
    } else {
      intPart = '0'
      frac = '0'.repeat(-exp - 1) + digits
    }
    return sign + intPart + '.' + (frac === '' ? '0' : frac)
  }
  const rest = digits.slice(1)
  return sign + digits[0] + '.' + (rest === '' ? '0' : rest) + 'E' + exp
}

function special(value: number): string | null {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return 'Infinity'
  if (value === -Infinity) return '-Infinity'
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
  return null
}

/* Exact digit choice. Values are compared as fractions of BigInts, so no rounding can creep in. */

interface Ratio {
  n: bigint
  d: bigint
}

const view = new DataView(new ArrayBuffer(8))

/** A finite double >= 0 as an exact fraction. */
function ratioOf(v: number): Ratio {
  view.setFloat64(0, v)
  const hi = view.getUint32(0)
  const biased = (hi >>> 20) & 0x7ff
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4))
  if (biased) m |= 1n << 52n
  const e = (biased || 1) - 1075
  return e >= 0 ? { n: m << BigInt(e), d: 1n } : { n: m, d: 1n << BigInt(-e) }
}

const cmp = (a: Ratio, b: Ratio) => {
  const x = a.n * b.d - b.n * a.d
  return x < 0n ? -1 : x > 0n ? 1 : 0
}
const mid = (a: Ratio, b: Ratio): Ratio => ({ n: a.n * b.d + b.n * a.d, d: 2n * a.d * b.d })
const pow10 = (k: number): Ratio => (k >= 0 ? { n: 10n ** BigInt(k), d: 1n } : { n: 1n, d: 10n ** BigInt(-k) })

/** The neighbouring values of a positive finite float or double, and whether its significand is even. */
function neighbours(v: number, single: boolean): { down: number; up: number; even: boolean } {
  if (single) {
    view.setFloat32(0, v)
    const bits = view.getUint32(0)
    view.setUint32(0, bits - 1)
    const down = view.getFloat32(0)
    view.setUint32(0, bits + 1)
    return { down, up: view.getFloat32(0), even: (bits & 1) === 0 }
  }
  view.setFloat64(0, v)
  const bits = view.getBigUint64(0)
  view.setBigUint64(0, bits - 1n)
  const down = view.getFloat64(0)
  view.setBigUint64(0, bits + 1n)
  return { down, up: view.getFloat64(0), even: (bits & 1n) === 0n }
}

/**
 * The digits Java's Float.toString / Double.toString (JDK 19 and later, the versions MARS runs on today)
 * choose for a positive finite value: among the decimals that round back to it, those with the fewest
 * digits; of these the closest, a tie going to the even last digit. When one digit is enough, two-digit
 * decimals compete as well, which is why the smallest float prints as 1.4E-45 rather than 1.0E-45.
 */
function javaDigits(v: number, single: boolean): { digits: string; exp: number } {
  const x = ratioOf(v)
  const { down, up, even } = neighbours(v, single)
  const below = ratioOf(down)
  const lo = mid(x, below)
  // Past the largest finite value the next step is as wide as the last one.
  const hi = Number.isFinite(up) ? mid(x, ratioOf(up)) : { n: 3n * x.n * below.d - below.n * x.d, d: 2n * x.d * below.d }
  const rounds = (c: Ratio) => {
    const a = cmp(c, lo)
    const b = cmp(c, hi)
    return even ? a >= 0 && b <= 0 : a > 0 && b < 0
  }
  let e = Math.floor(Math.log10(v))
  while (cmp(pow10(e), x) > 0) e--
  while (cmp(pow10(e + 1), x) <= 0) e++
  // The p-digit decimals just below and above v, keeping those that round back to it.
  const pick = (p: number): { c: bigint; k: number } | null => {
    const k = e - p + 1
    const s = pow10(k)
    const qn = x.n * s.d
    const qd = x.d * s.n
    const c0 = qn / qd
    const ok = [c0, c0 + 1n].filter((c) => c > 0n && rounds({ n: c * s.n, d: s.d }))
    if (!ok.length) return null
    if (ok.length === 1) return { c: ok[0]!, k }
    const side = 2n * qn - (2n * c0 + 1n) * qd // < 0: c0 is closer
    return { c: side < 0n || (side === 0n && c0 % 2n === 0n) ? c0 : c0 + 1n, k }
  }
  for (let p = 1; p <= 17; p++) {
    const found = pick(p)
    if (!found) continue
    const { c, k } = p === 1 ? (pick(2) ?? found) : found
    const s = c.toString()
    return { digits: s.replace(/0+$/, '') || '0', exp: k + s.length - 1 }
  }
  throw new Error(`no decimal rounds to ${v}`)
}

function javaString(value: number, single: boolean): string {
  const s = special(value)
  if (s) return s
  const { digits, exp } = javaDigits(Math.abs(value), single)
  return javaFormat(value, digits, exp)
}

/** Java Double.toString. */
export function javaDouble(value: number): string {
  return javaString(value, false)
}

/** Java Float.toString, for a value that is exactly a float32. */
export function javaFloat(value: number): string {
  return javaString(value, true)
}
