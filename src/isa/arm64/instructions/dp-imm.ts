/**
 * Data processing with an immediate: ADR/ADRP, ADD/SUB, logical immediates, MOVZ/MOVN/MOVK, the bitfield
 * moves (SBFM, BFM, UBFM) with their many aliases, EXTR, and the CSSC minimum/maximum.
 */
import { L, T } from '../../../core/i18n'
import { decodeBitmask } from '../encoding/bitmask'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Fields } from './types'
import { addWithCarry, bitsOf, decodeBitMasks, logicFlags, maskOf, rotateRight, sext, signed } from './util'

const adrOffset = (f: Fields) => BigInt(sext((f.immhi! << 2) | f.immlo!, 21))

const arithImm = (f: Fields) => BigInt(f.imm12!) << (f.sh ? 12n : 0n)

const logicImm = (f: Fields) => decodeBitmask(f.N!, f.immr!, f.imms!, f.sf ? 64 : 32)!

export const INSTRS: InstrSpec[] = [
  {
    id: 'adr',
    mnemonic: 'adr',
    group: 'move',
    bits: '0 immlo:2 10000 immhi:19 Rd:5',
    syntax: '<Xd>, <adr>',
    desc: T('取标签地址：Xd = PC + 偏移（±1 MB 以内）', 'Address of a label: Xd = PC + offset (within ±1 MB)'),
    exec: (c, f) => c.setX(f.Rd!, BigInt.asUintN(64, c.pcVa + adrOffset(f))),
  },
  {
    id: 'adrp',
    mnemonic: 'adrp',
    group: 'move',
    bits: '1 immlo:2 10000 immhi:19 Rd:5',
    syntax: '<Xd>, <adrp>',
    desc: T('取标签所在 4 KB 页的地址：Xd = (PC 的页) + 偏移 × 4096；再用 :lo12: 补上页内偏移', 'Address of the 4 KB page of a label: Xd = page of PC + offset × 4096; add :lo12: for the rest'),
    exec: (c, f) => c.setX(f.Rd!, BigInt.asUintN(64, (c.pcVa & ~0xfffn) + (adrOffset(f) << 12n))),
  },
  {
    id: 'add-imm',
    mnemonic: 'add',
    group: 'arith',
    bits: 'sf 0 0 100010 sh imm12:12 Rn:5 Rd:5',
    syntax: '<Rd|SP>, <Rn|SP>, #<aimm>{, lsl #<sh12>}',
    desc: T('加立即数：Rd = Rn + imm（imm 是 0–4095，可再左移 12 位）', 'Add immediate: Rd = Rn + imm (imm is 0–4095, optionally shifted left by 12)'),
    exec: (c, f) => c.setRsp(f.sf!, f.Rd!, addWithCarry(f.sf!, c.rsp(f.sf!, f.Rn!), arithImm(f), 0)[0]),
  },
  {
    id: 'adds-imm',
    mnemonic: 'adds',
    group: 'arith',
    bits: 'sf 0 1 100010 sh imm12:12 Rn:5 Rd:5',
    syntax: '<Rd>, <Rn|SP>, #<aimm>{, lsl #<sh12>}',
    desc: T('加立即数并设置标志 NZCV', 'Add immediate and set the NZCV flags'),
    exec: (c, f) => {
      const [r, nzcv] = addWithCarry(f.sf!, c.rsp(f.sf!, f.Rn!), arithImm(f), 0)
      c.setR(f.sf!, f.Rd!, r)
      c.setFlags(nzcv)
    },
  },
  {
    id: 'sub-imm',
    mnemonic: 'sub',
    group: 'arith',
    bits: 'sf 1 0 100010 sh imm12:12 Rn:5 Rd:5',
    syntax: '<Rd|SP>, <Rn|SP>, #<aimm>{, lsl #<sh12>}',
    desc: T('减立即数：Rd = Rn − imm', 'Subtract immediate: Rd = Rn − imm'),
    exec: (c, f) => c.setRsp(f.sf!, f.Rd!, addWithCarry(f.sf!, c.rsp(f.sf!, f.Rn!), ~arithImm(f) & maskOf(f.sf!), 1)[0]),
  },
  {
    id: 'subs-imm',
    mnemonic: 'subs',
    group: 'arith',
    bits: 'sf 1 1 100010 sh imm12:12 Rn:5 Rd:5',
    syntax: '<Rd>, <Rn|SP>, #<aimm>{, lsl #<sh12>}',
    desc: T('减立即数并设置标志 NZCV', 'Subtract immediate and set the NZCV flags'),
    exec: (c, f) => {
      const [r, nzcv] = addWithCarry(f.sf!, c.rsp(f.sf!, f.Rn!), ~arithImm(f) & maskOf(f.sf!), 1)
      c.setR(f.sf!, f.Rd!, r)
      c.setFlags(nzcv)
    },
  },
  ...(
    [
      ['smax', 0, true, T('有符号最大值：Rd = max(Rn, imm)', 'Signed maximum: Rd = max(Rn, imm)')],
      ['umax', 1, false, T('无符号最大值：Rd = max(Rn, imm)', 'Unsigned maximum: Rd = max(Rn, imm)')],
      ['smin', 2, true, T('有符号最小值：Rd = min(Rn, imm)', 'Signed minimum: Rd = min(Rn, imm)')],
      ['umin', 3, false, T('无符号最小值：Rd = min(Rn, imm)', 'Unsigned minimum: Rd = min(Rn, imm)')],
    ] as const
  ).map(
    ([m, opc, isSigned, desc]): InstrSpec => ({
      id: `${m}-imm`,
      mnemonic: m,
      group: 'arith',
      feature: 'cssc',
      bits: `sf 0 0 100011 1 00${opc.toString(2).padStart(2, '0')} imm8:8 Rn:5 Rd:5`,
      syntax: `<Rd>, <Rn>, #<${isSigned ? 's' : 'u'}:imm8>`,
      desc,
      exec: (c, f) => {
        const a = c.r(f.sf!, f.Rn!)
        const x = isSigned ? signed(f.sf!, a) : a
        const b = isSigned ? BigInt(sext(f.imm8!, 8)) : BigInt(f.imm8!)
        const max = m.endsWith('max')
        const r = max ? (x > b ? x : b) : x < b ? x : b
        c.setR(f.sf!, f.Rd!, BigInt.asUintN(64, r))
      },
    }),
  ),
  ...(
    [
      ['and', 0, T('按位与立即数：Rd = Rn & imm', 'Bitwise AND immediate: Rd = Rn & imm')],
      ['orr', 1, T('按位或立即数：Rd = Rn | imm', 'Bitwise OR immediate: Rd = Rn | imm')],
      ['eor', 2, T('按位异或立即数：Rd = Rn ^ imm', 'Bitwise exclusive OR immediate: Rd = Rn ^ imm')],
      ['ands', 3, T('按位与立即数并设置标志 N、Z（C、V 清零）', 'Bitwise AND immediate, setting N and Z (C and V cleared)')],
    ] as const
  ).map(
    ([m, opc, desc]): InstrSpec => ({
      id: `${m}-imm`,
      mnemonic: m,
      group: 'logic',
      bits: `sf ${opc.toString(2).padStart(2, '0')} 100100 N immr:6 imms:6 Rn:5 Rd:5`,
      syntax: m === 'ands' ? '<Rd>, <Rn>, #<bimm>' : '<Rd|SP>, <Rn>, #<bimm>',
      valid: (f) => decodeBitmask(f.N!, f.immr!, f.imms!, f.sf ? 64 : 32) !== null,
      desc,
      exec: (c, f) => {
        const a = c.r(f.sf!, f.Rn!)
        const b = logicImm(f)
        const r = opc === 1 ? a | b : opc === 2 ? a ^ b : a & b
        if (opc === 3) {
          c.setR(f.sf!, f.Rd!, r)
          c.setFlags(logicFlags(f.sf!, r))
        } else c.setRsp(f.sf!, f.Rd!, r)
      },
    }),
  ),
  ...(
    [
      ['movn', 0, T('取反后传送：Rd = ~(imm16 << shift)', 'Move wide with NOT: Rd = ~(imm16 << shift)')],
      ['movz', 2, T('传送 16 位立即数，其余位清零：Rd = imm16 << shift', 'Move wide with zero: Rd = imm16 << shift')],
      ['movk', 3, T('只替换 16 位，其余位保持：Rd<shift+15:shift> = imm16', 'Move wide with keep: replace 16 bits, keep the rest')],
    ] as const
  ).map(
    ([m, opc, desc]): InstrSpec => ({
      id: m,
      mnemonic: m,
      group: 'move',
      bits: `sf ${opc.toString(2).padStart(2, '0')} 100101 hw:2 imm16:16 Rd:5`,
      syntax: '<Rd>, #<mov16>{, lsl #<hw>}',
      valid: (f) => f.sf === 1 || f.hw! < 2,
      desc,
      exec: (c, f) => {
        const pos = BigInt(16 * f.hw!)
        const v = BigInt(f.imm16!) << pos
        if (opc === 0) c.setR(f.sf!, f.Rd!, ~v & maskOf(f.sf!))
        else if (opc === 2) c.setR(f.sf!, f.Rd!, v)
        else c.setR(f.sf!, f.Rd!, (c.r(f.sf!, f.Rd!) & ~(0xffffn << pos)) | v)
      },
    }),
  ),
  ...(
    [
      ['sbfm', 0, T('有符号位段搬移（asr、sbfx、sbfiz、sxtb 等的底层指令）', 'Signed bitfield move (behind asr, sbfx, sbfiz, sxtb and more)')],
      ['bfm', 1, T('位段搬移，其余位保持（bfi、bfxil、bfc 的底层指令）', 'Bitfield move keeping the other bits (behind bfi, bfxil, bfc)')],
      ['ubfm', 2, T('无符号位段搬移（lsl、lsr、ubfx、ubfiz、uxtb 等的底层指令）', 'Unsigned bitfield move (behind lsl, lsr, ubfx, ubfiz, uxtb and more)')],
    ] as const
  ).map(
    ([m, opc, desc]): InstrSpec => ({
      id: m,
      mnemonic: m,
      group: 'bits',
      bits: `sf ${opc.toString(2).padStart(2, '0')} 100110 N immr:6 imms:6 Rn:5 Rd:5`,
      syntax: '<Rd>, <Rn>, #<u:immr>, #<u:imms>',
      valid: (f) => f.N === f.sf && (f.sf === 1 || (f.immr! < 32 && f.imms! < 32)),
      encode: (f) => void (f.N = f.sf!),
      desc,
      exec: (c, f) => {
        const bits = bitsOf(f.sf!)
        const [wmask, tmask] = decodeBitMasks(f.N!, f.imms!, f.immr!, false, bits)!
        const src = c.r(f.sf!, f.Rn!)
        const rot = rotateRight(src, f.immr!, bits)
        const m = maskOf(f.sf!)
        let r: bigint
        if (opc === 1) {
          const dst = c.r(f.sf!, f.Rd!)
          const bot = (dst & ~wmask & m) | (rot & wmask)
          r = (dst & ~tmask & m) | (bot & tmask)
        } else {
          const bot = rot & wmask
          if (opc === 2) r = bot & tmask
          else {
            const top = (src >> BigInt(f.imms!)) & 1n ? m : 0n
            r = (top & ~tmask & m) | (bot & tmask)
          }
        }
        c.setR(f.sf!, f.Rd!, r)
      },
    }),
  ),
  {
    id: 'extr',
    mnemonic: 'extr',
    group: 'bits',
    bits: 'sf 00 100111 N 0 Rm:5 imms:6 Rn:5 Rd:5',
    syntax: '<Rd>, <Rn>, <Rm>, #<u:imms>',
    valid: (f) => f.N === f.sf && (f.sf === 1 || f.imms! < 32),
    encode: (f) => void (f.N = f.sf!),
    desc: T('从 Rn:Rm 拼接的值中，从第 lsb 位起取出一个寄存器宽的位段', 'Extract a register-wide field starting at bit lsb from the pair Rn:Rm'),
    exec: (c, f) => {
      const bits = BigInt(bitsOf(f.sf!))
      const v = (c.r(f.sf!, f.Rn!) << bits) | c.r(f.sf!, f.Rm!)
      c.setR(f.sf!, f.Rd!, (v >> BigInt(f.imms!)) & maskOf(f.sf!))
    },
  },
]

/* ------------------------------------------------------------------ aliases */

const size = (f: Fields) => (f.sf ? 64 : 32)

/** Whether a value can be made by one MOVZ or MOVN of this width (then MOV shows that instead of ORR, as LLVM does). */
function movWideValue(v: bigint, sf: number): boolean {
  const m = sf ? 0xffffffffffffffffn : 0xffffffffn
  const one = (x: bigint) => {
    for (let s = 0n; s < (sf ? 64n : 32n); s += 16n) if ((x & ~(0xffffn << s) & m) === 0n) return true
    return false
  }
  return one(v & m) || one(~v & m)
}

/** Arm's BFXPreferred: whether a bitfield move is better shown as UBFX/SBFX. */
function bfxPreferred(f: Fields, uns: boolean): boolean {
  const imms = f.imms!
  const immr = f.immr!
  if (imms < immr) return false
  if (imms === (f.sf ? 63 : 31)) return false
  if (immr === 0) {
    if (f.sf === 0 && (imms === 7 || imms === 15)) return false
    if (f.sf === 1 && !uns && (imms === 7 || imms === 15 || imms === 31)) return false
  }
  return true
}

/** lsb and width of an insert (…FIZ, BFI, BFC). */
function insertEncode(f: Fields): string | void {
  const n = size(f)
  if (f.lsb! >= n) return L(`lsb 应在 0 到 ${n - 1} 之间`, `lsb must be 0 to ${n - 1}`)
  if (f.width! < 1 || f.width! > n - f.lsb!) return L(`width 应在 1 到 ${n - f.lsb!} 之间`, `width must be 1 to ${n - f.lsb!}`)
  f.N = f.sf!
  f.immr = (n - f.lsb!) % n
  f.imms = f.width! - 1
}
function insertDecode(f: Fields) {
  const n = size(f)
  f.lsb = (n - f.immr!) % n
  f.width = f.imms! + 1
}
/** lsb and width of an extract (…FX, BFXIL). */
function extractEncode(f: Fields): string | void {
  const n = size(f)
  if (f.lsb! >= n) return L(`lsb 应在 0 到 ${n - 1} 之间`, `lsb must be 0 to ${n - 1}`)
  if (f.width! < 1 || f.width! > n - f.lsb!) return L(`width 应在 1 到 ${n - f.lsb!} 之间`, `width must be 1 to ${n - f.lsb!}`)
  f.N = f.sf!
  f.immr = f.lsb!
  f.imms = f.lsb! + f.width! - 1
}
function extractDecode(f: Fields) {
  f.lsb = f.immr!
  f.width = f.imms! - f.immr! + 1
}

const shiftCheck = (f: Fields): string | void => {
  if (f.shift! >= size(f)) return L(`移位量应在 0 到 ${size(f) - 1} 之间`, `The shift must be 0 to ${size(f) - 1}`)
}

export const ALIASES: AliasSpec[] = [
  // ADD/SUB immediate
  {
    id: 'mov-sp',
    of: 'add-imm',
    mnemonic: 'mov',
    syntax: '<Rd|SP>, <Rn|SP>',
    fixed: { sh: 0, imm12: 0 },
    prefer: (f) => f.Rd === 31 || f.Rn === 31,
    encode: (f) => (f.Rd === 31 || f.Rn === 31 ? undefined : L('这种写法只用于 sp：两个普通寄存器之间请用 mov xd, xn（即 orr）', 'This form is for sp only')),
    example: 'mov x29, sp',
    desc: T('在 sp 和寄存器之间传送（add Rd, Rn, #0）', 'Move to or from sp (add Rd, Rn, #0)'),
  },
  { id: 'cmn-imm', of: 'adds-imm', mnemonic: 'cmn', syntax: '<Rn|SP>, #<aimm>{, lsl #<sh12>}', fixed: { Rd: 31 }, desc: T('和立即数比较（相加），只设置标志', 'Compare negative with an immediate (adds, flags only)') },
  { id: 'cmp-imm', of: 'subs-imm', mnemonic: 'cmp', syntax: '<Rn|SP>, #<aimm>{, lsl #<sh12>}', fixed: { Rd: 31 }, desc: T('和立即数比较（相减），只设置标志', 'Compare with an immediate (subs, flags only)') },
  // Negative immediates are written with the opposite instruction, as LLVM does.
  { id: 'add-nimm', of: 'sub-imm', mnemonic: 'add', syntax: '<Rd|SP>, <Rn|SP>, #<-aimm>{, lsl #<sh12>}', prefer: false },
  { id: 'adds-nimm', of: 'subs-imm', mnemonic: 'adds', syntax: '<Rd>, <Rn|SP>, #<-aimm>{, lsl #<sh12>}', prefer: false },
  { id: 'sub-nimm', of: 'add-imm', mnemonic: 'sub', syntax: '<Rd|SP>, <Rn|SP>, #<-aimm>{, lsl #<sh12>}', prefer: false },
  { id: 'subs-nimm', of: 'adds-imm', mnemonic: 'subs', syntax: '<Rd>, <Rn|SP>, #<-aimm>{, lsl #<sh12>}', prefer: false },
  { id: 'cmp-nimm', of: 'adds-imm', mnemonic: 'cmp', syntax: '<Rn|SP>, #<-aimm>{, lsl #<sh12>}', fixed: { Rd: 31 }, prefer: false },
  { id: 'cmn-nimm', of: 'subs-imm', mnemonic: 'cmn', syntax: '<Rn|SP>, #<-aimm>{, lsl #<sh12>}', fixed: { Rd: 31 }, prefer: false },
  // Logical immediates
  { id: 'tst-imm', of: 'ands-imm', mnemonic: 'tst', syntax: '<Rn>, #<bimm>', fixed: { Rd: 31 }, desc: T('测试位：按位与后只设置标志', 'Test bits: AND and set the flags only') },
  // MOV (wide immediate): MOVZ first, then MOVN, then ORR — the order LLVM tries them in.
  {
    id: 'mov-movz',
    of: 'movz',
    mnemonic: 'mov',
    syntax: '<Rd>, #<movz>',
    prefer: (f) => !(f.imm16 === 0 && f.hw !== 0),
    desc: T('传送立即数（编码成 movz）', 'Move an immediate (as movz)'),
  },
  {
    id: 'mov-movn',
    of: 'movn',
    mnemonic: 'mov',
    syntax: '<Rd>, #<movn>',
    prefer: (f) => !(f.imm16 === 0 && f.hw !== 0) && !(f.sf === 0 && f.imm16 === 0xffff),
    desc: T('传送立即数（编码成 movn）', 'Move an immediate (as movn)'),
  },
  {
    id: 'mov-bimm',
    of: 'orr-imm',
    mnemonic: 'mov',
    syntax: '<Rd|SP>, #<bimm>',
    fixed: { Rn: 31 },
    prefer: (f) => !movWideValue(logicImm(f), f.sf!),
    desc: T('传送立即数（编码成 orr 逻辑立即数）', 'Move an immediate (as orr with a logical immediate)'),
  },
  // SBFM
  {
    id: 'asr-imm',
    of: 'sbfm',
    mnemonic: 'asr',
    syntax: '<Rd>, <Rn>, #<u6:shift>',
    prefer: (f) => f.imms === (f.sf ? 63 : 31),
    encode: (f) => {
      const e = shiftCheck(f)
      if (e) return e
      f.N = f.sf!
      f.immr = f.shift!
      f.imms = size(f) - 1
    },
    decode: (f) => void (f.shift = f.immr!),
    desc: T('算术右移立即数位（高位补符号位）', 'Arithmetic shift right by an immediate (fills with the sign bit)'),
  },
  {
    id: 'sbfiz',
    of: 'sbfm',
    mnemonic: 'sbfiz',
    syntax: '<Rd>, <Rn>, #<u6:lsb>, #<u7:width>',
    prefer: (f) => f.imms! < f.immr!,
    encode: insertEncode,
    decode: insertDecode,
    desc: T('取 Rn 低 width 位，符号扩展后放到第 lsb 位起', 'Take the low width bits of Rn, sign-extend, and place them at bit lsb'),
  },
  {
    id: 'sbfx',
    of: 'sbfm',
    mnemonic: 'sbfx',
    syntax: '<Rd>, <Rn>, #<u6:lsb>, #<u7:width>',
    prefer: (f) => bfxPreferred(f, false),
    encode: extractEncode,
    decode: extractDecode,
    desc: T('从第 lsb 位起取 width 位，符号扩展', 'Extract width bits from bit lsb, sign-extended'),
  },
  { id: 'sxtb', of: 'sbfm', mnemonic: 'sxtb', syntax: '<Rd>, <Wn>', fixed: { immr: 0, imms: 7 }, encode: (f) => void (f.N = f.sf!), desc: T('字节符号扩展', 'Sign-extend a byte') },
  { id: 'sxth', of: 'sbfm', mnemonic: 'sxth', syntax: '<Rd>, <Wn>', fixed: { immr: 0, imms: 15 }, encode: (f) => void (f.N = f.sf!), desc: T('半字符号扩展', 'Sign-extend a halfword') },
  { id: 'sxtw', of: 'sbfm', mnemonic: 'sxtw', syntax: '<Xd>, <Wn>', fixed: { sf: 1, N: 1, immr: 0, imms: 31 }, desc: T('字（32 位）符号扩展到 64 位', 'Sign-extend a word to 64 bits') },
  // BFM
  {
    id: 'bfc',
    of: 'bfm',
    mnemonic: 'bfc',
    syntax: '<Rd>, #<u6:lsb>, #<u7:width>',
    fixed: { Rn: 31 },
    prefer: (f) => f.imms! < f.immr!,
    encode: insertEncode,
    decode: insertDecode,
    desc: T('把从第 lsb 位起的 width 位清零', 'Clear width bits starting at bit lsb'),
  },
  {
    id: 'bfi',
    of: 'bfm',
    mnemonic: 'bfi',
    syntax: '<Rd>, <Rn>, #<u6:lsb>, #<u7:width>',
    prefer: (f) => f.Rn !== 31 && f.imms! < f.immr!,
    encode: insertEncode,
    decode: insertDecode,
    desc: T('把 Rn 的低 width 位插入 Rd 的第 lsb 位起', 'Insert the low width bits of Rn into Rd at bit lsb'),
  },
  {
    id: 'bfxil',
    of: 'bfm',
    mnemonic: 'bfxil',
    syntax: '<Rd>, <Rn>, #<u6:lsb>, #<u7:width>',
    prefer: (f) => f.imms! >= f.immr!,
    encode: extractEncode,
    decode: extractDecode,
    desc: T('从 Rn 第 lsb 位起取 width 位，放进 Rd 的低位', 'Extract width bits of Rn from bit lsb into the low bits of Rd'),
  },
  // UBFM
  {
    id: 'lsl-imm',
    of: 'ubfm',
    mnemonic: 'lsl',
    syntax: '<Rd>, <Rn>, #<u6:shift>',
    prefer: (f) => f.imms !== (f.sf ? 63 : 31) && f.imms! + 1 === f.immr,
    encode: (f) => {
      const e = shiftCheck(f)
      if (e) return e
      const n = size(f)
      f.N = f.sf!
      f.immr = (n - f.shift!) % n
      f.imms = n - 1 - f.shift!
    },
    decode: (f) => void (f.shift = size(f) - 1 - f.imms!),
    desc: T('逻辑左移立即数位', 'Logical shift left by an immediate'),
  },
  {
    id: 'lsr-imm',
    of: 'ubfm',
    mnemonic: 'lsr',
    syntax: '<Rd>, <Rn>, #<u6:shift>',
    prefer: (f) => f.imms === (f.sf ? 63 : 31),
    encode: (f) => {
      const e = shiftCheck(f)
      if (e) return e
      f.N = f.sf!
      f.immr = f.shift!
      f.imms = size(f) - 1
    },
    decode: (f) => void (f.shift = f.immr!),
    desc: T('逻辑右移立即数位（高位补 0）', 'Logical shift right by an immediate (fills with zeros)'),
  },
  {
    id: 'ubfiz',
    of: 'ubfm',
    mnemonic: 'ubfiz',
    syntax: '<Rd>, <Rn>, #<u6:lsb>, #<u7:width>',
    prefer: (f) => f.imms! < f.immr!,
    encode: insertEncode,
    decode: insertDecode,
    desc: T('取 Rn 低 width 位放到第 lsb 位起，其余位清零', 'Take the low width bits of Rn and place them at bit lsb, zeroing the rest'),
  },
  {
    id: 'ubfx',
    of: 'ubfm',
    mnemonic: 'ubfx',
    syntax: '<Rd>, <Rn>, #<u6:lsb>, #<u7:width>',
    prefer: (f) => bfxPreferred(f, true),
    encode: extractEncode,
    decode: extractDecode,
    desc: T('从第 lsb 位起取 width 位，高位补 0', 'Extract width bits from bit lsb, zero-extended'),
  },
  { id: 'uxtb', of: 'ubfm', mnemonic: 'uxtb', syntax: '<Wd>, <Wn>', fixed: { sf: 0, N: 0, immr: 0, imms: 7 }, desc: T('字节零扩展', 'Zero-extend a byte') },
  { id: 'uxtw', of: 'ubfm', mnemonic: 'uxtw', syntax: '<Xd>, <Wn>', fixed: { sf: 1, N: 1, immr: 0, imms: 31 }, prefer: false, desc: T('字零扩展到 64 位（ubfx x, x, #0, #32）', 'Zero-extend a word to 64 bits (ubfx x, x, #0, #32)') },
  { id: 'uxth', of: 'ubfm', mnemonic: 'uxth', syntax: '<Wd>, <Wn>', fixed: { sf: 0, N: 0, immr: 0, imms: 15 }, desc: T('半字零扩展', 'Zero-extend a halfword') },
  // EXTR
  {
    id: 'ror-imm',
    of: 'extr',
    mnemonic: 'ror',
    syntax: '<Rd>, <Rn>, #<u6:shift>',
    prefer: (f) => f.Rn === f.Rm,
    encode: (f) => {
      const e = shiftCheck(f)
      if (e) return e
      f.N = f.sf!
      f.Rm = f.Rn!
      f.imms = f.shift!
    },
    decode: (f) => void (f.shift = f.imms!),
    desc: T('循环右移立即数位', 'Rotate right by an immediate'),
  },
]
