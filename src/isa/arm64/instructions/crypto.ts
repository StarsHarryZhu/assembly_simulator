/**
 * The cryptographic extensions: AES (one round's SubBytes, ShiftRows, AddRoundKey and MixColumns), SHA-1,
 * SHA-256, SHA-512, SHA-3 (EOR3, RAX1, XAR, BCAX), SM3 and SM4. The S-boxes are computed from their
 * algebraic definitions (inverse in a finite field, then an affine map), not copied from tables.
 */
import { T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { readV, writeV } from './vec'

const INSTRS_: InstrSpec[] = []
const ALIASES_: AliasSpec[] = []

/* ------------------------------------------------------------------ finite fields and S-boxes */

/** Multiply in GF(2^8) modulo the polynomial `poly` (with its x^8 bit). */
function gmul(a: number, b: number, poly: number): number {
  let r = 0
  for (let x = a, y = b; y; y >>= 1) {
    if (y & 1) r ^= x
    x <<= 1
    if (x & 0x100) x ^= poly
  }
  return r
}
function ginv(a: number, poly: number): number {
  if (a === 0) return 0
  for (let b = 1; b < 256; b++) if (gmul(a, b, poly) === 1) return b
  return 0
}
const rotl8 = (v: number, n: number) => ((v << n) | (v >> (8 - n))) & 0xff

/** AES: inverse modulo x^8 + x^4 + x^3 + x + 1, then b ^ rotl(b,1..4) ^ 0x63. */
const AES_SBOX = Array.from({ length: 256 }, (_, x) => {
  const b = ginv(x, 0x11b)
  return b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ 0x63
})
const AES_INV = Array<number>(256)
AES_SBOX.forEach((v, i) => (AES_INV[v] = i))

/** SM4: the affine map A (rows of 0xa7 rotated) with 0xd3, around the inverse modulo x^8+x^7+x^6+x^5+x^4+x^2+1. */
function sm4Affine(x: number): number {
  let r = 0
  for (let i = 0; i < 8; i++) {
    const row = rotl8(0xa7, i)
    let p = row & x
    p ^= p >> 4
    p ^= p >> 2
    p ^= p >> 1
    r |= (p & 1) << i
  }
  return r ^ 0xd3
}
const SM4_SBOX = Array.from({ length: 256 }, (_, x) => sm4Affine(ginv(sm4Affine(x), 0x1f5)))

export const SBOXES = { aes: AES_SBOX, aesInv: AES_INV, sm4: SM4_SBOX }

/* ------------------------------------------------------------------ AES */

const bytesOf = (c: Cpu, n: number) => c.vread(n, 16)
/** ShiftRows on the column-major state (byte i = row i % 4, column i / 4). */
export const shiftRows = (s: Uint8Array, inv: boolean) => Uint8Array.from({ length: 16 }, (_, i) => {
  const row = i & 3
  const col = i >> 2
  return s[(((col + (inv ? -row : row)) & 3) << 2) | row]!
})
export function mixColumns(s: Uint8Array, inv: boolean): Uint8Array {
  const out = new Uint8Array(16)
  const m = inv ? [14, 11, 13, 9] : [2, 3, 1, 1]
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let v = 0
      for (let k = 0; k < 4; k++) v ^= gmul(s[col * 4 + ((row + k) & 3)]!, m[k]!, 0x11b)
      out[col * 4 + row] = v
    }
  return out
}
for (const [opc, m, desc, fn] of [
  [0b00100, 'aese', T('AES 加密一轮的前半：AddRoundKey（与 Vn 异或）、ShiftRows、SubBytes', 'AES encrypt round, first half: AddRoundKey (XOR with Vn), ShiftRows, SubBytes'), (d: Uint8Array, n: Uint8Array) => shiftRows(Uint8Array.from(d, (v, i) => AES_SBOX[v ^ n[i]!]!), false)],
  [0b00101, 'aesd', T('AES 解密一轮的前半：AddRoundKey、InvShiftRows、InvSubBytes', 'AES decrypt round, first half: AddRoundKey, InvShiftRows, InvSubBytes'), (d: Uint8Array, n: Uint8Array) => shiftRows(Uint8Array.from(d, (v, i) => AES_INV[v ^ n[i]!]!), true)],
  [0b00110, 'aesmc', T('AES MixColumns', 'AES MixColumns'), (_d: Uint8Array, n: Uint8Array) => mixColumns(n, false)],
  [0b00111, 'aesimc', T('AES InvMixColumns', 'AES InvMixColumns'), (_d: Uint8Array, n: Uint8Array) => mixColumns(n, true)],
] as [number, string, Text, (d: Uint8Array, n: Uint8Array) => Uint8Array][])
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'crypto',
    feature: 'aes',
    bits: `01001110 00 10100 ${opc.toString(2).padStart(5, '0')} 10 Rn:5 Rd:5`,
    syntax: '<Vd:b:1>, <Vn:b:1>',
    desc,
    exec: (c, f) => {
      // aese/aesd read Vd too; the state is shifted before SubBytes, which commutes with it.
      c.vwrite(f.Rd!, fn(bytesOf(c, f.Rd!), bytesOf(c, f.Rn!)))
    },
  })

/* ------------------------------------------------------------------ 32-bit word helpers */

/** A register as four 32-bit words, element 0 first (bits 31:0). */
const words = (c: Cpu, n: number) => readV(c, n, 2, 16).map(Number)
const putWords = (c: Cpu, n: number, w: number[]) =>
  writeV(
    c,
    n,
    w.map((v) => BigInt(v >>> 0)),
    2,
  )
export const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0
const ror = (x: number, n: number) => rol(x, 32 - n)
const add = (...v: number[]) => v.reduce((a, b) => (a + b) >>> 0, 0)
const choose = (x: number, y: number, z: number) => ((x & y) | (~x & z)) >>> 0
const parity = (x: number, y: number, z: number) => (x ^ y ^ z) >>> 0
const majority = (x: number, y: number, z: number) => ((x & y) | (x & z) | (y & z)) >>> 0

/* ------------------------------------------------------------------ SHA-1 and SHA-256 */

const SHA_THREE: [number, string, string, Text, string][] = [
  [0b000, 'sha1c', '<Qd>, <Sn>, <Vm:s:1>', T('SHA-1 哈希更新，选择函数（4 轮）', 'SHA-1 hash update, choose function (4 rounds)'), 'sha1'],
  [0b001, 'sha1p', '<Qd>, <Sn>, <Vm:s:1>', T('SHA-1 哈希更新，奇偶函数（4 轮）', 'SHA-1 hash update, parity function (4 rounds)'), 'sha1'],
  [0b010, 'sha1m', '<Qd>, <Sn>, <Vm:s:1>', T('SHA-1 哈希更新，多数函数（4 轮）', 'SHA-1 hash update, majority function (4 rounds)'), 'sha1'],
  [0b011, 'sha1su0', '<Vd:s:1>, <Vn:s:1>, <Vm:s:1>', T('SHA-1 消息扩展第一部分', 'SHA-1 schedule update, part 0'), 'sha1'],
  [0b100, 'sha256h', '<Qd>, <Qn>, <Vm:s:1>', T('SHA-256 哈希更新，第一部分（4 轮）', 'SHA-256 hash update, part 1 (4 rounds)'), 'sha256'],
  [0b101, 'sha256h2', '<Qd>, <Qn>, <Vm:s:1>', T('SHA-256 哈希更新，第二部分（4 轮）', 'SHA-256 hash update, part 2 (4 rounds)'), 'sha256'],
  [0b110, 'sha256su1', '<Vd:s:1>, <Vn:s:1>, <Vm:s:1>', T('SHA-256 消息扩展第二部分', 'SHA-256 schedule update, part 1'), 'sha256'],
]
function sha1(X: number[], y: number, W: number[], f: (x: number, y: number, z: number) => number): number[] {
  const x = [...X]
  for (let e = 0; e < 4; e++) {
    const t = f(x[1]!, x[2]!, x[3]!)
    y = add(y, rol(x[0]!, 5), t, W[e]!)
    x[1] = rol(x[1]!, 30)
    // <Y, X> = ROL(Y:X, 32)
    const top = x[3]!
    x[3] = x[2]!
    x[2] = x[1]!
    x[1] = x[0]!
    x[0] = y
    y = top
  }
  return x
}
const S0 = (x: number) => ror(x, 2) ^ ror(x, 13) ^ ror(x, 22)
const S1 = (x: number) => ror(x, 6) ^ ror(x, 11) ^ ror(x, 25)
function sha256(X0: number[], Y0: number[], W: number[], part1: boolean): number[] {
  const x = [...X0]
  const y = [...Y0]
  for (let e = 0; e < 4; e++) {
    const chs = choose(y[0]!, y[1]!, y[2]!)
    const maj = majority(x[0]!, x[1]!, x[2]!)
    const t = add(y[3]!, S1(y[0]!) >>> 0, chs, W[e]!)
    x[3] = add(t, x[3]!)
    y[3] = add(t, S0(x[0]!) >>> 0, maj)
    // <Y, X> = ROL(Y:X, 32): words move up one place, Y's top word into X's bottom and X's top into Y's.
    const xt = x[3]!
    const yt = y[3]!
    x.splice(3, 1)
    y.splice(3, 1)
    x.unshift(yt)
    y.unshift(xt)
  }
  return part1 ? x : y
}
for (const [opc, m, syntax, desc, feature] of SHA_THREE)
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'crypto',
    feature,
    bits: `01011110 00 0 Rm:5 0 ${opc.toString(2).padStart(3, '0')} 00 Rn:5 Rd:5`,
    syntax,
    desc,
    exec: (c, f) => {
      const D = words(c, f.Rd!)
      const N = words(c, f.Rn!)
      const M = words(c, f.Rm!)
      let r: number[]
      if (opc < 3) r = sha1(D, N[0]!, M, [choose, parity, majority][opc]!)
      else if (opc === 3) r = [D[2]! ^ D[0]! ^ M[0]!, D[3]! ^ D[1]! ^ M[1]!, N[0]! ^ D[2]! ^ M[2]!, N[1]! ^ D[3]! ^ M[3]!]
      else if (opc === 4) r = sha256(D, N, M, true)
      else if (opc === 5) r = sha256(N, D, M, false)
      else {
        const T0 = [N[1]!, N[2]!, N[3]!, M[0]!]
        const s1 = (x: number) => (ror(x, 17) ^ ror(x, 19) ^ (x >>> 10)) >>> 0
        r = []
        for (let e = 0; e < 4; e++) r[e] = add(s1(e < 2 ? M[e + 2]! : r[e - 2]!), D[e]!, T0[e]!)
      }
      putWords(c, f.Rd!, r)
    },
  })

for (const [opc, m, syntax, desc, feature] of [
  [0b00000, 'sha1h', '<Sd>, <Sn>', T('SHA-1 固定旋转：左旋 30 位', 'SHA-1 fixed rotate: rotate left by 30'), 'sha1'],
  [0b00001, 'sha1su1', '<Vd:s:1>, <Vn:s:1>', T('SHA-1 消息扩展第二部分', 'SHA-1 schedule update, part 1'), 'sha1'],
  [0b00010, 'sha256su0', '<Vd:s:1>, <Vn:s:1>', T('SHA-256 消息扩展第一部分', 'SHA-256 schedule update, part 0'), 'sha256'],
] as const)
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'crypto',
    feature,
    bits: `01011110 00 10100 ${opc.toString(2).padStart(5, '0')} 10 Rn:5 Rd:5`,
    syntax,
    desc,
    exec: (c, f) => {
      const N = words(c, f.Rn!)
      if (opc === 0) return putWords(c, f.Rd!, [rol(N[0]!, 30)])
      const D = words(c, f.Rd!)
      if (opc === 1) {
        const t = [D[0]! ^ N[1]!, D[1]! ^ N[2]!, D[2]! ^ N[3]!, D[3]!]
        return putWords(c, f.Rd!, [rol(t[0]!, 1), rol(t[1]!, 1), rol(t[2]!, 1), rol(t[3]!, 1) ^ rol(t[0]!, 2)])
      }
      const T0 = [D[1]!, D[2]!, D[3]!, N[0]!]
      putWords(
        c,
        f.Rd!,
        T0.map((x, e) => add((ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) >>> 0, D[e]!)),
      )
    },
  })

/* ------------------------------------------------------------------ SHA-512 and SHA-3 */

const M64 = (1n << 64n) - 1n
const ror64 = (x: bigint, n: number) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64
const dwords = (c: Cpu, n: number) => readV(c, n, 3, 16) as [bigint, bigint]
const put64 = (c: Cpu, n: number, lo: bigint, hi: bigint) => writeV(c, n, [lo & M64, hi & M64], 3)

const SHA512: [string, string, number, Text, (D: bigint[], N: bigint[], M: bigint[]) => [bigint, bigint]][] = [
  [
    'sha512h',
    '<Qd>, <Qn>, <Vm:d:1>',
    0b000,
    T('SHA-512 哈希更新，第一部分（2 轮）', 'SHA-512 hash update, part 1 (2 rounds)'),
    (W, X, Y) => {
      const sig = (v: bigint) => ror64(v, 14) ^ ror64(v, 18) ^ ror64(v, 41)
      const hi = (((Y[1]! & X[0]!) ^ (~Y[1]! & M64 & X[1]!)) + sig(Y[1]!) + W[1]!) & M64
      const tmp = (hi + Y[0]!) & M64
      const lo = ((tmp & Y[1]!) ^ (~tmp & M64 & X[0]!)) + sig(tmp) + W[0]!
      return [lo, hi]
    },
  ],
  [
    'sha512h2',
    '<Qd>, <Qn>, <Vm:d:1>',
    0b001,
    T('SHA-512 哈希更新，第二部分（2 轮）', 'SHA-512 hash update, part 2 (2 rounds)'),
    (W, X, Y) => {
      const sig = (v: bigint) => ror64(v, 28) ^ ror64(v, 34) ^ ror64(v, 39)
      const hi = (((X[0]! & Y[1]!) ^ (X[0]! & Y[0]!) ^ (Y[1]! & Y[0]!)) + sig(Y[0]!) + W[1]!) & M64
      const lo = ((hi & Y[0]!) ^ (hi & Y[1]!) ^ (Y[1]! & Y[0]!)) + sig(hi) + W[0]!
      return [lo, hi]
    },
  ],
  [
    'sha512su1',
    '<Vd:d:1>, <Vn:d:1>, <Vm:d:1>',
    0b010,
    T('SHA-512 消息扩展第二部分', 'SHA-512 schedule update, part 1'),
    (W, X, Y) => {
      const sig = (v: bigint) => ror64(v, 19) ^ ror64(v, 61) ^ (v >> 6n)
      return [W[0]! + sig(X[0]!) + Y[0]!, W[1]! + sig(X[1]!) + Y[1]!]
    },
  ],
  [
    'rax1',
    '<Vd:d:1>, <Vn:d:1>, <Vm:d:1>',
    0b011,
    T('SHA-3：Vn 异或左旋 1 位的 Vm（每个 64 位元素）', 'SHA-3: Vn XOR (Vm rotated left by 1), per 64-bit element'),
    (_W, X, Y) => [X[0]! ^ ror64(Y[0]!, 63), X[1]! ^ ror64(Y[1]!, 63)],
  ],
]
for (const [m, syntax, opc, desc, fn] of SHA512)
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'crypto',
    feature: m === 'rax1' ? 'sha3' : 'sha512',
    bits: `11001110011 Rm:5 1 0 00 ${opc.toString(2).padStart(2, '0').slice(-2)} Rn:5 Rd:5`,
    syntax,
    desc,
    exec: (c, f) => {
      const [lo, hi] = fn(m === 'rax1' ? [0n, 0n] : dwords(c, f.Rd!), dwords(c, f.Rn!), dwords(c, f.Rm!))
      put64(c, f.Rd!, lo, hi)
    },
  })
INSTRS_.push({
  id: 'sha512su0',
  mnemonic: 'sha512su0',
  group: 'crypto',
  feature: 'sha512',
  bits: '11001110110000001000 00 Rn:5 Rd:5',
  syntax: '<Vd:d:1>, <Vn:d:1>',
  desc: T('SHA-512 消息扩展第一部分', 'SHA-512 schedule update, part 0'),
  exec: (c, f) => {
    const sig = (v: bigint) => ror64(v, 1) ^ ror64(v, 8) ^ (v >> 7n)
    const X = dwords(c, f.Rd!)
    const W = dwords(c, f.Rn!)
    put64(c, f.Rd!, X[0] + sig(X[1]), X[1] + sig(W[0]))
  },
})
for (const [op0, m, desc, fn] of [
  [0, 'eor3', T('三个寄存器按位异或', 'Exclusive OR of three registers'), (n: bigint, m: bigint, a: bigint) => n ^ m ^ a],
  [1, 'bcax', T('按位清除后异或：Vn ^ (Vm & ~Va)', 'Bit clear and exclusive OR: Vn ^ (Vm & ~Va)'), (n: bigint, m: bigint, a: bigint) => n ^ (m & ~a)],
] as const)
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'crypto',
    feature: 'sha3',
    bits: `110011100 0${op0} Rm:5 0 Ra:5 Rn:5 Rd:5`,
    syntax: '<Vd:b:1>, <Vn:b:1>, <Vm:b:1>, <Va:b:1>',
    desc,
    exec: (c, f) => {
      const N = dwords(c, f.Rn!)
      const M = dwords(c, f.Rm!)
      const A = dwords(c, f.Ra!)
      put64(c, f.Rd!, fn(N[0], M[0], A[0]) & M64, fn(N[1], M[1], A[1]) & M64)
    },
  })
INSTRS_.push({
  id: 'xar',
  mnemonic: 'xar',
  group: 'crypto',
  feature: 'sha3',
  bits: '11001110100 Rm:5 imm6:6 Rn:5 Rd:5',
  syntax: '<Vd:d:1>, <Vn:d:1>, <Vm:d:1>, #<u:imm6>',
  desc: T('异或后右旋：每个 64 位元素 (Vn ^ Vm) 右旋 #imm 位', 'Exclusive OR and rotate: each 64-bit element (Vn ^ Vm) rotated right by #imm'),
  exec: (c, f) => {
    const N = dwords(c, f.Rn!)
    const M = dwords(c, f.Rm!)
    const r = (v: bigint) => (f.imm6 ? ror64(v, f.imm6) : v)
    put64(c, f.Rd!, r(N[0] ^ M[0]), r(N[1] ^ M[1]))
  },
})

/* ------------------------------------------------------------------ SM3 */

INSTRS_.push({
  id: 'sm3ss1',
  mnemonic: 'sm3ss1',
  group: 'crypto',
  feature: 'sm3',
  bits: '110011100 10 Rm:5 0 Ra:5 Rn:5 Rd:5',
  syntax: '<Vd:s:1>, <Vn:s:1>, <Vm:s:1>, <Va:s:1>',
  desc: T('SM3：计算 SS1 = ((Vn[3] <<< 12) + Vm[3] + Va[3]) <<< 7', 'SM3: SS1 = ((Vn[3] <<< 12) + Vm[3] + Va[3]) <<< 7'),
  exec: (c, f) => putWords(c, f.Rd!, [0, 0, 0, rol(add(rol(words(c, f.Rn!)[3]!, 12), words(c, f.Rm!)[3]!, words(c, f.Ra!)[3]!), 7)]),
})
for (const [opc, m, desc] of [
  [0, 'sm3tt1a', T('SM3 压缩函数 TT1（前 16 轮）', 'SM3 compression TT1 (rounds 0–15)')],
  [1, 'sm3tt1b', T('SM3 压缩函数 TT1（后 48 轮）', 'SM3 compression TT1 (rounds 16–63)')],
  [2, 'sm3tt2a', T('SM3 压缩函数 TT2（前 16 轮）', 'SM3 compression TT2 (rounds 0–15)')],
  [3, 'sm3tt2b', T('SM3 压缩函数 TT2（后 48 轮）', 'SM3 compression TT2 (rounds 16–63)')],
] as const)
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'crypto',
    feature: 'sm3',
    bits: `11001110010 Rm:5 10 imm2:2 ${opc.toString(2).padStart(2, '0')} Rn:5 Rd:5`,
    syntax: '<Vd:s:1>, <Vn:s:1>, <X:m:s:imm2>',
    desc,
    exec: (c, f) => {
      const D = words(c, f.Rd!)
      const N = words(c, f.Rn!)
      const w = words(c, f.Rm!)[f.imm2!]!
      let top: number
      if (opc < 2) {
        const ss2 = (N[3]! ^ rol(D[3]!, 12)) >>> 0
        const ff = opc === 0 ? parity(D[1]!, D[3]!, D[2]!) : majority(D[3]!, D[1]!, D[2]!)
        top = add(ff, D[0]!, ss2, w)
      } else {
        const gg = opc === 2 ? parity(D[1]!, D[3]!, D[2]!) : ((D[3]! & D[2]!) | (~D[3]! & D[1]!)) >>> 0
        const tt2 = add(gg, D[0]!, N[3]!, w)
        top = (tt2 ^ rol(tt2, 9) ^ rol(tt2, 17)) >>> 0
      }
      putWords(c, f.Rd!, [D[1]!, rol(D[2]!, opc < 2 ? 9 : 19), D[3]!, top])
    },
  })

/* ------------------------------------------------------------------ SM3 message expansion, SM4 */

const sm4T = (x: number) => {
  let v = 0
  for (let i = 0; i < 4; i++) v |= SM4_SBOX[(x >>> (8 * i)) & 0xff]! << (8 * i)
  return v >>> 0
}
export function sm4Rounds(state: number[], keys: number[], linear: (x: number) => number): number[] {
  const v = [...state]
  for (let i = 0; i < 4; i++) {
    const b = sm4T((v[3]! ^ v[2]! ^ v[1]! ^ keys[i]!) >>> 0)
    const r = (linear(b) ^ v[0]!) >>> 0
    v.shift()
    v.push(r)
  }
  return v
}
for (const [opc, m, desc, feature] of [
  [0b00, 'sm3partw1', T('SM3 消息扩展第一部分', 'SM3 message expansion, part 1'), 'sm3'],
  [0b01, 'sm3partw2', T('SM3 消息扩展第二部分', 'SM3 message expansion, part 2'), 'sm3'],
  [0b10, 'sm4ekey', T('SM4 密钥扩展：由 Vn 的 4 个字和 Vm 的 4 个常数算出 4 个轮密钥', 'SM4 key expansion: 4 round keys from the words of Vn and the constants in Vm'), 'sm4'],
] as const)
  INSTRS_.push({
    id: m,
    mnemonic: m,
    group: 'crypto',
    feature,
    bits: `11001110011 Rm:5 1 1 00 ${opc.toString(2).padStart(2, '0')} Rn:5 Rd:5`,
    syntax: '<Vd:s:1>, <Vn:s:1>, <Vm:s:1>',
    desc,
    exec: (c, f) => {
      const N = words(c, f.Rn!)
      const M = words(c, f.Rm!)
      if (opc === 2) return putWords(c, f.Rd!, sm4Rounds(N, M, (x) => x ^ rol(x, 13) ^ rol(x, 23)))
      const D = words(c, f.Rd!)
      if (opc === 0) {
        const r = [0, 1, 2].map((i) => (D[i]! ^ N[i]! ^ rol(M[i + 1]!, 15)) >>> 0)
        r[3] = (D[3]! ^ N[3]!) >>> 0
        for (let i = 0; i < 4; i++) {
          if (i === 3) r[3] = (r[3]! ^ rol(r[0]!, 15)) >>> 0
          r[i] = (r[i]! ^ rol(r[i]!, 15) ^ rol(r[i]!, 23)) >>> 0
        }
        return putWords(c, f.Rd!, r)
      }
      const tmp = N.map((n, i) => (n ^ rol(M[i]!, 7)) >>> 0)
      const r = D.map((d, i) => (d ^ tmp[i]!) >>> 0)
      let t2 = rol(tmp[0]!, 15)
      t2 = (t2 ^ rol(t2, 15) ^ rol(t2, 23)) >>> 0
      r[3] = (r[3]! ^ t2) >>> 0
      putWords(c, f.Rd!, r)
    },
  })
INSTRS_.push({
  id: 'sm4e',
  mnemonic: 'sm4e',
  group: 'crypto',
  feature: 'sm4',
  bits: '11001110110000001000 01 Rn:5 Rd:5',
  syntax: '<Vd:s:1>, <Vn:s:1>',
  desc: T('SM4 加密 4 轮：Vd 是状态，Vn 是 4 个轮密钥', 'SM4 encrypt 4 rounds: Vd is the state, Vn holds 4 round keys'),
  exec: (c, f) => putWords(c, f.Rd!, sm4Rounds(words(c, f.Rd!), words(c, f.Rn!), (x) => x ^ rol(x, 2) ^ rol(x, 10) ^ rol(x, 18) ^ rol(x, 24))),
})

export const INSTRS = INSTRS_
export const ALIASES = ALIASES_
