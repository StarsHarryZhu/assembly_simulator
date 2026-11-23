/**
 * The operand kinds that templates name (see syntax.ts), for the A64 base instruction set.
 *
 * Registers:      <Wd> <Xd> <Rd> (W or X by `sf`), with |SP or |WSP when 31 means the stack pointer;
 *                 the letter picks the field: d n m t t2 s a. <Rs+1> is the second register of a pair.
 * Immediates:     <u:imm12> <s:imm9> unsigned or signed fields; <u6:lsb> gives a width for a value that is
 *                 not an encoding field (aliases compute their fields from it); `*8` scales, `+1` offsets.
 * Addresses:      <label:imm19> (words from this instruction), <adr>, <adrp>.
 * Everything else is named: <cond> <shift> <shiftr> <ext:dn> <ext:n> <bimm> <hw> <sh12> <mov16>
 * <regoff:N> <sysreg> <pstate> <barrier> <prfop> <cr:CRn> <sysop:dc> <tbzreg> <bitpos> <cond:cc>.
 */
import { L } from '../../../core/i18n'
import { addrOf } from '../../../core/format'
import { gprName, parseGpr, SYSREG_BY_ENC, SYSREG_BY_NAME } from '../registers'
import { decodeBitmask, encodeBitmask } from './bitmask'
import { fmtImm, hexAddr, unify, vaOf, type Fields, type OperandStream, type OperandType, type OpSpec } from './syntax'

const sext = (v: number, bits: number) => (bits >= 32 ? v | 0 : (v << (32 - bits)) >> (32 - bits))

/* ------------------------------------------------------------------ registers */

interface RegArg {
  field: string
  width: 'W' | 'X' | 'R'
  sp: boolean
  /** The register after the one in `field` (pairs). */
  plus: boolean
  /** The field that picks W or X for 'R'. */
  sel: string
  /** Optional register that defaults to 31 (SYS's Xt) or 30 (RET's Xn). */
  dflt: number | null
}

const SAMPLE_REG: Record<string, number> = { Rd: 0, Rn: 1, Rm: 2, Ra: 3, Rt: 0, Rt2: 1, Rs: 2 }

const isX = (f: Fields, a: RegArg) => (a.width === 'X' ? true : a.width === 'W' ? false : f[a.sel] === 1)

function regHint(a: RegArg): string {
  const w = a.width === 'W' ? L('32 位寄存器 w0–w30', '32-bit register w0–w30') : a.width === 'X' ? L('64 位寄存器 x0–x30', '64-bit register x0–x30') : L('寄存器 x0–x30 或 w0–w30', 'register x0–x30 or w0–w30')
  return a.sp ? w + L('，或 sp', ', or sp') : w + L('，或零寄存器', ', or the zero register')
}

const reg: OperandType<RegArg> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const t = s.peek()
    const r = t && t.kind === 'ident' ? parseGpr(t.text) : null
    if (!r) s.fail(L(`这里应该是${regHint(a)}`, `Expected a ${regHint(a)}`))
    if (r.sp && !a.sp) s.fail(L('这里不能用 sp（编号 31 在这里是零寄存器）', 'sp is not allowed here (number 31 means the zero register here)'))
    if (r.zr && a.sp) s.fail(L('这里不能用零寄存器（编号 31 在这里是 sp）', 'The zero register is not allowed here (number 31 means sp here)'))
    if (a.width === 'W' && r.x) s.fail(L(`这里要 32 位的 W 寄存器，不是 ${t!.text}`, `Expected a 32-bit W register, not ${t!.text}`))
    if (a.width === 'X' && !r.x) s.fail(L(`这里要 64 位的 X 寄存器，不是 ${t!.text}`, `Expected a 64-bit X register, not ${t!.text}`))
    if (a.width === 'R') unify(s, f, a.sel, r.x ? 1 : 0, L('寄存器宽度不一致：这些操作数要么都用 X（64 位），要么都用 W（32 位）', 'Register widths differ: use all X (64-bit) or all W (32-bit) registers here'))
    if (a.plus) {
      const first = f[a.field]
      if (first === undefined || first % 2 !== 0 || r.n !== first + 1)
        s.fail(L('寄存器对要连续，并且第一个是偶数编号，例如 x0, x1', 'A register pair must be consecutive, starting at an even number, e.g. x0, x1'), true)
    } else unify(s, f, a.field, r.n)
    s.pos++
  },
  print: (f, a) => gprName(a.plus ? (f[a.field]! + 1) & 31 : f[a.field]!, isX(f, a), a.sp),
  fields: (a) => (a.width === 'R' ? [a.field, a.sel] : [a.field]),
  isDefault: (f, a) => a.dflt !== null && f[a.field] === a.dflt,
  fillDefault(f, a) {
    if (a.dflt !== null && f[a.field] === undefined) f[a.field] = a.dflt
  },
  sample(f, a) {
    if (a.width === 'R' && f[a.sel] === undefined) f[a.sel] = 1
    if (a.plus) return gprName((f[a.field] ?? 0) + 1, isX(f, a), a.sp)
    const n = f[a.field] ?? SAMPLE_REG[a.field] ?? 0
    f[a.field] = n
    return gprName(n, isX(f, a), a.sp)
  },
  hint: (a) => regHint(a),
  options(f, a) {
    const x = a.width === 'R' ? (f[a.sel] ?? 1) === 1 : a.width === 'X'
    return [...Array.from({ length: 31 }, (_, i) => gprName(i, x, false)), gprName(31, x, a.sp)]
  },
}

/* ------------------------------------------------------------------ immediates */

interface ImmArg {
  field: string
  signed: boolean
  /** Explicit width (for values that are not encoding fields); otherwise the field's. */
  width: number | null
  scale: number
  add: number
  /** Field value when the operand is left out. */
  dflt: number | null
}

/** Apply a relocation operator (`:lo12:sym`); only :lo12: fits ordinary immediates. */
function relocValue(s: OperandStream, allowed: string[]): { value: bigint; reloc: string | null } {
  if (s.isPunct(':')) {
    const at = s.pos
    const name = s.word(1)
    if (!name || !s.isPunct(':', 2)) s.fail(L('重定位写法是 :lo12:符号', 'A relocation is written :lo12:symbol'), true)
    if (!allowed.includes(name)) s.fail(L(`这里不能用 :${name}:`, `:${name}: is not allowed here`), true, at)
    s.pos += 3
    return { value: s.expr(), reloc: name }
  }
  return { value: s.expr(), reloc: null }
}

function immRange(a: ImmArg, w: number): [bigint, bigint] {
  const lo = a.signed ? -(1n << BigInt(w - 1)) : 0n
  const hi = a.signed ? (1n << BigInt(w - 1)) - 1n : (1n << BigInt(w)) - 1n
  return [lo * BigInt(a.scale) + BigInt(a.add), hi * BigInt(a.scale) + BigInt(a.add)]
}

const immWidth = (s: OperandStream | null, a: ImmArg) => a.width ?? s!.width(a.field)

/** Field widths of the encoding last compiled, so printing knows them (set by the table). */
export const printWidths: { current: Record<string, number> } = { current: {} }

const imm: OperandType<ImmArg> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    const { value, reloc } = relocValue(s, ['lo12'])
    let v = reloc === 'lo12' ? value & 0xfffn : value
    const w = immWidth(s, a)
    const [lo, hi] = immRange(a, w)
    if (v < lo || v > hi) {
      s.fail(
        a.scale > 1
          ? L(`立即数 ${v} 超出范围：应是 ${lo} 到 ${hi} 之间 ${a.scale} 的倍数`, `Immediate ${v} out of range: expected a multiple of ${a.scale} from ${lo} to ${hi}`)
          : L(`立即数 ${v} 超出范围：应在 ${lo} 到 ${hi} 之间`, `Immediate ${v} out of range: expected ${lo} to ${hi}`),
        true,
        at,
      )
    }
    v -= BigInt(a.add)
    if (v % BigInt(a.scale) !== 0n) s.fail(L(`立即数 ${v + BigInt(a.add)} 应是 ${a.scale} 的倍数`, `Immediate ${v + BigInt(a.add)} must be a multiple of ${a.scale}`), true, at)
    const field = Number(v / BigInt(a.scale))
    unify(s, f, a.field, a.signed ? field & ((1 << w) - 1) : field)
  },
  print(f, a) {
    const w = a.width ?? printWidths.current[a.field] ?? 32
    const raw = f[a.field] ?? 0
    return fmtImm((a.signed ? sext(raw, w) : raw) * a.scale + a.add)
  },
  fields: (a) => [a.field],
  isDefault: (f, a) => (f[a.field] ?? 0) === (a.dflt ?? 0),
  fillDefault(f, a) {
    if (a.dflt !== null && f[a.field] === undefined) f[a.field] = a.dflt
  },
  sample(f, a) {
    const w = a.width ?? printWidths.current[a.field] ?? 12
    const [lo, hi] = immRange(a, w)
    let v = 16n
    if (v > hi || v < lo || (v - BigInt(a.add)) % BigInt(a.scale) !== 0n) v = BigInt(a.scale) + BigInt(a.add)
    if (v > hi) v = lo
    f[a.field] = Number((v - BigInt(a.add)) / BigInt(a.scale)) & ((1 << w) - 1)
    return fmtImm(v)
  },
  hint(a) {
    const w = a.width ?? printWidths.current[a.field] ?? 12
    const [lo, hi] = immRange(a, w)
    return a.scale > 1 ? L(`${lo} 到 ${hi} 之间 ${a.scale} 的倍数`, `multiple of ${a.scale} from ${lo} to ${hi}`) : L(`${lo} 到 ${hi} 的整数`, `integer from ${lo} to ${hi}`)
  },
}

/**
 * ADD/SUB immediate: 0–4095, or a multiple of 4096 up to 4095 × 4096 (which sets the lsl #12 bit).
 * `neg`: the alias that writes SUB as ADD of a negative number (and back).
 */
const aimm: OperandType<{ neg: boolean }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    const { value, reloc } = relocValue(s, ['lo12'])
    let v = reloc === 'lo12' ? value & 0xfffn : value
    if (a.neg) {
      if (v >= 0n) s.fail(L('这里要负数', 'A negative number is expected here'), false, at)
      v = -v
    } else if (v < 0n) s.fail(L(`立即数 ${v} 不能是负数`, `Immediate ${v} cannot be negative`), false, at)
    if (v <= 4095n) unify(s, f, 'imm12', Number(v))
    else if (v % 4096n === 0n && v / 4096n <= 4095n) {
      unify(s, f, 'imm12', Number(v / 4096n))
      unify(s, f, 'sh', 1)
    } else s.fail(L(`立即数 ${a.neg ? -v : v} 超出范围：应在 0 到 4095 之间（或 4096 的倍数，最大 4095 × 4096）`, `Immediate ${a.neg ? -v : v} out of range: expected 0 to 4095 (or a multiple of 4096 up to 4095 × 4096)`), true, at)
  },
  print: (f, a) => fmtImm(a.neg ? -f.imm12! : f.imm12!),
  fields: () => ['imm12'],
  isDefault: (f) => (f.imm12 ?? 0) === 0,
  sample(f, a) {
    f.imm12 = 16
    return a.neg ? '-16' : '16'
  },
  hint: () => L('0 到 4095 的整数', 'integer from 0 to 4095'),
}

/** The value of MOV (wide immediate): what MOVZ (or MOVN, `inverted`) puts in the register. */
const wideImm: OperandType<{ inverted: boolean }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    const orig = s.expr()
    const size = f.sf === 0 ? 32 : 64
    if (size === 32 && (orig < -(1n << 31n) || orig >= 1n << 32n)) s.fail(L(`${fmtImm(orig)} 超出 32 位`, `${fmtImm(orig)} does not fit in 32 bits`), true, at)
    const m = size === 32 ? 0xffffffffn : 0xffffffffffffffffn
    let v = orig & m
    if (a.inverted) v = ~v & m
    for (let hw = 0; hw < size / 16; hw++) {
      if ((v & ~(0xffffn << BigInt(16 * hw)) & m) === 0n) {
        unify(s, f, 'hw', hw)
        unify(s, f, 'imm16', Number((v >> BigInt(16 * hw)) & 0xffffn))
        return
      }
    }
    const r = f.sf === 0 ? 'w' : 'x'
    s.fail(L(`${fmtImm(orig)} 不能用一条 mov 放进寄存器：可以改用 ldr ${r}0, =${fmtImm(orig)}`, `${fmtImm(orig)} cannot be loaded by one mov: use ldr ${r}0, =${fmtImm(orig)} instead`), true, at)
  },
  print(f, a) {
    const size = f.sf === 0 ? 32 : 64
    const v = BigInt(f.imm16!) << BigInt(16 * f.hw!)
    return fmtImm(BigInt.asIntN(size, a.inverted ? ~v : v))
  },
  fields: () => ['imm16', 'hw'],
  sample(f, a) {
    f.imm16 = a.inverted ? 0 : 42
    f.hw = 0
    return a.inverted ? '-1' : '42'
  },
  hint: () => L('立即数（16 位一段，可在任意 16 位边界上）', 'immediate (16 bits at any 16-bit boundary)'),
}

/* ------------------------------------------------------------------ addresses */

interface LabelArg {
  field: string
}

/** A label (or address) as a word offset from this instruction, in a signed field. */
const label: OperandType<LabelArg> = {
  kind: 'label',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是标签', 'Expected a label'))
    const at = s.pos
    const target = s.expr()
    const off = BigInt.asIntN(64, target - vaOf(s.ctx.pc))
    const w = s.width(a.field)
    const limit = 1n << BigInt(w + 1)
    if (off % 4n !== 0n) s.fail(L('跳转目标没有按 4 字节对齐', 'The target is not 4-byte aligned'), true, at)
    if (off < -limit || off >= limit) s.fail(L(`目标太远：偏移 ${off} 字节超出 ±${limit} 字节`, `Target too far: offset ${off} bytes is beyond ±${limit} bytes`), true, at)
    unify(s, f, a.field, Number(off / 4n) & ((1 << w) - 1))
  },
  print(f, a, ctx) {
    const w = printWidths.current[a.field] ?? 19
    const target = BigInt.asUintN(64, vaOf(ctx.pc) + BigInt(sext(f[a.field]!, w) * 4))
    const name = ctx.name?.(target)
    return name ? `${hexAddr(target)} <${name}>` : hexAddr(target)
  },
  fields: (a) => [a.field],
  sample: () => 'label',
  hint: () => L('标签或地址', 'a label or address'),
}

/** ADR: a byte offset in immhi:immlo. ADRP (page): the 4 KB page offset. */
const adr: OperandType<{ page: boolean }> = {
  kind: 'label',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是标签', 'Expected a label'))
    const at = s.pos
    const target = s.expr()
    const pc = vaOf(s.ctx.pc)
    const off = a.page ? BigInt.asIntN(64, (target & ~0xfffn) - (pc & ~0xfffn)) >> 12n : BigInt.asIntN(64, target - pc)
    if (off < -(1n << 20n) || off >= 1n << 20n)
      s.fail(a.page ? L('目标太远：adrp 只能到 ±4 GB 以内的页', 'Target too far: adrp reaches pages within ±4 GB') : L('目标太远：adr 只能到 ±1 MB 以内', 'Target too far: adr reaches ±1 MB'), true, at)
    const v = Number(off) & 0x1fffff
    unify(s, f, 'immlo', v & 3)
    unify(s, f, 'immhi', v >>> 2)
  },
  print(f, a, ctx) {
    const off = BigInt(sext((f.immhi! << 2) | f.immlo!, 21))
    const pc = vaOf(ctx.pc)
    const target = BigInt.asUintN(64, a.page ? (pc & ~0xfffn) + (off << 12n) : pc + off)
    const name = a.page ? null : ctx.name?.(target)
    return name ? `${hexAddr(target)} <${name}>` : hexAddr(target)
  },
  fields: () => ['immhi', 'immlo'],
  sample: () => 'label',
  hint: (a) => (a.page ? L('标签（取它所在的 4 KB 页）', 'a label (its 4 KB page)') : L('标签或地址', 'a label or address')),
}

/** LDRAA/LDRAB offset: a multiple of 8 from −4096 to 4088, in S:imm9. */
const pacoff: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    const v = s.expr()
    if (v < -4096n || v > 4088n || v % 8n !== 0n) s.fail(L(`偏移 ${v} 应是 −4096 到 4088 之间 8 的倍数`, `The offset ${v} must be a multiple of 8 from −4096 to 4088`), true, at)
    const x = Number(v / 8n) & 0x3ff
    unify(s, f, 'S', x >> 9)
    unify(s, f, 'imm9', x & 0x1ff)
  },
  print: (f) => fmtImm(sext((f.S! << 9) | f.imm9!, 10) * 8),
  fields: () => ['S', 'imm9'],
  isDefault: (f) => !f.S && !f.imm9,
  sample(f) {
    f.S = 0
    f.imm9 = 2
    return '16'
  },
  hint: () => L('−4096 到 4088 之间 8 的倍数', 'multiple of 8 from −4096 to 4088'),
}

/* ------------------------------------------------------------------ named operands */

export const COND_NAMES = ['eq', 'ne', 'hs', 'lo', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv']
const COND_ALIASES: Record<string, number> = { cs: 2, cc: 3 }
export function condNumber(name: string): number | null {
  const n = COND_NAMES.indexOf(name.toLowerCase())
  if (n >= 0) return n
  return COND_ALIASES[name.toLowerCase()] ?? null
}

const cond: OperandType<{ field: string; noAlNv: boolean }> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields, a) {
    const w = s.word()
    const n = w == null ? null : condNumber(w)
    if (n == null) s.fail(L('这里应该是条件，例如 eq、ne、lt、ge', 'Expected a condition such as eq, ne, lt, ge'))
    if (a.noAlNv && n >= 14) s.fail(L('这里不能用 al 或 nv', 'al and nv are not allowed here'), true)
    unify(s, f, a.field, n)
    s.pos++
  },
  print: (f, a) => COND_NAMES[f[a.field]!]!,
  fields: (a) => [a.field],
  sample(f, a) {
    f[a.field] = 0
    return 'eq'
  },
  hint: () => L('条件：eq ne hs lo mi pl vs vc hi ls ge lt gt le', 'condition: eq ne hs lo mi pl vs vc hi ls ge lt gt le'),
  options: (_f, a) => COND_NAMES.slice(0, a.noAlNv ? 14 : 16),
}

const SHIFT_NAMES = ['lsl', 'lsr', 'asr', 'ror']
const shift: OperandType<{ ror: boolean }> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields, a) {
    const w = s.word()
    const n = w == null ? -1 : SHIFT_NAMES.indexOf(w)
    if (n < 0 || (n === 3 && !a.ror)) s.fail(a.ror ? L('这里应该是移位方式 lsl、lsr、asr 或 ror', 'Expected a shift: lsl, lsr, asr or ror') : L('这里应该是移位方式 lsl、lsr 或 asr', 'Expected a shift: lsl, lsr or asr'))
    unify(s, f, 'shift', n)
    s.pos++
  },
  print: (f) => SHIFT_NAMES[f.shift!]!,
  fields: () => ['shift'],
  isDefault: (f) => f.shift === 0,
  sample(f) {
    f.shift = 0
    return 'lsl'
  },
  hint: (a) => (a.ror ? 'lsl / lsr / asr / ror' : 'lsl / lsr / asr'),
  options: (_f, a) => SHIFT_NAMES.slice(0, a.ror ? 4 : 3),
}

const EXTEND_NAMES = ['uxtb', 'uxth', 'uxtw', 'uxtx', 'sxtb', 'sxth', 'sxtw', 'sxtx']

/**
 * The extended-register operand of ADD/SUB: Rm, an extend and a shift of 0–4 (option, imm3). When the
 * destination or first source is SP, UXTX (UXTW for 32-bit) is written LSL, and left out when the shift is 0.
 */
const ext: OperandType<{ rd: boolean }> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const t = s.peek()
    const r = t && t.kind === 'ident' ? parseGpr(t.text) : null
    if (!r || r.sp) s.fail(L('这里应该是寄存器', 'Expected a register'))
    s.pos++
    const sf = f.sf ?? 1
    const spForm = (a.rd && f.Rd === 31) || f.Rn === 31
    let option: number
    let amount = 0
    if (s.eat(',')) {
      const w = s.word()
      const at = s.pos
      if (w === 'lsl') {
        if (!spForm) s.fail(L('lsl 只在用到 sp 时才算扩展寄存器写法', 'lsl here is only for forms that use sp'))
        option = sf ? 3 : 2
      } else {
        option = w == null ? -1 : EXTEND_NAMES.indexOf(w)
        if (option < 0) s.fail(L('这里应该是扩展方式，例如 uxtw、sxtw、uxtx', 'Expected an extend such as uxtw, sxtw, uxtx'))
      }
      s.pos++
      if (s.isPunct('#') || s.startsValue()) {
        s.eat('#')
        const v = s.expr()
        if (v < 0n || v > 4n) s.fail(L('扩展后的移位只能是 0 到 4', 'The shift after an extend must be 0 to 4'), true, at)
        amount = Number(v)
      } else if (w === 'lsl') s.fail(L('lsl 后面要写移位量', 'lsl needs a shift amount'))
    } else {
      if (!spForm) s.fail(L('这里要写扩展方式（例如 uxtw），或者改用移位寄存器写法', 'An extend is needed here (e.g. uxtw)'))
      option = sf ? 3 : 2
    }
    const wantX = sf === 1 && (option & 3) === 3
    if (r.x !== wantX) s.fail(wantX ? L(`${EXTEND_NAMES[option]} 要配 X 寄存器`, `${EXTEND_NAMES[option]} takes an X register`) : L('这里要 W 寄存器', 'A W register is needed here'), true)
    unify(s, f, 'Rm', r.n)
    unify(s, f, 'option', option)
    unify(s, f, 'imm3', amount)
  },
  print(f, a) {
    const sf = f.sf ?? 1
    const option = f.option!
    const r = gprName(f.Rm!, sf === 1 && (option & 3) === 3, false)
    const spForm = (a.rd && f.Rd === 31) || f.Rn === 31
    if (spForm && option === (sf ? 3 : 2)) return f.imm3 ? `${r}, lsl #${f.imm3}` : r
    return f.imm3 ? `${r}, ${EXTEND_NAMES[option]} #${f.imm3}` : `${r}, ${EXTEND_NAMES[option]}`
  },
  fields: () => ['Rm', 'option', 'imm3'],
  sample(f) {
    f.Rm = 2
    f.option = 2
    f.imm3 = 0
    return 'w2, uxtw'
  },
  hint: () => L('寄存器加扩展方式，例如 w2, sxtw #2', 'register and extend, e.g. w2, sxtw #2'),
}

/** Logical immediate (N:immr:imms), 32 or 64 bits by `sf` unless fixed. */
const bimm: OperandType<{ size: 32 | 64 | null }> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields, a) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    let v = s.expr()
    const size = a.size ?? (f.sf === 0 ? 32 : 64)
    if (size === 32) {
      if (v < -(1n << 31n) || v >= 1n << 32n) s.fail(L(`${hexAddr(v)} 超出 32 位`, `${hexAddr(v)} does not fit in 32 bits`), true, at)
      v &= 0xffffffffn
    }
    const e = encodeBitmask(v, size)
    if (!e) s.fail(L(`${fmtImm(v)} 不能写成逻辑立即数（要是一段连续的 1，循环移位后按 2、4、8、16、32 或 64 位重复）`, `${fmtImm(v)} is not a logical immediate (a rotated run of ones, repeated every 2, 4, 8, 16, 32 or 64 bits)`), true, at)
    unify(s, f, 'N', e.N)
    unify(s, f, 'immr', e.immr)
    unify(s, f, 'imms', e.imms)
  },
  print(f, a) {
    const size = a.size ?? (f.sf === 0 ? 32 : 64)
    const v = decodeBitmask(f.N!, f.immr!, f.imms!, size)
    return v == null ? '?' : hexAddr(v)
  },
  fields: () => ['N', 'immr', 'imms'],
  sample(f, a) {
    const size = a.size ?? (f.sf === 0 ? 32 : 64)
    const e = encodeBitmask(0xffn, size)!
    Object.assign(f, e)
    return '0xff'
  },
  hint: () => L('逻辑立即数，例如 0xff、0xf0f0f0f0', 'logical immediate, e.g. 0xff, 0xf0f0f0f0'),
}

/** `lsl #<hw>`: a multiple of 16 picking the half-word (MOVZ, MOVN, MOVK). */
const hw: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    const at = s.pos
    if (!s.startsValue()) s.fail(L('这里应该是 0、16、32 或 48', 'Expected 0, 16, 32 or 48'))
    const v = s.expr()
    const max = f.sf === 0 ? 16n : 48n
    if (v < 0n || v > max || v % 16n !== 0n) s.fail(f.sf === 0 ? L('W 寄存器只能左移 0 或 16', 'A W register shifts by 0 or 16') : L('只能左移 0、16、32 或 48', 'The shift must be 0, 16, 32 or 48'), true, at)
    unify(s, f, 'hw', Number(v / 16n), L('移位和 :abs_g: 重定位给的不一致', 'The shift disagrees with the :abs_g: relocation'))
  },
  print: (f) => String(f.hw! * 16),
  fields: () => ['hw'],
  isDefault: (f) => (f.hw ?? 0) === 0,
  sample(f) {
    f.hw = 1
    return '16'
  },
  hint: () => '0 / 16 / 32 / 48',
}

/** `lsl #12` on ADD/SUB immediates: 0 or 12, in the one-bit field sh. */
const sh12: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    const at = s.pos
    if (!s.startsValue()) s.fail(L('这里应该是 0 或 12', 'Expected 0 or 12'))
    const v = s.expr()
    if (v !== 0n && v !== 12n) s.fail(L('这里只能左移 0 或 12', 'The shift must be 0 or 12'), true, at)
    unify(s, f, 'sh', v === 12n ? 1 : 0)
  },
  print: (f) => (f.sh ? '12' : '0'),
  fields: () => ['sh'],
  isDefault: (f) => (f.sh ?? 0) === 0,
  sample(f) {
    f.sh = 1
    return '12'
  },
  hint: () => '0 / 12',
}

/** The 16-bit immediate of MOVZ/MOVN/MOVK; :abs_g0: to :abs_g3: (and _nc) pick a half-word of a symbol. */
const mov16: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    if (!s.startsValue()) s.fail(L('这里应该是立即数', 'Expected an immediate'))
    const at = s.pos
    const { value, reloc } = relocValue(s, ['abs_g0', 'abs_g1', 'abs_g2', 'abs_g3', 'abs_g0_nc', 'abs_g1_nc', 'abs_g2_nc'])
    if (reloc) {
      const g = Number(reloc[5])
      const u = BigInt.asUintN(64, value)
      if (!reloc.endsWith('_nc') && g < 3 && u >> BigInt(16 * (g + 1)) !== 0n) s.fail(L(`${hexAddr(u)} 超出 :${reloc}: 能表示的范围`, `${hexAddr(u)} does not fit :${reloc}:`), true, at)
      unify(s, f, 'hw', g)
      unify(s, f, 'imm16', Number((u >> BigInt(16 * g)) & 0xffffn))
      return
    }
    if (value < 0n || value > 0xffffn) s.fail(L(`立即数 ${value} 超出范围：应在 0 到 65535 之间`, `Immediate ${value} out of range: expected 0 to 65535`), true, at)
    unify(s, f, 'imm16', Number(value))
  },
  print: (f) => fmtImm(f.imm16!),
  fields: () => ['imm16'],
  sample(f) {
    f.imm16 = 0x1234
    return '0x1234'
  },
  hint: () => L('0 到 65535 的整数', 'integer from 0 to 65535'),
}

/** Register offset of loads and stores: Rm{, extend {#amount}} into Rm, option and S. */
const regoff: OperandType<{ size: number }> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields, a) {
    const t = s.peek()
    const r = t && t.kind === 'ident' ? parseGpr(t.text) : null
    if (!r || r.sp) s.fail(L('这里应该是偏移寄存器', 'Expected an offset register'))
    s.pos++
    let option = 3
    let S = 0
    if (s.eat(',')) {
      const w = s.word()
      const at = s.pos
      if (w === 'lsl') option = 3
      else if (w === 'uxtw') option = 2
      else if (w === 'sxtw') option = 6
      else if (w === 'sxtx') option = 7
      else s.fail(L('这里应该是 lsl、uxtw、sxtw 或 sxtx', 'Expected lsl, uxtw, sxtw or sxtx'))
      s.pos++
      if (s.isPunct('#') || s.startsValue()) {
        s.eat('#')
        const v = s.expr()
        if (v !== 0n && v !== BigInt(a.size)) s.fail(L(`移位量只能是 0 或 ${a.size}`, `The shift must be 0 or ${a.size}`), true, at)
        S = a.size === 0 ? (s.toks[s.pos - 1]?.kind === 'num' ? 1 : 0) : v === 0n ? 0 : 1
      } else if (w === 'lsl') s.fail(L('lsl 后面要写移位量', 'lsl needs a shift amount'))
    }
    const wantX = (option & 1) === 1
    if (r.x !== wantX) s.fail(wantX ? L('这种写法要 X 寄存器', 'This form takes an X register') : L('uxtw/sxtw 要配 W 寄存器', 'uxtw/sxtw take a W register'), true)
    unify(s, f, 'Rm', r.n)
    unify(s, f, 'option', option)
    unify(s, f, 'S', S)
  },
  print(f, a) {
    const option = f.option!
    const r = gprName(f.Rm!, (option & 1) === 1, false)
    const name = option === 3 ? 'lsl' : option === 2 ? 'uxtw' : option === 6 ? 'sxtw' : option === 7 ? 'sxtx' : `option${option}`
    if (option === 3 && !f.S) return r
    if (!f.S) return `${r}, ${name}`
    return `${r}, ${name} #${a.size}`
  },
  fields: () => ['Rm', 'option', 'S'],
  sample(f) {
    f.Rm = 2
    f.option = 3
    f.S = 0
    return 'x2'
  },
  hint: (a) => L(`偏移寄存器，可加 lsl #${a.size}、uxtw、sxtw`, `offset register, optionally lsl #${a.size}, uxtw, sxtw`),
}

/* ------------------------------------------------------------------ system operands */

/** MRS/MSR system register: a name, or s<op0>_<op1>_c<n>_c<m>_<op2>. */
const sysreg: OperandType<null> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields) {
    const w = s.word()
    if (!w) s.fail(L('这里应该是系统寄存器，例如 tpidr_el0', 'Expected a system register such as tpidr_el0'))
    let e: number
    const known = SYSREG_BY_NAME.get(w)
    if (known) e = known.enc
    else {
      const m = /^s([0-3])_([0-7])_c(\d+)_c(\d+)_([0-7])$/.exec(w)
      if (!m || Number(m[3]) > 15 || Number(m[4]) > 15) s.fail(L(`不认识的系统寄存器 "${w}"`, `Unknown system register "${w}"`), true)
      e = (Number(m[1]) << 14) | (Number(m[2]) << 11) | (Number(m[3]) << 7) | (Number(m[4]) << 3) | Number(m[5])
    }
    unify(s, f, 'op0', (e >> 14) & 3)
    unify(s, f, 'op1', (e >> 11) & 7)
    unify(s, f, 'CRn', (e >> 7) & 15)
    unify(s, f, 'CRm', (e >> 3) & 15)
    unify(s, f, 'op2', e & 7)
    s.pos++
  },
  print(f) {
    const e = (f.op0! << 14) | (f.op1! << 11) | (f.CRn! << 7) | (f.CRm! << 3) | f.op2!
    const known = SYSREG_BY_ENC.get(e)
    return known ? known.name.toLowerCase() : `s${f.op0}_${f.op1}_c${f.CRn}_c${f.CRm}_${f.op2}`
  },
  fields: () => ['op0', 'op1', 'CRn', 'CRm', 'op2'],
  sample(f) {
    Object.assign(f, { op0: 3, op1: 3, CRn: 13, CRm: 0, op2: 2 })
    return 'tpidr_el0'
  },
  hint: () => L('系统寄存器，例如 tpidr_el0、nzcv', 'system register, e.g. tpidr_el0, nzcv'),
}

/** MSR (immediate) targets: op1 and op2 name a PSTATE field. */
export const PSTATE_FIELDS: { name: string; op1: number; op2: number }[] = [
  { name: 'spsel', op1: 0, op2: 5 },
  { name: 'daifset', op1: 3, op2: 6 },
  { name: 'daifclr', op1: 3, op2: 7 },
  { name: 'uao', op1: 0, op2: 3 },
  { name: 'pan', op1: 0, op2: 4 },
  { name: 'dit', op1: 3, op2: 2 },
  { name: 'ssbs', op1: 3, op2: 1 },
]

const pstate: OperandType<null> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields) {
    const w = s.word()
    const p = PSTATE_FIELDS.find((x) => x.name === w)
    if (!p) s.fail(L('这里应该是 PSTATE 字段，例如 daifset、spsel', 'Expected a PSTATE field such as daifset, spsel'))
    unify(s, f, 'op1', p.op1)
    unify(s, f, 'op2', p.op2)
    s.pos++
  },
  print: (f) => PSTATE_FIELDS.find((x) => x.op1 === f.op1 && x.op2 === f.op2)?.name ?? `#${f.op1},${f.op2}`,
  fields: () => ['op1', 'op2'],
  sample(f) {
    f.op1 = 3
    f.op2 = 6
    return 'daifset'
  },
  hint: () => 'spsel / daifset / daifclr / pan / uao / dit / ssbs',
  options: () => PSTATE_FIELDS.map((p) => p.name),
}

const BARRIERS: Record<number, string> = { 1: 'oshld', 2: 'oshst', 3: 'osh', 5: 'nshld', 6: 'nshst', 7: 'nsh', 9: 'ishld', 10: 'ishst', 11: 'ish', 13: 'ld', 14: 'st', 15: 'sy' }

/** DMB/DSB option (CRm): a name or #0–15. ISB takes only sy. */
const barrier: OperandType<{ isb: boolean }> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields, a) {
    let v: number | null = null
    const w = s.word()
    if (w) {
      const e = Object.entries(BARRIERS).find(([, n]) => n === w)
      if (!e || (a.isb && w !== 'sy')) s.fail(a.isb ? L('isb 只能写 sy 或 #0–15', 'isb takes only sy or #0–15') : L('这里应该是屏障选项，例如 sy、ish、ishld', 'Expected a barrier option such as sy, ish, ishld'))
      v = Number(e[0])
      s.pos++
    } else {
      s.eat('#')
      const at = s.pos
      const x = s.expr()
      if (x < 0n || x > 15n) s.fail(L('屏障选项只能是 0 到 15', 'The barrier option must be 0 to 15'), true, at)
      v = Number(x)
    }
    unify(s, f, 'CRm', v)
  },
  print: (f, a) => (a.isb ? (f.CRm === 15 ? 'sy' : `#${f.CRm}`) : BARRIERS[f.CRm!] ?? `#${f.CRm}`),
  fields: () => ['CRm'],
  isDefault: (f, a) => a.isb && f.CRm === 15,
  fillDefault(f, a) {
    if (a.isb && f.CRm === undefined) f.CRm = 15
  },
  sample(f) {
    f.CRm = 11
    return 'ish'
  },
  hint: () => 'sy / ish / ishld / ishst / nsh / osh / ld / st',
  options: (_f, a) => (a.isb ? ['sy'] : Object.values(BARRIERS)),
}

const NXS = ['oshnxs', 'nshnxs', 'ishnxs', 'synxs']
/** DSB with nXS: the option in imm2 (or #16, #20, #24, #28). */
const nxs: OperandType<null> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields) {
    const w = s.word()
    let v: number
    if (w) {
      v = NXS.indexOf(w)
      if (v < 0) s.fail(L('这里应该是 oshnxs、nshnxs、ishnxs 或 synxs', 'Expected oshnxs, nshnxs, ishnxs or synxs'))
      s.pos++
    } else {
      s.eat('#')
      const at = s.pos
      const x = s.expr()
      if (x !== 16n && x !== 20n && x !== 24n && x !== 28n) s.fail(L('这里只能是 #16、#20、#24 或 #28', 'Only #16, #20, #24 or #28 is allowed here'), true, at)
      v = Number((x - 16n) / 4n)
    }
    unify(s, f, 'imm2', v)
  },
  print: (f) => NXS[f.imm2!]!,
  fields: () => ['imm2'],
  sample(f) {
    f.imm2 = 2
    return 'ishnxs'
  },
  hint: () => NXS.join(' / '),
  options: () => NXS,
}

/** PRFM operation (5 bits in Rt): pld/pli/pst, l1/l2/l3, keep/strm; or #0–31. */
const PRF_TYPES = ['pld', 'pli', 'pst']
const PRF_TARGETS = ['l1', 'l2', 'l3', 'slc']
export function prfName(v: number): string | null {
  const type = v >> 3
  const target = (v >> 1) & 3
  if (type > 2) return null
  return PRF_TYPES[type]! + PRF_TARGETS[target]! + (v & 1 ? 'strm' : 'keep')
}
const prfop: OperandType<null> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields) {
    const w = s.word()
    let v: number
    if (w) {
      const m = /^(pld|pli|pst)(l[123]|slc)(keep|strm)$/.exec(w)
      if (!m) s.fail(L('这里应该是预取操作，例如 pldl1keep', 'Expected a prefetch operation such as pldl1keep'))
      v = (PRF_TYPES.indexOf(m[1]!) << 3) | (PRF_TARGETS.indexOf(m[2]!) << 1) | (m[3] === 'strm' ? 1 : 0)
      s.pos++
    } else {
      s.eat('#')
      const at = s.pos
      const x = s.expr()
      if (x < 0n || x > 31n) s.fail(L('预取操作只能是 0 到 31', 'The prefetch operation must be 0 to 31'), true, at)
      v = Number(x)
    }
    unify(s, f, 'Rt', v)
  },
  print: (f) => prfName(f.Rt!) ?? `#${f.Rt}`,
  fields: () => ['Rt'],
  sample(f) {
    f.Rt = 0
    return 'pldl1keep'
  },
  hint: () => 'pldl1keep / pldl2strm / pstl1keep / …',
}

/** C0–C15 of SYS and SYSL. */
const cr: OperandType<{ field: string }> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields, a) {
    const m = /^c(\d+)$/.exec(s.word() ?? '')
    if (!m || Number(m[1]) > 15) s.fail(L('这里应该是 c0 到 c15', 'Expected c0 to c15'))
    unify(s, f, a.field, Number(m[1]))
    s.pos++
  },
  print: (f, a) => `c${f[a.field]}`,
  fields: (a) => [a.field],
  sample(f, a) {
    f[a.field] = 7
    return 'c7'
  },
  hint: () => 'c0–c15',
}

/** DC, IC, AT and TLBI operations: names for op1, CRn, CRm, op2 of SYS. `reg`: whether the operation takes an Xt. */
export interface SysOp {
  name: string
  op1: number
  CRn: number
  CRm: number
  op2: number
  reg: boolean
}
const so = (name: string, op1: number, CRn: number, CRm: number, op2: number, reg = true): SysOp => ({ name, op1, CRn, CRm, op2, reg })
export const SYS_OPS: Record<string, SysOp[]> = {
  dc: [
    so('ivac', 0, 7, 6, 1),
    so('isw', 0, 7, 6, 2),
    so('csw', 0, 7, 10, 2),
    so('cisw', 0, 7, 14, 2),
    so('zva', 3, 7, 4, 1),
    so('cvac', 3, 7, 10, 1),
    so('cvau', 3, 7, 11, 1),
    so('cvap', 3, 7, 12, 1),
    so('cvadp', 3, 7, 13, 1),
    so('civac', 3, 7, 14, 1),
  ],
  ic: [so('ialluis', 0, 7, 1, 0, false), so('iallu', 0, 7, 5, 0, false), so('ivau', 3, 7, 5, 1)],
  at: [
    so('s1e1r', 0, 7, 8, 0),
    so('s1e1w', 0, 7, 8, 1),
    so('s1e0r', 0, 7, 8, 2),
    so('s1e0w', 0, 7, 8, 3),
    so('s1e1rp', 0, 7, 9, 0),
    so('s1e1wp', 0, 7, 9, 1),
    so('s1e2r', 4, 7, 8, 0),
    so('s1e2w', 4, 7, 8, 1),
    so('s12e1r', 4, 7, 8, 4),
    so('s12e1w', 4, 7, 8, 5),
    so('s12e0r', 4, 7, 8, 6),
    so('s12e0w', 4, 7, 8, 7),
    so('s1e3r', 6, 7, 8, 0),
    so('s1e3w', 6, 7, 8, 1),
  ],
  tlbi: tlbiOps(),
}

/**
 * TLBI operations by level (op1 0 = EL1, 4 = EL2, 6 = EL3), sharing domain and kind (CRm, op2). Every one
 * also has an nXS form with CRn = 9 (FEAT_XS).
 */
function tlbiOps(): SysOp[] {
  // [op1, CRm, op2, name, takes a register]
  const base: [number, number, number, string, boolean][] = []
  const domains: [number, string][] = [
    [1, 'os'],
    [3, 'is'],
    [7, ''],
  ]
  const ranges: [number, string][] = [
    [5, 'os'],
    [2, 'is'],
    [6, ''],
  ]
  for (const [crm, d] of domains) {
    base.push([0, crm, 0, `vmalle1${d}`, false], [0, crm, 1, `vae1${d}`, true], [0, crm, 2, `aside1${d}`, true], [0, crm, 3, `vaae1${d}`, true], [0, crm, 5, `vale1${d}`, true], [0, crm, 7, `vaale1${d}`, true])
    base.push([4, crm, 0, `alle2${d}`, false], [4, crm, 1, `vae2${d}`, true], [4, crm, 4, `alle1${d}`, false], [4, crm, 5, `vale2${d}`, true], [4, crm, 6, `vmalls12e1${d}`, false])
    base.push([6, crm, 0, `alle3${d}`, false], [6, crm, 1, `vae3${d}`, true], [6, crm, 5, `vale3${d}`, true])
  }
  for (const [crm, d] of ranges) {
    base.push([0, crm, 1, `rvae1${d}`, true], [0, crm, 3, `rvaae1${d}`, true], [0, crm, 5, `rvale1${d}`, true], [0, crm, 7, `rvaale1${d}`, true])
    base.push([4, crm, 1, `rvae2${d}`, true], [4, crm, 5, `rvale2${d}`, true])
    base.push([6, crm, 1, `rvae3${d}`, true], [6, crm, 5, `rvale3${d}`, true])
  }
  // Stage 2 by IPA (EL2).
  base.push([4, 0, 1, 'ipas2e1is', true], [4, 0, 2, 'ripas2e1is', true], [4, 0, 5, 'ipas2le1is', true], [4, 0, 6, 'ripas2le1is', true])
  base.push([4, 4, 0, 'ipas2e1os', true], [4, 4, 1, 'ipas2e1', true], [4, 4, 2, 'ripas2e1', true], [4, 4, 3, 'ripas2e1os', true])
  base.push([4, 4, 4, 'ipas2le1os', true], [4, 4, 5, 'ipas2le1', true], [4, 4, 6, 'ripas2le1', true], [4, 4, 7, 'ripas2le1os', true])
  const out: SysOp[] = []
  for (const [op1, crm, op2, name, reg] of base) out.push(so(name, op1, 8, crm, op2, reg))
  for (const [op1, crm, op2, name, reg] of base) out.push(so(`${name}nxs`, op1, 9, crm, op2, reg))
  return out
}

/** Find the operation a SYS encoding names. */
export function sysOpOf(kind: string, f: Fields): SysOp | null {
  return SYS_OPS[kind]?.find((o) => o.op1 === f.op1 && o.CRn === f.CRn && o.CRm === f.CRm && o.op2 === f.op2) ?? null
}

const sysop: OperandType<{ kind: string; reg: boolean }> = {
  kind: 'word',
  parse(s: OperandStream, f: Fields, a) {
    const w = s.word()
    const op = SYS_OPS[a.kind]!.find((o) => o.name === w && o.reg === a.reg)
    if (!op) s.fail(L(`这里应该是 ${a.kind} 的操作名，例如 ${SYS_OPS[a.kind]!.find((o) => o.reg === a.reg)?.name}`, `Expected a ${a.kind} operation such as ${SYS_OPS[a.kind]!.find((o) => o.reg === a.reg)?.name}`))
    unify(s, f, 'op1', op.op1)
    unify(s, f, 'CRn', op.CRn)
    unify(s, f, 'CRm', op.CRm)
    unify(s, f, 'op2', op.op2)
    s.pos++
  },
  print: (f, a) => sysOpOf(a.kind, f)?.name ?? '?',
  fields: () => ['op1', 'CRn', 'CRm', 'op2'],
  sample(f, a) {
    const op = SYS_OPS[a.kind]!.find((o) => o.reg === a.reg)!
    Object.assign(f, { op1: op.op1, CRn: op.CRn, CRm: op.CRm, op2: op.op2 })
    return op.name
  },
  hint: (a) => SYS_OPS[a.kind]!.filter((o) => o.reg === a.reg).map((o) => o.name).join(' / '),
  options: (_f, a) => SYS_OPS[a.kind]!.filter((o) => o.reg === a.reg).map((o) => o.name),
}

/** TBZ/TBNZ: the register (W when the bit number is below 32) and the bit number in b5:b40. */
const tbzreg: OperandType<null> = {
  kind: 'reg',
  parse(s: OperandStream, f: Fields) {
    const t = s.peek()
    const r = t && t.kind === 'ident' ? parseGpr(t.text) : null
    if (!r || r.sp) s.fail(L('这里应该是寄存器', 'Expected a register'))
    f.tbzX = r.x ? 1 : 0
    unify(s, f, 'Rt', r.n)
    s.pos++
  },
  print: (f) => gprName(f.Rt!, f.b5 === 1, false),
  fields: () => ['Rt', 'b5'],
  sample(f) {
    f.Rt = 0
    f.tbzX = 0
    return 'w0'
  },
  hint: () => L('要测试的寄存器', 'the register to test'),
}

const bitpos: OperandType<null> = {
  kind: 'imm',
  parse(s: OperandStream, f: Fields) {
    if (!s.startsValue()) s.fail(L('这里应该是位号', 'Expected a bit number'))
    const at = s.pos
    const v = s.expr()
    const max = f.tbzX === 0 ? 31n : 63n
    if (v < 0n || v > max) s.fail(L(`位号应在 0 到 ${max} 之间`, `The bit number must be 0 to ${max}`), true, at)
    unify(s, f, 'b5', Number(v >> 5n))
    unify(s, f, 'b40', Number(v & 31n))
  },
  print: (f) => String((f.b5! << 5) | f.b40!),
  fields: () => ['b5', 'b40'],
  sample(f) {
    f.b5 = 0
    f.b40 = 3
    return '3'
  },
  hint: () => L('位号 0–63（W 寄存器 0–31）', 'bit number 0–63 (0–31 for a W register)'),
}

/* ------------------------------------------------------------------ resolver */

const REG_FIELD: Record<string, string> = { d: 'Rd', n: 'Rn', m: 'Rm', t: 'Rt', t2: 'Rt2', s: 'Rs', a: 'Ra' }

const cache = new Map<string, OpSpec>()

/** Turn a placeholder name into an operand type and its arguments. */
export function resolve(name: string): OpSpec {
  const hit = cache.get(name)
  if (hit) return hit
  const spec = resolveUncached(name)
  cache.set(name, spec)
  return spec
}

function resolveUncached(name: string): OpSpec {
  let m = /^([WXR])(d|n|m|t|t2|s|a)(\+1)?(\|W?SP)?(?:=(\d+))?$/.exec(name)
  if (m) return { type: reg, arg: { field: REG_FIELD[m[2]!]!, width: m[1] as RegArg['width'], sp: !!m[4], plus: !!m[3], sel: 'sf', dflt: m[5] ? Number(m[5]) : null }, name }
  m = /^(u|s)(\d+)?:(\w+)(?:\*(\d+))?(?:\+(\d+))?(?:=(\d+))?$/.exec(name)
  if (m) return { type: imm, arg: { field: m[3]!, signed: m[1] === 's', width: m[2] ? Number(m[2]) : null, scale: m[4] ? Number(m[4]) : 1, add: m[5] ? Number(m[5]) : 0, dflt: m[6] ? Number(m[6]) : null }, name }
  m = /^label:(\w+)$/.exec(name)
  if (m) return { type: label, arg: { field: m[1]! }, name }
  m = /^cond(?::(\w+))?(!)?$/.exec(name)
  if (m) return { type: cond, arg: { field: m[1] ?? 'cond', noAlNv: !!m[2] }, name }
  m = /^regoff:(\d)$/.exec(name)
  if (m) return { type: regoff, arg: { size: Number(m[1]) }, name }
  m = /^cr:(\w+)$/.exec(name)
  if (m) return { type: cr, arg: { field: m[1]! }, name }
  m = /^sysop:(\w+)(-)?$/.exec(name)
  if (m) return { type: sysop, arg: { kind: m[1]!, reg: !m[2] }, name }
  switch (name) {
    case 'adr':
      return { type: adr, arg: { page: false }, name }
    case 'aimm':
      return { type: aimm, arg: { neg: false }, name }
    case '-aimm':
      return { type: aimm, arg: { neg: true }, name }
    case 'movz':
      return { type: wideImm, arg: { inverted: false }, name }
    case 'movn':
      return { type: wideImm, arg: { inverted: true }, name }
    case 'adrp':
      return { type: adr, arg: { page: true }, name }
    case 'shift':
      return { type: shift, arg: { ror: false }, name }
    case 'shiftr':
      return { type: shift, arg: { ror: true }, name }
    case 'ext:dn':
      return { type: ext, arg: { rd: true }, name }
    case 'ext:n':
      return { type: ext, arg: { rd: false }, name }
    case 'bimm':
      return { type: bimm, arg: { size: null }, name }
    case 'hw':
      return { type: hw, arg: null, name }
    case 'sh12':
      return { type: sh12, arg: null, name }
    case 'mov16':
      return { type: mov16, arg: null, name }
    case 'sysreg':
      return { type: sysreg, arg: null, name }
    case 'pstate':
      return { type: pstate, arg: null, name }
    case 'barrier':
      return { type: barrier, arg: { isb: false }, name }
    case 'isbopt':
      return { type: barrier, arg: { isb: true }, name }
    case 'prfop':
      return { type: prfop, arg: null, name }
    case 'nxs':
      return { type: nxs, arg: null, name }
    case 'pacoff':
      return { type: pacoff, arg: null, name }
    case 'tbzreg':
      return { type: tbzreg, arg: null, name }
    case 'bitpos':
      return { type: bitpos, arg: null, name }
  }
  throw new Error(`unknown operand <${name}>`)
}

export { addrOf }
