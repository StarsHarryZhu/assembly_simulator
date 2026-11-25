/**
 * Helpers for the SME semantics: ZA as rows of elements, its tiles with their horizontal and vertical
 * slices, and the array vectors that SME2's multi-vector instructions address in groups.
 *
 * ZA has svl rows of svl bytes (svl = SVL / 8). The tiles of element size es (0–4 for 8 to 128 bits)
 * interleave: there are 2^es of them, each svl >> es elements square, and horizontal slice i of tile t is
 * ZA row i × 2^es + t. A vertical slice is element i of each of a tile's rows.
 */
import type { Cpu, Fields } from './types'
import { elems, toBytes } from './vec'
import * as sf from '../softfloat'

/**
 * A floating-point environment for results that go to ZA: default NaN, and no flags reach FPSR (the M5
 * agrees for every SME and SME2 instruction that writes ZA).
 */
export const zaEnv = (c: Cpu) => c.fpEnv().with(sf.DN)

/** Elements of ZA row r. */
export const zaGet = (c: Cpu, r: number, es: number): bigint[] => elems(c.zaRead(r), es)
/** Write elements to ZA row r. */
export const zaSet = (c: Cpu, r: number, vals: bigint[], es: number): void => c.zaWrite(r, toBytes(vals, es))

/** Rows (and columns) of a tile of element size es. */
export const tileDim = (c: Cpu, es: number) => c.svl >> es
/** ZA row of horizontal slice i of tile t. */
export const tileRow = (es: number, t: number, i: number) => (i << es) + t

/** The index register w12–w15 (field Rv) plus an offset, wrapped to the tile's dimension: a slice number. */
export const sliceAt = (c: Cpu, f: Fields, es: number, off: number) => Number((c.r(0, 12 + f.Rv!) + BigInt(off)) % BigInt(tileDim(c, es)))

/** Tile number and offset from a field holding the tile in its high es bits (see encoding/sme.ts). */
export function tileOff(f: Fields, field: string, width: number, es: number): { t: number; off: number } {
  const v = f[field] ?? 0
  const ob = width - es
  return { t: v >> ob, off: v & ((1 << ob) - 1) }
}

/** Slice i of tile t (vertical when v) as elements. */
export function sliceGet(c: Cpu, es: number, t: number, v: boolean, i: number): bigint[] {
  if (!v) return zaGet(c, tileRow(es, t, i), es)
  const d = tileDim(c, es)
  return Array.from({ length: d }, (_, j) => zaGet(c, tileRow(es, t, j), es)[i]!)
}

/** Write slice i of tile t; elements whose `keep` flag is true keep their old value. */
export function sliceSet(c: Cpu, es: number, t: number, v: boolean, i: number, vals: bigint[], keep?: boolean[]): void {
  if (!v) {
    const r = tileRow(es, t, i)
    const old = keep?.some(Boolean) ? zaGet(c, r, es) : null
    zaSet(c, r, vals.map((x, j) => (keep?.[j] ? old![j]! : x)), es)
    return
  }
  const d = tileDim(c, es)
  for (let j = 0; j < d; j++) {
    if (keep?.[j]) continue
    const r = tileRow(es, t, j)
    const row = zaGet(c, r, es)
    row[i] = vals[j]!
    zaSet(c, r, row, es)
  }
}

/** Rewrite every row of tile t whose `rows` flag is set: fn gets the row's elements and returns the new ones. */
export function tileRows(c: Cpu, es: number, t: number, rows: boolean[], fn: (i: number, row: bigint[]) => bigint[]): void {
  const d = tileDim(c, es)
  for (let i = 0; i < d; i++) {
    if (!rows[i]) continue
    const r = tileRow(es, t, i)
    zaSet(c, r, fn(i, zaGet(c, r, es)), es)
  }
}

/**
 * The ZA vectors of an SME2 vector-group operand: `vg` groups (1, 2 or 4) of `n` consecutive vectors each.
 * The first vector is (w8–w11 + offset) mod (svl / vg), rounded down to a multiple of n; group g starts
 * g × svl / vg after it. Returns the rows, group by group.
 */
export function zaVectors(c: Cpu, f: Fields, off: number, n: number, vg: number): number[][] {
  const stride = c.svl / vg
  let base = Number((c.r(0, 8 + f.Rv!) + BigInt(off)) % BigInt(stride))
  base -= base % n
  return Array.from({ length: vg }, (_, g) => Array.from({ length: n }, (_, k) => base + g * stride + k))
}
