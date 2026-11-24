/**
 * Helpers for the SVE semantics: Z registers as arrays of elements (unsigned bigints, VL bytes long),
 * predicates as one boolean per element, the PredTest flags, and the predicated read-modify-write pattern
 * most SVE instructions share. Element sizes are numbered 0–4 for 8, 16, 32, 64 and 128 bits.
 */
import type { Cpu } from './types'
import { elems, ESIZE, toBytes } from './vec'

/** Elements of Z register n. */
export const zget = (c: Cpu, n: number, es: number): bigint[] => elems(c.vread(n, c.vl), es)
/** Write elements to Z register n (the whole register). */
export const zset = (c: Cpu, n: number, vals: bigint[], es: number): void => c.vwrite(n, toBytes(vals, es))
/** Number of elements of size es in a vector. */
export const count = (c: Cpu, es: number) => (c.vl * 8) / ESIZE[es]!

/** Predicate n as one flag per element of size es (the bit of each element's first byte). */
export function pget(c: Cpu, n: number, es: number): boolean[] {
  const bits = c.pread(n)
  const step = ESIZE[es]! / 8
  const out: boolean[] = []
  for (let i = 0; i < bits.length; i += step) out.push(bits[i] === 1)
  return out
}

/** Bits of a predicate whose elements of size es are the given flags (other bits zero). */
export function pbits(c: Cpu, flags: boolean[], es: number): Uint8Array {
  const bits = new Uint8Array(c.vl)
  const step = ESIZE[es]! / 8
  flags.forEach((b, i) => {
    if (b) bits[i * step] = 1
  })
  return bits
}

export const pset = (c: Cpu, n: number, flags: boolean[], es: number): void => c.pwrite(n, pbits(c, flags, es))

/** All-true governing predicate, for unpredicated forms. */
export const allTrue = (c: Cpu, es: number): boolean[] => new Array(count(c, es)).fill(true)

/**
 * NZCV of PredTest: N the first active element of the result, Z none of the active elements, C not the
 * last active element, V clear.
 */
export function predTest(mask: boolean[], result: boolean[]): number {
  let first = -1
  let last = -1
  let any = false
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    if (first < 0) first = i
    last = i
    if (result[i]) any = true
  }
  const n = first >= 0 && result[first] ? 1 : 0
  const z = any ? 0 : 1
  const cflag = last >= 0 && result[last] ? 0 : 1
  return (n << 3) | (z << 2) | (cflag << 1)
}

/**
 * A predicated unary or binary operation on Zd: active elements get fn's result, inactive ones keep Zd
 * (merging) or become zero (zeroing). `src` is the register the merged value comes from (usually Zd).
 */
export function predicated(c: Cpu, d: number, es: number, pg: boolean[], merge: boolean, fn: (i: number) => bigint, src = d): void {
  const old = merge ? zget(c, src, es) : null
  const out = pg.map((on, i) => (on ? fn(i) : old ? old[i]! : 0n))
  zset(c, d, out, es)
}

/** Each element's flag from the bits of a predicate read at another element size. */
export const flagsAt = (bits: Uint8Array, es: number): boolean[] => {
  const step = ESIZE[es]! / 8
  const out: boolean[] = []
  for (let i = 0; i < bits.length; i += step) out.push(bits[i] === 1)
  return out
}
