/**
 * Data processing on registers: shifted and extended ADD/SUB, ADC/SBC, logical operations, multiply and
 * divide, shifts by register, bit operations (RBIT, REV, CLZ, CLS, CTZ, CNT, ABS), CRC32, the CSSC
 * minimum/maximum, conditional compare and select, the FlagM flag operations, and pointer authentication.
 */
import { T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import {
  addWithCarry,
  bitsOf,
  countLeadingZeros,
  countTrailingZeros,
  crc32,
  extendValue,
  logicFlags,
  M64,
  maskOf,
  nzcvOut,
  popcount,
  reverseBits,
  reverseBytes,
  rotateRight,
  shiftValue,
  signed,
  subWithBorrow,
} from './util'

const bin = (v: number, n: number) => v.toString(2).padStart(n, '0')

/* ------------------------------------------------------------------ 2-source */

const twoSource = (m: string, opcode: number, group: string, desc: Text, op: (sf: number, a: bigint, b: bigint) => bigint, feature?: string): InstrSpec => ({
  id: m,
  mnemonic: m,
  group,
  feature,
  bits: `sf 0 0 11010110 Rm:5 ${bin(opcode, 6)} Rn:5 Rd:5`,
  syntax: '<Rd>, <Rn>, <Rm>',
  desc,
  exec: (c, f) => c.setR(f.sf!, f.Rd!, op(f.sf!, c.r(f.sf!, f.Rn!), c.r(f.sf!, f.Rm!)) & maskOf(f.sf!)),
})

const minmax = (sf: number, a: bigint, b: bigint, isSigned: boolean, max: boolean) => {
  const x = isSigned ? signed(sf, a) : a
  const y = isSigned ? signed(sf, b) : b
  return BigInt.asUintN(64, max ? (x > y ? x : y) : x < y ? x : y)
}

const crc = (m: string, opcode: number, sz: number, sf: number, castagnoli: boolean): InstrSpec => ({
  id: m,
  mnemonic: m,
  group: 'bits',
  feature: 'crc32',
  bits: `${sf} 0 0 11010110 Rm:5 ${bin(opcode, 6)} Rn:5 Rd:5`,
  syntax: sf ? '<Wd>, <Wn>, <Xm>' : '<Wd>, <Wn>, <Wm>',
  desc: T(`用 ${castagnoli ? 'CRC-32C（Castagnoli）' : 'CRC-32'} 多项式，把 ${1 << sz} 字节数据累加进校验值`, `Accumulate ${1 << sz} byte(s) into a ${castagnoli ? 'CRC-32C (Castagnoli)' : 'CRC-32'} checksum`),
  exec: (c, f) => c.setR(0, f.Rd!, crc32(c.r(0, f.Rn!), c.x(f.Rm!), 1 << sz, castagnoli)),
})

/* ------------------------------------------------------------------ 1-source */

const oneSource = (m: string, opcode: number, desc: Text, op: (sf: number, v: bigint) => bigint, opts: { sf?: number; group?: string; feature?: string; syntax?: string } = {}): InstrSpec => ({
  id: opts.sf === undefined ? m : `${m}-${opts.sf ? 'x' : 'w'}`,
  mnemonic: m,
  group: opts.group ?? 'bits',
  feature: opts.feature,
  bits: `${opts.sf === undefined ? 'sf' : opts.sf} 1 0 11010110 00000 ${bin(opcode, 6)} Rn:5 Rd:5`,
  syntax: opts.syntax ?? '<Rd>, <Rn>',
  desc,
  exec: (c, f) => {
    const sf = opts.sf ?? f.sf!
    c.setR(sf, f.Rd!, op(sf, c.r(sf, f.Rn!)) & maskOf(sf))
  },
})

function cls(sf: number, v: bigint): bigint {
  const n = bitsOf(sf)
  const x = ((v >> 1n) ^ v) & (maskOf(sf) >> 1n)
  return BigInt(countLeadingZeros(x, n - 1))
}

/** Pointer authentication with keys disabled: signing and authenticating leave the pointer as it is. */
const pauth = (m: string, opcode: number, zero: boolean, desc: Text): InstrSpec => ({
  id: m,
  mnemonic: m,
  group: 'system',
  feature: 'pauth',
  bits: `1 1 0 11010110 00001 ${bin(opcode, 6)} ${zero ? '11111' : 'Rn:5'} Rd:5`,
  syntax: zero ? '<Xd>' : '<Xd>, <Xn|SP>',
  desc,
  exec: (c, f) => c.setX(f.Rd!, c.x(f.Rd!)),
})

/** XPACI/XPACD: replace the authentication code bits with copies of bit 55 (data pointers keep their top byte). */
function stripPac(v: bigint, data: boolean): bigint {
  const ext = (v >> 55n) & 1n
  const hi = data ? 54n : 63n
  let out = v
  for (let b = 48n; b <= hi; b++) out = ext ? out | (1n << b) : out & ~(1n << b)
  return out & M64
}

/* ------------------------------------------------------------------ shifted and extended register */

const SHIFTED_LOGIC: [string, number, number, Text][] = [
  ['and', 0, 0, T('按位与：Rd = Rn & (移位后的 Rm)', 'Bitwise AND: Rd = Rn & shifted Rm')],
  ['bic', 0, 1, T('位清除：Rd = Rn & ~(移位后的 Rm)', 'Bit clear: Rd = Rn & ~shifted Rm')],
  ['orr', 1, 0, T('按位或：Rd = Rn | (移位后的 Rm)', 'Bitwise OR: Rd = Rn | shifted Rm')],
  ['orn', 1, 1, T('或非：Rd = Rn | ~(移位后的 Rm)', 'Bitwise OR NOT: Rd = Rn | ~shifted Rm')],
  ['eor', 2, 0, T('按位异或：Rd = Rn ^ (移位后的 Rm)', 'Bitwise exclusive OR: Rd = Rn ^ shifted Rm')],
  ['eon', 2, 1, T('异或非：Rd = Rn ^ ~(移位后的 Rm)', 'Bitwise exclusive OR NOT: Rd = Rn ^ ~shifted Rm')],
  ['ands', 3, 0, T('按位与并设置标志 N、Z', 'Bitwise AND, setting N and Z')],
  ['bics', 3, 1, T('位清除并设置标志 N、Z', 'Bit clear, setting N and Z')],
]

const SHIFTED_ARITH: [string, number, number, Text][] = [
  ['add', 0, 0, T('加：Rd = Rn + (移位后的 Rm)', 'Add: Rd = Rn + shifted Rm')],
  ['adds', 0, 1, T('加并设置标志 NZCV', 'Add and set the NZCV flags')],
  ['sub', 1, 0, T('减：Rd = Rn − (移位后的 Rm)', 'Subtract: Rd = Rn − shifted Rm')],
  ['subs', 1, 1, T('减并设置标志 NZCV', 'Subtract and set the NZCV flags')],
]

function arith(c: Cpu, f: Fields, sub: number, setFlags: number, b: bigint, spForm: boolean) {
  const sf = f.sf!
  const a = spForm ? c.rsp(sf, f.Rn!) : c.r(sf, f.Rn!)
  const r = sub ? subWithBorrow(sf, a, b, 1) : addWithCarry(sf, a, b, 0)
  if (setFlags) {
    c.setR(sf, f.Rd!, r)
    c.setFlags(nzcvOut)
  } else if (spForm) c.setRsp(sf, f.Rd!, r)
  else c.setR(sf, f.Rd!, r)
}

/* ------------------------------------------------------------------ 3-source */

const mul3 = (m: string, op31: string, o0: number, sf: string, syntax: string, desc: Text, op: (c: Cpu, f: Fields) => bigint, setWidth: number | null): InstrSpec => ({
  id: m,
  mnemonic: m,
  group: 'arith',
  // SMULH and UMULH ignore Ra (it should be 31; LLVM decodes any value).
  bits: `${sf} 00 11011 ${op31} Rm:5 ${o0} Ra:5 Rn:5 Rd:5`,
  syntax,
  encode: m.endsWith('mulh') ? (f) => void (f.Ra ??= 31) : undefined,
  desc,
  exec: (c, f) => {
    const sfw = setWidth ?? f.sf!
    c.setR(sfw, f.Rd!, op(c, f) & maskOf(sfw))
  },
})

const sx32 = (v: bigint) => BigInt.asIntN(32, v)

export const INSTRS: InstrSpec[] = [
  twoSource('udiv', 2, 'arith', T('无符号除法：Rd = Rn ÷ Rm（向零取整；除以 0 得 0）', 'Unsigned divide: Rd = Rn ÷ Rm (rounds toward zero; dividing by 0 gives 0)'), (_sf, a, b) => (b === 0n ? 0n : a / b)),
  twoSource('sdiv', 3, 'arith', T('有符号除法：Rd = Rn ÷ Rm（向零取整；除以 0 得 0）', 'Signed divide: Rd = Rn ÷ Rm (rounds toward zero; dividing by 0 gives 0)'), (sf, a, b) => {
    const y = signed(sf, b)
    return y === 0n ? 0n : BigInt.asUintN(64, signed(sf, a) / y)
  }),
  twoSource('lslv', 8, 'bits', T('按寄存器左移：Rd = Rn << (Rm 除以位宽的余数)', 'Shift left by a register: Rd = Rn << (Rm mod width)'), (sf, a, b) => shiftValue(sf, a, 0, Number(b % BigInt(bitsOf(sf))))),
  twoSource('lsrv', 9, 'bits', T('按寄存器逻辑右移', 'Logical shift right by a register'), (sf, a, b) => shiftValue(sf, a, 1, Number(b % BigInt(bitsOf(sf))))),
  twoSource('asrv', 10, 'bits', T('按寄存器算术右移', 'Arithmetic shift right by a register'), (sf, a, b) => shiftValue(sf, a, 2, Number(b % BigInt(bitsOf(sf))))),
  twoSource('rorv', 11, 'bits', T('按寄存器循环右移', 'Rotate right by a register'), (sf, a, b) => shiftValue(sf, a, 3, Number(b % BigInt(bitsOf(sf))))),
  {
    id: 'pacga',
    mnemonic: 'pacga',
    group: 'system',
    feature: 'pauth',
    bits: '1 0 0 11010110 Rm:5 001100 Rn:5 Rd:5',
    syntax: '<Xd>, <Xn>, <Xm|SP>',
    desc: T('计算通用认证码，放在 Xd 的高 32 位（密钥未开启：结果是 0）', 'Compute a generic authentication code into the top 32 bits of Xd (keys disabled: 0)'),
    exec: (c, f) => c.setX(f.Rd!, 0n),
  },
  twoSource('smax', 24, 'arith', T('有符号最大值', 'Signed maximum'), (sf, a, b) => minmax(sf, a, b, true, true), 'cssc'),
  twoSource('umax', 25, 'arith', T('无符号最大值', 'Unsigned maximum'), (sf, a, b) => minmax(sf, a, b, false, true), 'cssc'),
  twoSource('smin', 26, 'arith', T('有符号最小值', 'Signed minimum'), (sf, a, b) => minmax(sf, a, b, true, false), 'cssc'),
  twoSource('umin', 27, 'arith', T('无符号最小值', 'Unsigned minimum'), (sf, a, b) => minmax(sf, a, b, false, false), 'cssc'),
  crc('crc32b', 16, 0, 0, false),
  crc('crc32h', 17, 1, 0, false),
  crc('crc32w', 18, 2, 0, false),
  crc('crc32x', 19, 3, 1, false),
  crc('crc32cb', 20, 0, 0, true),
  crc('crc32ch', 21, 1, 0, true),
  crc('crc32cw', 22, 2, 0, true),
  crc('crc32cx', 23, 3, 1, true),
  oneSource('rbit', 0, T('位反转：第 0 位和最高位交换，依此类推', 'Reverse the bit order'), (sf, v) => reverseBits(v, bitsOf(sf))),
  oneSource('rev16', 1, T('每个 16 位里交换两个字节', 'Reverse the bytes in each 16-bit halfword'), (sf, v) => reverseBytes(v, bitsOf(sf), 16)),
  oneSource('rev', 2, T('反转字节序（大小端转换）', 'Reverse the byte order (endianness swap)'), (_sf, v) => reverseBytes(v, 32, 32), { sf: 0, syntax: '<Wd>, <Wn>' }),
  oneSource('rev32', 2, T('每个 32 位里反转字节序', 'Reverse the bytes in each 32-bit word'), (_sf, v) => reverseBytes(v, 64, 32), { sf: 1, syntax: '<Xd>, <Xn>' }),
  oneSource('rev', 3, T('反转字节序（大小端转换）', 'Reverse the byte order (endianness swap)'), (_sf, v) => reverseBytes(v, 64, 64), { sf: 1, syntax: '<Xd>, <Xn>' }),
  oneSource('clz', 4, T('前导 0 的个数', 'Count leading zero bits'), (sf, v) => BigInt(countLeadingZeros(v, bitsOf(sf)))),
  oneSource('cls', 5, T('前导符号位的个数（不算最高位本身）', 'Count leading sign bits (not counting the top bit)'), cls),
  oneSource('ctz', 6, T('末尾 0 的个数', 'Count trailing zero bits'), (sf, v) => BigInt(countTrailingZeros(v, bitsOf(sf))), { feature: 'cssc' }),
  oneSource('cnt', 7, T('值为 1 的位数', 'Count the bits set to 1'), (_sf, v) => BigInt(popcount(v)), { feature: 'cssc' }),
  oneSource('abs', 8, T('绝对值', 'Absolute value'), (sf, v) => BigInt.asUintN(64, signed(sf, v) < 0n ? -signed(sf, v) : signed(sf, v)), { feature: 'cssc', group: 'arith' }),
  pauth('pacia', 0, false, T('用 A 密钥给指令指针签名，Xn 是修饰值（密钥未开启：不变）', 'Sign an instruction pointer with key A and modifier Xn (keys disabled: unchanged)')),
  pauth('pacib', 1, false, T('用 B 密钥给指令指针签名（密钥未开启：不变）', 'Sign an instruction pointer with key B (keys disabled: unchanged)')),
  pauth('pacda', 2, false, T('用 A 密钥给数据指针签名（密钥未开启：不变）', 'Sign a data pointer with key A (keys disabled: unchanged)')),
  pauth('pacdb', 3, false, T('用 B 密钥给数据指针签名（密钥未开启：不变）', 'Sign a data pointer with key B (keys disabled: unchanged)')),
  pauth('autia', 4, false, T('用 A 密钥认证指令指针（密钥未开启：总是成功）', 'Authenticate an instruction pointer with key A (keys disabled: always succeeds)')),
  pauth('autib', 5, false, T('用 B 密钥认证指令指针（密钥未开启：总是成功）', 'Authenticate an instruction pointer with key B (keys disabled: always succeeds)')),
  pauth('autda', 6, false, T('用 A 密钥认证数据指针（密钥未开启：总是成功）', 'Authenticate a data pointer with key A (keys disabled: always succeeds)')),
  pauth('autdb', 7, false, T('用 B 密钥认证数据指针（密钥未开启：总是成功）', 'Authenticate a data pointer with key B (keys disabled: always succeeds)')),
  pauth('paciza', 8, true, T('用 A 密钥、修饰值 0 给指令指针签名（密钥未开启：不变）', 'Sign an instruction pointer with key A and a zero modifier (keys disabled: unchanged)')),
  pauth('pacizb', 9, true, T('用 B 密钥、修饰值 0 给指令指针签名（密钥未开启：不变）', 'Sign an instruction pointer with key B and a zero modifier (keys disabled: unchanged)')),
  pauth('pacdza', 10, true, T('用 A 密钥、修饰值 0 给数据指针签名（密钥未开启：不变）', 'Sign a data pointer with key A and a zero modifier (keys disabled: unchanged)')),
  pauth('pacdzb', 11, true, T('用 B 密钥、修饰值 0 给数据指针签名（密钥未开启：不变）', 'Sign a data pointer with key B and a zero modifier (keys disabled: unchanged)')),
  pauth('autiza', 12, true, T('用 A 密钥、修饰值 0 认证指令指针（密钥未开启：总是成功）', 'Authenticate an instruction pointer with key A and a zero modifier (keys disabled: always succeeds)')),
  pauth('autizb', 13, true, T('用 B 密钥、修饰值 0 认证指令指针（密钥未开启：总是成功）', 'Authenticate an instruction pointer with key B and a zero modifier (keys disabled: always succeeds)')),
  pauth('autdza', 14, true, T('用 A 密钥、修饰值 0 认证数据指针（密钥未开启：总是成功）', 'Authenticate a data pointer with key A and a zero modifier (keys disabled: always succeeds)')),
  pauth('autdzb', 15, true, T('用 B 密钥、修饰值 0 认证数据指针（密钥未开启：总是成功）', 'Authenticate a data pointer with key B and a zero modifier (keys disabled: always succeeds)')),
  {
    id: 'xpaci',
    mnemonic: 'xpaci',
    group: 'system',
    feature: 'pauth',
    bits: '1 1 0 11010110 00001 010000 11111 Rd:5',
    syntax: '<Xd>',
    desc: T('去掉指令指针里的认证码', 'Strip the authentication code from an instruction pointer'),
    exec: (c, f) => c.setX(f.Rd!, stripPac(c.x(f.Rd!), false)),
  },
  {
    id: 'xpacd',
    mnemonic: 'xpacd',
    group: 'system',
    feature: 'pauth',
    bits: '1 1 0 11010110 00001 010001 11111 Rd:5',
    syntax: '<Xd>',
    desc: T('去掉数据指针里的认证码', 'Strip the authentication code from a data pointer'),
    exec: (c, f) => c.setX(f.Rd!, stripPac(c.x(f.Rd!), true)),
  },
  ...SHIFTED_LOGIC.map(
    ([m, opc, N, desc]): InstrSpec => ({
      id: `${m}-reg`,
      mnemonic: m,
      group: 'logic',
      bits: `sf ${bin(opc, 2)} 01010 shift:2 ${N} Rm:5 imm6:6 Rn:5 Rd:5`,
      syntax: '<Rd>, <Rn>, <Rm>{, <shiftr> #<u:imm6>}',
      valid: (f) => f.sf === 1 || f.imm6! < 32,
      desc,
      exec: (c, f) => {
        const sf = f.sf!
        const a = c.r(sf, f.Rn!)
        let b = shiftValue(sf, c.r(sf, f.Rm!), f.shift!, f.imm6!)
        if (N) b ^= maskOf(sf)
        const r = opc === 1 ? a | b : opc === 2 ? a ^ b : a & b
        c.setR(sf, f.Rd!, r)
        if (opc === 3) c.setFlags(logicFlags(sf, r))
      },
    }),
  ),
  ...SHIFTED_ARITH.map(
    ([m, op, S, desc]): InstrSpec => ({
      id: `${m}-reg`,
      mnemonic: m,
      group: 'arith',
      bits: `sf ${op} ${S} 01011 shift:2 0 Rm:5 imm6:6 Rn:5 Rd:5`,
      syntax: '<Rd>, <Rn>, <Rm>{, <shift> #<u:imm6>}',
      valid: (f) => f.shift !== 3 && (f.sf === 1 || f.imm6! < 32),
      desc,
      exec: (c, f) => arith(c, f, op, S, shiftValue(f.sf!, c.r(f.sf!, f.Rm!), f.shift!, f.imm6!), false),
    }),
  ),
  ...SHIFTED_ARITH.map(
    ([m, op, S, desc]): InstrSpec => ({
      id: `${m}-ext`,
      mnemonic: m,
      group: 'arith',
      bits: `sf ${op} ${S} 01011 00 1 Rm:5 option:3 imm3:3 Rn:5 Rd:5`,
      syntax: S ? '<Rd>, <Rn|SP>, <ext:n>' : '<Rd|SP>, <Rn|SP>, <ext:dn>',
      valid: (f) => f.imm3! <= 4,
      desc: T(`${desc.zh}（Rm 先按 uxtb/sxtw 等扩展，再左移 0–4 位）`, `${desc.en} (Rm extended by uxtb, sxtw, … and shifted left 0–4)`),
      exec: (c, f) => arith(c, f, op, S, extendValue(f.sf!, c.x(f.Rm!), f.option!, f.imm3!), true),
    }),
  ),
  ...(
    [
      ['adc', 0, 0, T('带进位加：Rd = Rn + Rm + C', 'Add with carry: Rd = Rn + Rm + C')],
      ['adcs', 0, 1, T('带进位加并设置标志', 'Add with carry, setting the flags')],
      ['sbc', 1, 0, T('带借位减：Rd = Rn − Rm − (1 − C)', 'Subtract with carry: Rd = Rn − Rm − (1 − C)')],
      ['sbcs', 1, 1, T('带借位减并设置标志', 'Subtract with carry, setting the flags')],
    ] as const
  ).map(
    ([m, op, S, desc]): InstrSpec => ({
      id: m,
      mnemonic: m,
      group: 'arith',
      bits: `sf ${op} ${S} 11010000 Rm:5 000000 Rn:5 Rd:5`,
      syntax: '<Rd>, <Rn>, <Rm>',
      desc,
      exec: (c, f) => {
        const sf = f.sf!
        const carry = (c.flags() >> 1) & 1
        const r = op ? subWithBorrow(sf, c.r(sf, f.Rn!), c.r(sf, f.Rm!), carry) : addWithCarry(sf, c.r(sf, f.Rn!), c.r(sf, f.Rm!), carry)
        c.setR(sf, f.Rd!, r)
        if (S) c.setFlags(nzcvOut)
      },
    }),
  ),
  {
    id: 'rmif',
    mnemonic: 'rmif',
    group: 'cond',
    feature: 'flagm',
    bits: '1 0 1 11010000 imm6:6 00001 Rn:5 0 mask:4',
    syntax: '<Xn>, #<u:imm6>, #<u:mask>',
    desc: T('把 Xn 循环右移 imm6 位，再把低 4 位按 mask 选择性地放进 N Z C V', 'Rotate Xn right by imm6 and move its low 4 bits into the N Z C V flags chosen by mask'),
    exec: (c, f) => {
      const tmp = Number(rotateRight(c.x(f.Rn!), f.imm6!, 64) & 0xfn)
      c.setFlags((c.flags() & ~f.mask!) | (tmp & f.mask!))
    },
  },
  ...([8, 16] as const).map(
    (size, sz): InstrSpec => ({
      id: `setf${size}`,
      mnemonic: `setf${size}`,
      group: 'cond',
      feature: 'flagm',
      bits: `0 0 1 11010000 000000 ${sz} 0010 Rn:5 0 1101`,
      syntax: '<Wn>',
      desc: T(`按 Wn 的低 ${size} 位当作有符号数设置 N、Z、V（C 不变）`, `Set N, Z and V from the low ${size} bits of Wn as a signed value (C unchanged)`),
      exec: (c, f) => {
        const v = c.r(0, f.Rn!)
        const top = Number((v >> BigInt(size - 1)) & 1n)
        const n = top
        const z = (v & ((1n << BigInt(size)) - 1n)) === 0n ? 1 : 0
        const ov = Number((v >> BigInt(size)) & 1n) ^ top
        c.setFlags((n << 3) | (z << 2) | (c.flags() & 2) | ov)
      },
    }),
  ),
  ...(['ccmn', 'ccmp'] as const).flatMap((m, op): InstrSpec[] => [
    {
      id: `${m}-reg`,
      mnemonic: m,
      group: 'cond',
      bits: `sf ${op} 1 11010010 Rm:5 cond:4 0 0 Rn:5 0 nzcv:4`,
      syntax: '<Rn>, <Rm>, #<u:nzcv>, <cond>',
      desc: op ? T('条件比较：条件成立时比较 Rn 和 Rm，否则把标志设成 nzcv', 'Conditional compare: if the condition holds compare Rn with Rm, else set the flags to nzcv') : T('条件比较（相加）：条件成立时按 Rn + Rm 设置标志，否则设成 nzcv', 'Conditional compare negative: if the condition holds set the flags from Rn + Rm, else to nzcv'),
      exec: (c, f) => ccmp(c, f, op, c.r(f.sf!, f.Rm!)),
    },
    {
      id: `${m}-imm`,
      mnemonic: m,
      group: 'cond',
      bits: `sf ${op} 1 11010010 imm5:5 cond:4 1 0 Rn:5 0 nzcv:4`,
      syntax: '<Rn>, #<u:imm5>, #<u:nzcv>, <cond>',
      desc: op ? T('条件比较：条件成立时比较 Rn 和立即数（0–31），否则把标志设成 nzcv', 'Conditional compare: if the condition holds compare Rn with an immediate (0–31), else set the flags to nzcv') : T('条件比较（相加）立即数', 'Conditional compare negative with an immediate'),
      exec: (c, f) => ccmp(c, f, op, BigInt(f.imm5!)),
    },
  ]),
  ...(
    [
      ['csel', 0, 0, T('条件选择：条件成立取 Rn，否则取 Rm', 'Conditional select: Rn if the condition holds, else Rm')],
      ['csinc', 0, 1, T('条件选择加一：条件成立取 Rn，否则取 Rm + 1', 'Conditional select increment: Rn if the condition holds, else Rm + 1')],
      ['csinv', 1, 0, T('条件选择取反：条件成立取 Rn，否则取 ~Rm', 'Conditional select invert: Rn if the condition holds, else ~Rm')],
      ['csneg', 1, 1, T('条件选择取负：条件成立取 Rn，否则取 −Rm', 'Conditional select negate: Rn if the condition holds, else −Rm')],
    ] as const
  ).map(
    ([m, op, o2, desc]): InstrSpec => ({
      id: m,
      mnemonic: m,
      group: 'cond',
      bits: `sf ${op} 0 11010100 Rm:5 cond:4 0 ${o2} Rn:5 Rd:5`,
      syntax: '<Rd>, <Rn>, <Rm>, <cond>',
      desc,
      exec: (c, f) => {
        const sf = f.sf!
        if (c.cond(f.cond!)) c.setR(sf, f.Rd!, c.r(sf, f.Rn!))
        else {
          let v = c.r(sf, f.Rm!)
          if (op) v = ~v & maskOf(sf)
          if (o2) v = (v + 1n) & maskOf(sf)
          c.setR(sf, f.Rd!, v)
        }
      },
    }),
  ),
  mul3('madd', '000', 0, 'sf', '<Rd>, <Rn>, <Rm>, <Ra>', T('乘加：Rd = Ra + Rn × Rm', 'Multiply-add: Rd = Ra + Rn × Rm'), (c, f) => c.r(f.sf!, f.Ra!) + c.r(f.sf!, f.Rn!) * c.r(f.sf!, f.Rm!), null),
  mul3('msub', '000', 1, 'sf', '<Rd>, <Rn>, <Rm>, <Ra>', T('乘减：Rd = Ra − Rn × Rm', 'Multiply-subtract: Rd = Ra − Rn × Rm'), (c, f) => c.r(f.sf!, f.Ra!) - c.r(f.sf!, f.Rn!) * c.r(f.sf!, f.Rm!), null),
  mul3('smaddl', '001', 0, '1', '<Xd>, <Wn>, <Wm>, <Xa>', T('有符号长乘加：Xd = Xa + Wn × Wm（32 位相乘得 64 位）', 'Signed multiply-add long: Xd = Xa + Wn × Wm (32 × 32 → 64 bits)'), (c, f) => c.x(f.Ra!) + sx32(c.r(0, f.Rn!)) * sx32(c.r(0, f.Rm!)), 1),
  mul3('smsubl', '001', 1, '1', '<Xd>, <Wn>, <Wm>, <Xa>', T('有符号长乘减：Xd = Xa − Wn × Wm', 'Signed multiply-subtract long: Xd = Xa − Wn × Wm'), (c, f) => c.x(f.Ra!) - sx32(c.r(0, f.Rn!)) * sx32(c.r(0, f.Rm!)), 1),
  mul3('smulh', '010', 0, '1', '<Xd>, <Xn>, <Xm>', T('有符号乘法的高 64 位：Xd = (Xn × Xm) >> 64', 'Signed multiply high: Xd = (Xn × Xm) >> 64'), (c, f) => BigInt.asUintN(64, (signed(1, c.x(f.Rn!)) * signed(1, c.x(f.Rm!))) >> 64n), 1),
  mul3('umaddl', '101', 0, '1', '<Xd>, <Wn>, <Wm>, <Xa>', T('无符号长乘加：Xd = Xa + Wn × Wm', 'Unsigned multiply-add long: Xd = Xa + Wn × Wm'), (c, f) => c.x(f.Ra!) + c.r(0, f.Rn!) * c.r(0, f.Rm!), 1),
  mul3('umsubl', '101', 1, '1', '<Xd>, <Wn>, <Wm>, <Xa>', T('无符号长乘减：Xd = Xa − Wn × Wm', 'Unsigned multiply-subtract long: Xd = Xa − Wn × Wm'), (c, f) => c.x(f.Ra!) - c.r(0, f.Rn!) * c.r(0, f.Rm!), 1),
  mul3('umulh', '110', 0, '1', '<Xd>, <Xn>, <Xm>', T('无符号乘法的高 64 位：Xd = (Xn × Xm) >> 64', 'Unsigned multiply high: Xd = (Xn × Xm) >> 64'), (c, f) => (c.x(f.Rn!) * c.x(f.Rm!)) >> 64n, 1),
]

function ccmp(c: Cpu, f: Fields, op: number, b: bigint) {
  const sf = f.sf!
  if (c.cond(f.cond!)) {
    const a = c.r(sf, f.Rn!)
    if (op) subWithBorrow(sf, a, b, 1)
    else addWithCarry(sf, a, b, 0)
    c.setFlags(nzcvOut)
  } else c.setFlags(f.nzcv!)
}

/* ------------------------------------------------------------------ aliases */

/** CINC and friends take the condition the other way round: the alias's cc is the instruction's inverted cond. */
const invCond = { encode: (f: Fields) => void (f.cond = f.cc! ^ 1), decode: (f: Fields) => void (f.cc = f.cond! ^ 1) }
const notAlNv = (f: Fields) => f.cond! < 14

export const ALIASES: AliasSpec[] = [
  ...(['lsl', 'lsr', 'asr', 'ror'] as const).map((m): AliasSpec => ({ id: `${m}-reg`, of: `${m}v`, mnemonic: m, syntax: '<Rd>, <Rn>, <Rm>' })),
  {
    id: 'mov-reg',
    of: 'orr-reg',
    mnemonic: 'mov',
    syntax: '<Rd>, <Rm>',
    fixed: { Rn: 31, shift: 0, imm6: 0 },
    desc: T('寄存器之间传送：Rd = Rm', 'Move between registers: Rd = Rm'),
  },
  { id: 'mvn', of: 'orn-reg', mnemonic: 'mvn', syntax: '<Rd>, <Rm>{, <shiftr> #<u:imm6>}', fixed: { Rn: 31 }, desc: T('按位取反：Rd = ~Rm', 'Bitwise NOT: Rd = ~Rm') },
  { id: 'tst-reg', of: 'ands-reg', mnemonic: 'tst', syntax: '<Rn>, <Rm>{, <shiftr> #<u:imm6>}', fixed: { Rd: 31 }, desc: T('测试位：按位与后只设置标志', 'Test bits: AND and set the flags only') },
  { id: 'cmn-reg', of: 'adds-reg', mnemonic: 'cmn', syntax: '<Rn>, <Rm>{, <shift> #<u:imm6>}', fixed: { Rd: 31 }, desc: T('比较（相加），只设置标志', 'Compare negative (adds), flags only') },
  { id: 'cmp-reg', of: 'subs-reg', mnemonic: 'cmp', syntax: '<Rn>, <Rm>{, <shift> #<u:imm6>}', fixed: { Rd: 31 }, desc: T('比较（相减），只设置标志', 'Compare (subs), flags only') },
  { id: 'neg', of: 'sub-reg', mnemonic: 'neg', syntax: '<Rd>, <Rm>{, <shift> #<u:imm6>}', fixed: { Rn: 31 }, desc: T('取负：Rd = −Rm', 'Negate: Rd = −Rm') },
  { id: 'negs', of: 'subs-reg', mnemonic: 'negs', syntax: '<Rd>, <Rm>{, <shift> #<u:imm6>}', fixed: { Rn: 31 }, desc: T('取负并设置标志', 'Negate, setting the flags') },
  { id: 'cmn-ext', of: 'adds-ext', mnemonic: 'cmn', syntax: '<Rn|SP>, <ext:n>', fixed: { Rd: 31 }, desc: T('比较（相加），Rm 先扩展', 'Compare negative with an extended register') },
  { id: 'cmp-ext', of: 'subs-ext', mnemonic: 'cmp', syntax: '<Rn|SP>, <ext:n>', fixed: { Rd: 31 }, desc: T('比较（相减），Rm 先扩展', 'Compare with an extended register') },
  { id: 'ngc', of: 'sbc', mnemonic: 'ngc', syntax: '<Rd>, <Rm>', fixed: { Rn: 31 }, desc: T('带借位取负：Rd = −Rm − (1 − C)', 'Negate with carry: Rd = −Rm − (1 − C)') },
  { id: 'ngcs', of: 'sbcs', mnemonic: 'ngcs', syntax: '<Rd>, <Rm>', fixed: { Rn: 31 }, desc: T('带借位取负并设置标志', 'Negate with carry, setting the flags') },
  {
    id: 'cset',
    of: 'csinc',
    mnemonic: 'cset',
    syntax: '<Rd>, <cond:cc!>',
    fixed: { Rn: 31, Rm: 31 },
    prefer: notAlNv,
    ...invCond,
    desc: T('条件成立时 Rd = 1，否则 Rd = 0', 'Rd = 1 if the condition holds, else 0'),
  },
  {
    id: 'cinc',
    of: 'csinc',
    mnemonic: 'cinc',
    syntax: '<Rd>, <Rn>, <cond:cc!>',
    prefer: (f) => f.Rn === f.Rm && f.Rn !== 31 && notAlNv(f),
    encode: (f) => {
      f.Rm = f.Rn!
      f.cond = f.cc! ^ 1
    },
    decode: invCond.decode,
    desc: T('条件成立时 Rd = Rn + 1，否则 Rd = Rn', 'Rd = Rn + 1 if the condition holds, else Rn'),
  },
  {
    id: 'csetm',
    of: 'csinv',
    mnemonic: 'csetm',
    syntax: '<Rd>, <cond:cc!>',
    fixed: { Rn: 31, Rm: 31 },
    prefer: notAlNv,
    ...invCond,
    desc: T('条件成立时 Rd 全为 1（−1），否则 0', 'Rd = all ones (−1) if the condition holds, else 0'),
  },
  {
    id: 'cinv',
    of: 'csinv',
    mnemonic: 'cinv',
    syntax: '<Rd>, <Rn>, <cond:cc!>',
    prefer: (f) => f.Rn === f.Rm && f.Rn !== 31 && notAlNv(f),
    encode: (f) => {
      f.Rm = f.Rn!
      f.cond = f.cc! ^ 1
    },
    decode: invCond.decode,
    desc: T('条件成立时 Rd = ~Rn，否则 Rd = Rn', 'Rd = ~Rn if the condition holds, else Rn'),
  },
  {
    id: 'cneg',
    of: 'csneg',
    mnemonic: 'cneg',
    syntax: '<Rd>, <Rn>, <cond:cc!>',
    prefer: (f) => f.Rn === f.Rm && notAlNv(f),
    encode: (f) => {
      f.Rm = f.Rn!
      f.cond = f.cc! ^ 1
    },
    decode: invCond.decode,
    desc: T('条件成立时 Rd = −Rn，否则 Rd = Rn', 'Rd = −Rn if the condition holds, else Rn'),
  },
  { id: 'mul', of: 'madd', mnemonic: 'mul', syntax: '<Rd>, <Rn>, <Rm>', fixed: { Ra: 31 }, desc: T('乘法：Rd = Rn × Rm（取低位）', 'Multiply: Rd = Rn × Rm (low bits)') },
  { id: 'mneg', of: 'msub', mnemonic: 'mneg', syntax: '<Rd>, <Rn>, <Rm>', fixed: { Ra: 31 }, desc: T('乘后取负：Rd = −(Rn × Rm)', 'Multiply-negate: Rd = −(Rn × Rm)') },
  { id: 'smull', of: 'smaddl', mnemonic: 'smull', syntax: '<Xd>, <Wn>, <Wm>', fixed: { Ra: 31 }, desc: T('有符号长乘：Xd = Wn × Wm（32 × 32 → 64 位）', 'Signed multiply long: Xd = Wn × Wm (32 × 32 → 64 bits)') },
  { id: 'smnegl', of: 'smsubl', mnemonic: 'smnegl', syntax: '<Xd>, <Wn>, <Wm>', fixed: { Ra: 31 }, desc: T('有符号长乘后取负', 'Signed multiply-negate long') },
  { id: 'umull', of: 'umaddl', mnemonic: 'umull', syntax: '<Xd>, <Wn>, <Wm>', fixed: { Ra: 31 }, desc: T('无符号长乘：Xd = Wn × Wm（32 × 32 → 64 位）', 'Unsigned multiply long: Xd = Wn × Wm (32 × 32 → 64 bits)') },
  { id: 'umnegl', of: 'umsubl', mnemonic: 'umnegl', syntax: '<Xd>, <Wn>, <Wm>', fixed: { Ra: 31 }, desc: T('无符号长乘后取负', 'Unsigned multiply-negate long') },
  { id: 'rev64', of: 'rev-x', mnemonic: 'rev64', syntax: '<Xd>, <Xn>', prefer: false },
]
