/**
 * Floating-point text for the C library: printf's %f %e %g %a (and their capitals) and scanf's reading of
 * numbers, done exactly with bigints the way glibc does it: the binary value's exact decimal expansion,
 * rounded half to even. Doubles, and binary128 for long double (%Lf).
 */
import * as sf from './softfloat'

export const F128: sf.Fmt = { n: 128, e: 15, f: 112 }

interface Decoded {
  neg: boolean
  kind: 'num' | 'inf' | 'nan'
  /** |value| = m × 2^e. */
  m: bigint
  e: number
}

function decode(bits: bigint, fmt: sf.Fmt): Decoded {
  const neg = ((bits >> BigInt(fmt.n - 1)) & 1n) === 1n
  const expAll = (1 << fmt.e) - 1
  const exp = Number((bits >> BigInt(fmt.f)) & BigInt(expAll))
  const frac = bits & ((1n << BigInt(fmt.f)) - 1n)
  const bias = (1 << (fmt.e - 1)) - 1
  if (exp === expAll) return { neg, kind: frac ? 'nan' : 'inf', m: 0n, e: 0 }
  if (exp === 0) return { neg, kind: 'num', m: frac, e: 1 - bias - fmt.f }
  return { neg, kind: 'num', m: frac | (1n << BigInt(fmt.f)), e: exp - bias - fmt.f }
}

const P10 = (k: number) => 10n ** BigInt(k)
const bitLen = (v: bigint) => v.toString(2).length

/** round(m × 2^e × 10^k), half to even. */
function scaled(m: bigint, e: number, k: number): bigint {
  let num = m * (k > 0 ? P10(k) : 1n)
  let den = k < 0 ? P10(-k) : 1n
  if (e >= 0) num <<= BigInt(e)
  else den <<= BigInt(-e)
  const q = num / den
  const r2 = (num % den) * 2n
  return r2 > den || (r2 === den && (q & 1n) === 1n) ? q + 1n : q
}

/** Digits with a decimal point `p` places from the right. */
function point(n: bigint, p: number, alt: boolean): string {
  const s = n.toString().padStart(p + 1, '0')
  if (p === 0) return alt ? `${s}.` : s
  return `${s.slice(0, -p)}.${s.slice(-p)}`
}

/** The digits and decimal exponent of m × 2^e to p places after the first digit (%e). */
function sci(m: bigint, e: number, p: number): [bigint, number] {
  if (m === 0n) return [0n, 0]
  let E = Math.floor((bitLen(m) - 1 + e) * Math.LOG10E * Math.LN2)
  for (;;) {
    const n = scaled(m, e, p - E)
    if (n >= P10(p + 1)) E++
    else if (n < P10(p)) E--
    else return [n, E]
  }
}
const expText = (E: number, upper: boolean) => `${upper ? 'E' : 'e'}${E < 0 ? '-' : '+'}${String(Math.abs(E)).padStart(2, '0')}`

function hexFloat(d: Decoded, fmt: sf.Fmt, precision: number, upper: boolean): string {
  const nibbles = Math.ceil(fmt.f / 4)
  const bias = (1 << (fmt.e - 1)) - 1
  let lead = d.m >> BigInt(fmt.f)
  let frac = (d.m & ((1n << BigInt(fmt.f)) - 1n)) << BigInt(nibbles * 4 - fmt.f)
  let exp = d.m === 0n ? 0 : lead ? d.e + fmt.f : 1 - bias
  let digits = nibbles
  if (precision >= 0 && precision < nibbles) {
    const drop = BigInt((nibbles - precision) * 4)
    const q = frac >> drop
    const r2 = (frac & ((1n << drop) - 1n)) * 2n
    const one = 1n << drop
    frac = r2 > one || (r2 === one && (q & 1n) === 1n) ? q + 1n : q
    digits = precision
    if (frac >> BigInt(digits * 4)) {
      frac &= (1n << BigInt(digits * 4)) - 1n
      lead++
    }
  }
  let f = digits ? frac.toString(16).padStart(digits, '0') : ''
  if (precision < 0) f = f.replace(/0+$/, '')
  else f = f.padEnd(precision, '0')
  if (d.m === 0n) exp = 0
  const s = `0x${lead.toString(16)}${f ? `.${f}` : ''}p${exp < 0 ? '-' : '+'}${Math.abs(exp)}`
  return upper ? s.toUpperCase() : s
}

/**
 * One floating-point conversion: the sign (empty, "-", "+" or " ") and the rest, so the caller can pad
 * with zeros between them. `special` is true for inf and nan, which are never zero-padded.
 */
export function formatFloat(bits: bigint, fmt: sf.Fmt, conv: string, flags: string, precision: number): { sign: string; body: string; special: boolean } {
  const d = decode(bits, fmt)
  const upper = conv === conv.toUpperCase()
  const sign = d.neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''
  if (d.kind !== 'num') {
    const t = d.kind === 'inf' ? 'inf' : 'nan'
    return { sign, body: upper ? t.toUpperCase() : t, special: true }
  }
  const alt = flags.includes('#')
  const c = conv.toLowerCase()
  if (c === 'a') return { sign, body: hexFloat(d, fmt, precision, upper), special: false }
  if (c === 'f') {
    const p = precision < 0 ? 6 : precision
    return { sign, body: point(scaled(d.m, d.e, p), p, alt), special: false }
  }
  if (c === 'e') {
    const p = precision < 0 ? 6 : precision
    const [n, E] = sci(d.m, d.e, p)
    return { sign, body: point(n, p, alt) + expText(E, upper), special: false }
  }
  // %g: the shorter of %e and %f by the exponent, trailing zeros removed unless '#'.
  const P = precision < 0 ? 6 : precision === 0 ? 1 : precision
  const [, E] = sci(d.m, d.e, P - 1)
  let body: string
  if (P > E && E >= -4) body = point(scaled(d.m, d.e, P - 1 - E), P - 1 - E, alt)
  else {
    const [n] = sci(d.m, d.e, P - 1)
    body = point(n, P - 1, alt)
    if (!alt && body.includes('.')) body = body.replace(/\.?0+$/, '')
    return { sign, body: body + expText(E, upper), special: false }
  }
  if (!alt && body.includes('.')) body = body.replace(/\.?0+$/, '')
  return { sign, body, special: false }
}

/* ------------------------------------------------------------------ reading */

/** The longest prefix of `text` that strtod accepts, and its length (0 when there is none). */
const NUMBER = /^[+-]?(?:inf(?:inity)?|nan(?:\([0-9a-z_]*\))?|0x(?:[0-9a-f]+\.?[0-9a-f]*|\.[0-9a-f]+)(?:p[+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i

/** Whether `text` could still grow into a number (scanf reads one character at a time). */
export function numberPrefix(text: string): boolean {
  return /^[+-]?(?:i(?:n(?:f(?:i(?:n(?:i(?:t(?:y)?)?)?)?)?)?)?|n(?:a(?:n(?:\([0-9a-z_]*\)?)?)?)?|0(?:x(?:[0-9a-f]*\.?[0-9a-f]*(?:p[+-]?\d*)?)?)?|\d*\.?\d*(?:e[+-]?\d*)?)?$/i.test(text)
}

/** Parse like strtod into the bits of `fmt`, correctly rounded (to nearest); null when it is not a number. */
export function parseFloatBits(text: string, fmt: sf.Fmt): bigint | null {
  const m = NUMBER.exec(text)
  if (!m) return null
  let s = m[0]
  const neg = s.startsWith('-')
  s = s.replace(/^[+-]/, '').toLowerCase()
  const signBit = neg ? 1n << BigInt(fmt.n - 1) : 0n
  const expAll = BigInt((1 << fmt.e) - 1) << BigInt(fmt.f)
  if (s.startsWith('inf')) return signBit | expAll
  if (s.startsWith('nan')) return signBit | expAll | (1n << BigInt(fmt.f - 1))
  let num: bigint
  let den = 1n
  if (s.startsWith('0x')) {
    const [, mant, p] = /^0x([0-9a-f.]*)(?:p([+-]?\d+))?$/.exec(s)!
    const [ip, fp = ''] = mant!.split('.')
    num = BigInt('0x' + ((ip ?? '') + fp || '0'))
    let e = Number(p ?? 0) - 4 * fp.length
    if (e >= 0) num <<= BigInt(Math.min(e, 20000))
    else den <<= BigInt(Math.min(-e, 20000))
  } else {
    const [, mant, x] = /^([0-9.]*)(?:e([+-]?\d+))?$/.exec(s)!
    const [ip, fp = ''] = mant!.split('.')
    num = BigInt((ip ?? '') + fp || '0')
    const e = Math.max(-20000, Math.min(20000, Number(x ?? 0) - fp.length))
    if (e >= 0) num *= P10(e)
    else den = P10(-e)
  }
  if (num === 0n) return signBit
  // Enough quotient bits for the format, plus a sticky bit for whatever the division left over.
  const k = fmt.f + 3 - (bitLen(num) - bitLen(den))
  const q = k >= 0 ? (num << BigInt(k)) / den : num / (den << BigInt(-k))
  const rem = k >= 0 ? (num << BigInt(k)) % den : num % (den << BigInt(-k))
  const mant = (q << 1n) | (rem ? 1n : 0n)
  return sf.round(new sf.FpEnv(0), fmt, neg ? 1 : 0, mant, -k - 1, sf.RN, { fpexc: false })
}
