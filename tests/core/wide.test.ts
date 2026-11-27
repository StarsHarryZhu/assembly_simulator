/** Helpers for 64-bit ISAs: hex and decimal of wide values, the two halves of a 64-bit address space, wide memory. */
import { describe, expect, it } from 'vitest'
import {
  addrOf,
  bfloatFromBits,
  bigOfBytes,
  binGroupsOf,
  halfFromBits,
  hex16,
  hexAddr,
  hexBits,
  hexOfBytes,
  signedText,
  unsignedText,
  vaOf,
} from '../../src/core/format'
import { WideMemory } from '../../src/core/memory'
import { parseAddress, parseValue } from '../../src/ui/calc/values'

describe('wide values', () => {
  it('prints 64-bit values in hex, signed and unsigned', () => {
    expect(hex16(-1n)).toBe('0xffffffffffffffff')
    expect(hex16(0x1234)).toBe('0x0000000000001234')
    expect(hexBits(-1, 32)).toBe('0xffffffff')
    expect(hexBits(5n, 64)).toBe('0x0000000000000005')
    expect(hexBits(1n << 127n, 128)).toBe('0x8' + '0'.repeat(31))
    expect(signedText(0xffffffffffffffffn, 64)).toBe('-1')
    expect(unsignedText(-1n, 64)).toBe('18446744073709551615')
    expect(signedText(0x80000000, 32)).toBe('-2147483648')
  })

  it('groups bits by eight, most significant first, for any width', () => {
    expect(binGroupsOf(0x12345678, 32)).toEqual(['00010010', '00110100', '01010110', '01111000'])
    expect(binGroupsOf(1n, 64)).toHaveLength(8)
    expect(binGroupsOf(1n, 64)[7]).toBe('00000001')
    expect(binGroupsOf(0xabcd, 16)).toEqual(['10101011', '11001101'])
  })

  it('reads little-endian bytes as one number', () => {
    expect(bigOfBytes([0x78, 0x56, 0x34, 0x12], 0, 4)).toBe(0x12345678n)
    expect(bigOfBytes([0, 0xff, 0x01], 1, 2)).toBe(0x01ffn)
    expect(hexOfBytes([0x78, 0x56, 0x34, 0x12])).toBe('0x12345678')
  })

  it('decodes half and bfloat16 values', () => {
    expect(halfFromBits(0x3c00)).toBe(1)
    expect(halfFromBits(0xc000)).toBe(-2)
    expect(halfFromBits(0x0001)).toBe(2 ** -24)
    expect(halfFromBits(0x7c00)).toBe(Infinity)
    expect(halfFromBits(0x7e00)).toBeNaN()
    expect(bfloatFromBits(0x3f80)).toBe(1)
  })
})

describe('64-bit addresses', () => {
  it('folds the top half of the address space above 2^48 and back', () => {
    expect(vaOf(0x400000)).toBe(0x400000n)
    expect(addrOf(0xffff800000000000n)).toBe(2 ** 48 + 0x800000000000)
    expect(vaOf(2 ** 48 + 0x800000000000)).toBe(0xffff800000000000n)
    expect(addrOf(0x0001000000000000n)).toBeNull()
    expect(hexAddr(2 ** 48 + 16, 64)).toBe('0xffff000000000010')
    expect(hexAddr(0x10010000)).toBe('0x10010000')
  })

  it('parses wide values and addresses the way people type them', () => {
    expect(parseValue('0xffffffffffffffff', 64)).toBe(0xffffffffffffffffn)
    expect(parseValue('-1', 64)).toBe(0xffffffffffffffffn)
    expect(parseValue('18446744073709551616', 64)).toBeNull()
    expect(parseValue("'A'", 64)).toBe(65n)
    expect(parseValue('7', 32)).toBe(7)
    expect(parseAddress('0xffff800000000006', 64)).toBe(2 ** 48 + 0x800000000004)
    expect(parseAddress('0x00400003', 32)).toBe(0x400000)
    expect(parseAddress('0x0001000000000000', 64)).toBeNull()
  })
})

describe('WideMemory', () => {
  it('stores bytes far above 4 GB, across page boundaries, little-endian', () => {
    const m = new WideMemory()
    const high = 2 ** 48 + 0x800000000ffe // the last two bytes of a page in the top half
    m.setDword(high, 0x0102030405060708n)
    expect(m.getDword(high)).toBe(0x0102030405060708n)
    expect(m.getByte(high)).toBe(8)
    expect(m.getByte(high + 7)).toBe(1)
    expect(m.getWord(high + 4)).toBe(0x01020304)
    expect(m.getByte(0x800000000ffe)).toBe(0) // the low half is a different place
    m.setWord(0xfffffffff000, -2)
    expect(m.getWord(0xfffffffff000)).toBe(-2)
    expect(m.getHalf(0xfffffffff000)).toBe(0xfffe)
    m.load(0x400000, new TextEncoder().encode('hi\0'))
    expect(m.getCString(0x400000)).toBe('hi')
  })
})
