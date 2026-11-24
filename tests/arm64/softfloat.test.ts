/**
 * The soft-float core against the host's IEEE double and single arithmetic (round to nearest), plus the
 * flags and special cases the host cannot show. Bit-exact behaviour of every mode and FPCR control is
 * checked against the real CPU in native.test.ts.
 */
import { describe, expect, it } from 'vitest'
import * as sf from '../../src/isa/arm64/softfloat'

const dv = new DataView(new ArrayBuffer(8))
const bitsD = (v: number) => (dv.setFloat64(0, v), dv.getBigUint64(0))
const bitsS = (v: number) => (dv.setFloat32(0, v), BigInt(dv.getUint32(0)))
const numD = (b: bigint) => (dv.setBigUint64(0, b), dv.getFloat64(0))
const numS = (b: bigint) => (dv.setUint32(0, Number(b)), dv.getFloat32(0))

/** Random doubles over many magnitudes, with some specials. */
function values(n: number, seed: number): number[] {
  let s = seed
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff)
  const out = [0, -0, 1, -1, 0.5, 3, Infinity, -Infinity, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308]
  while (out.length < n) out.push((r() - 0.5) * 2 ** Math.floor((r() - 0.5) * 2100))
  return out
}

describe('soft float', () => {
  const vs = values(300, 3)
  const env = () => new sf.FpEnv(0)

  it('adds, multiplies, divides and takes square roots like the host in double precision', () => {
    for (let i = 0; i < vs.length; i++)
      for (let j = 0; j < vs.length; j += 7) {
        const a = vs[i]!
        const b = vs[j]!
        const same = (got: bigint, want: number, what: string) => {
          if (Number.isNaN(want)) expect(Number.isNaN(numD(got)), what).toBe(true)
          else expect(numD(got), `${what} ${a} ${b}`).toBe(want)
        }
        same(sf.fpAdd(env(), sf.F64, bitsD(a), bitsD(b)), a + b, 'add')
        same(sf.fpSub(env(), sf.F64, bitsD(a), bitsD(b)), a - b, 'sub')
        same(sf.fpMul(env(), sf.F64, bitsD(a), bitsD(b)), a * b, 'mul')
        same(sf.fpDiv(env(), sf.F64, bitsD(a), bitsD(b)), a / b, 'div')
      }
    for (const a of vs) {
      const r = sf.fpSqrt(env(), sf.F64, bitsD(a))
      if (a < 0) expect(Number.isNaN(numD(r))).toBe(true)
      else expect(numD(r)).toBe(Math.sqrt(a))
    }
  })

  it('rounds single precision like Math.fround', () => {
    for (let i = 0; i < 200; i++)
      for (let j = 0; j < 200; j += 13) {
        const a = Math.fround(vs[i]! % 1e30)
        const b = Math.fround(vs[j]! % 1e30)
        expect(numS(sf.fpAdd(env(), sf.F32, bitsS(a), bitsS(b)))).toBe(Math.fround(a + b))
        expect(numS(sf.fpMul(env(), sf.F32, bitsS(a), bitsS(b)))).toBe(Math.fround(a * b))
        const q = sf.fpDiv(env(), sf.F32, bitsS(a), bitsS(b))
        if (!Number.isNaN(a / b)) expect(numS(q)).toBe(Math.fround(a / b))
      }
  })

  it('raises the exception flags', () => {
    const e = env()
    sf.fpDiv(e, sf.F64, bitsD(1), bitsD(3))
    expect(e.flags).toBe(sf.IXC)
    const z = env()
    sf.fpDiv(z, sf.F64, bitsD(1), bitsD(0))
    expect(z.flags).toBe(sf.DZC)
    const o = env()
    expect(numD(sf.fpMul(o, sf.F64, bitsD(1e300), bitsD(1e300)))).toBe(Infinity)
    expect(o.flags).toBe(sf.OFC | sf.IXC)
    const u = env()
    sf.fpMul(u, sf.F64, bitsD(1e-300), bitsD(1e-20))
    expect(u.flags).toBe(sf.UFC | sf.IXC)
    const n = env()
    sf.fpAdd(n, sf.F64, bitsD(Infinity), bitsD(-Infinity))
    expect(n.flags).toBe(sf.IOC)
  })

  it('converts between formats and to integers', () => {
    const e = env()
    expect(sf.fpConvert(e, sf.F64, sf.F16, bitsD(1.5))).toBe(0x3e00n)
    expect(sf.fpConvert(e, sf.F16, sf.F64, 0x3e00n)).toBe(bitsD(1.5))
    expect(sf.fpToFixed(e, sf.F64, bitsD(-2.5), 0, false, sf.RN, 32)).toBe(0xfffffffen)
    expect(sf.fpToFixed(e, sf.F64, bitsD(-2.5), 0, false, sf.RA, 32)).toBe(0xfffffffdn)
    expect(sf.fpToFixed(e, sf.F64, bitsD(1e20), 0, false, sf.RZ, 32)).toBe(0x7fffffffn)
    expect(sf.fixedToFp(e, sf.F32, 0xffffffffn, 0, true, 32)).toBe(bitsS(4294967296))
    expect(sf.fpRoundInt(env(), sf.F64, bitsD(-0.4), sf.RN, true)).toBe(bitsD(-0))
    expect(sf.fpRoundInt(env(), sf.F64, bitsD(2.5), sf.RN, false)).toBe(bitsD(2))
    expect(sf.fpRoundInt(env(), sf.F64, bitsD(2.5), sf.RA, false)).toBe(bitsD(3))
    expect(sf.fpToFixedJS(env(), bitsD(2 ** 32 + 5)).value).toBe(5n)
  })

  it('fuses multiply-add with a single rounding', () => {
    // 1 + 2^-53 is not representable; (1 + 2^-52)(1 - 2^-52) - 1 is exactly -2^-104 when fused.
    const a = bitsD(1 + 2 ** -52)
    const b = bitsD(1 - 2 ** -52)
    expect(numD(sf.fpMulAdd(env(), sf.F64, bitsD(-1), a, b))).toBe(-(2 ** -104))
  })
})
