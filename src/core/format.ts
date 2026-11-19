/** Number formatting shared by every panel. Values are raw 32-bit patterns unless a name says otherwise. */

export function u32(v: number): number {
  return v >>> 0
}

export function hex8(v: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(8, '0')
}

export function hexN(v: number, digits: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(digits, '0').slice(-digits)
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

function splitExponential(s: string): { digits: string; exp: number } {
  const m = /^-?(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s)!
  return { digits: (m[1]! + (m[2] ?? '')).replace(/0+$/, '') || '0', exp: Number(m[3]) }
}

/** Java Double.toString. */
export function javaDouble(value: number): string {
  const s = special(value)
  if (s) return s
  const { digits, exp } = splitExponential(value.toExponential())
  return javaFormat(value, digits, exp)
}

/** Java Float.toString, for a value that is exactly a float32. */
export function javaFloat(value: number): string {
  const s = special(value)
  if (s) return s
  for (let p = 1; p <= 9; p++) {
    const e = value.toExponential(p - 1)
    if (Math.fround(Number(e)) === value) {
      const { digits, exp } = splitExponential(e)
      return javaFormat(value, digits, exp)
    }
  }
  const { digits, exp } = splitExponential(value.toExponential(8))
  return javaFormat(value, digits, exp)
}
