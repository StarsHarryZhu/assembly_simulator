/** Coprocessor 1: single and double precision floating point, as MARS 4.5 implements it. */
import { T } from '../../../core/i18n'
import { def, type Cpu, type Decoded, type InstrDef, type Op } from './types'

const S = 0x10
const D = 0x11
const W = 0x14

const ALL = T('双精度运算的所有寄存器都必须是偶数号（$f0、$f2……）', 'All registers of a double-precision operation must be even-numbered ($f0, $f2, …)')
const BOTH = T('两个寄存器都必须是偶数号（双精度占一对寄存器）', 'Both registers must be even-numbered (a double uses a register pair)')
const FIRST = T('第一个寄存器必须是偶数号（双精度占一对寄存器）', 'The first register must be even-numbered (a double uses a register pair)')
const SECOND = T('第二个寄存器必须是偶数号（双精度占一对寄存器）', 'The second register must be even-numbered (a double uses a register pair)')

const FR = (name: string, fmt: number, funct: number, ops: Op[], desc: string, exec: (c: Cpu, d: Decoded) => void) =>
  def(name, 'FR', ops, { op: 0x11, fmt, funct, ...(ops.includes('ft') ? {} : { ft: 0 }) }, 'FP', desc, exec)

/** floor/ceil/round/trunc: MARS gives 2^31 − 1 for NaN, infinities and anything outside the int range. */
function toWord(x: number, f: (x: number) => number): number {
  if (!Number.isFinite(x) || x < -2147483648 || x > 2147483647) return 0x7fffffff
  return f(x) | 0
}

/** Round half to even, the IEEE / MIPS default. */
function roundEven(x: number): number {
  const fl = Math.floor(x)
  if (x - fl === 0.5) return fl % 2 === 0 ? fl : fl + 1
  return Math.round(x)
}

/** Java's (int) cast: truncate toward zero, saturate, NaN -> 0. */
function javaInt(x: number): number {
  if (Number.isNaN(x)) return 0
  if (x >= 2147483647) return 2147483647
  if (x <= -2147483648) return -2147483648
  return Math.trunc(x) | 0
}

const f32 = Math.fround

function single3(name: string, funct: number, sym: string, op: (a: number, b: number) => number): InstrDef {
  return FR(name + '.s', S, funct, ['fd', 'fs', 'ft'], `{fd} ← {fs} ${sym} {ft}（单精度）`, (c, d) =>
    c.setSingle(d.fd, f32(op(c.single(d.fs), c.single(d.ft)))),
  )
}

function double3(name: string, funct: number, sym: string, op: (a: number, b: number) => number): InstrDef {
  return FR(name + '.d', D, funct, ['fd', 'fs', 'ft'], `{fd} ← {fs} ${sym} {ft}（双精度，寄存器成对使用）`, (c, d) => {
    c.requireEven(ALL, d.fd, d.fs, d.ft)
    c.setDouble(d.fd, op(c.double(d.fs), c.double(d.ft)))
  })
}

function roundingOps(fmt: number, suffix: 's' | 'd'): InstrDef[] {
  const read = (c: Cpu, d: Decoded) => {
    if (suffix === 'd') c.requireEven(SECOND, d.fs)
    return suffix === 's' ? c.single(d.fs) : c.double(d.fs)
  }
  const kinds: [string, number, string, (x: number) => number][] = [
    ['floor', 0x0f, '向下取整', Math.floor],
    ['ceil', 0x0e, '向上取整', Math.ceil],
    ['round', 0x0c, '四舍六入五取偶', roundEven],
    ['trunc', 0x0d, '向 0 截断', Math.trunc],
  ]
  return kinds.map(([n, funct, how, fn]) =>
    FR(`${n}.w.${suffix}`, fmt, funct, ['fd', 'fs'], `{fd} ← {fs} ${how}后的 32 位整数（超出范围或 NaN 时得到 2³¹−1）`, (c, d) =>
      c.setFbits(d.fd, toWord(read(c, d), fn)),
    ),
  )
}

function compare(name: string, funct: number, fmt: number, sym: string, test: (a: number, b: number) => boolean): InstrDef[] {
  const dbl = fmt === D
  const read = (c: Cpu, n: number) => (dbl ? c.double(n) : c.single(n))
  const run = (c: Cpu, d: Decoded, cc: number) => {
    if (dbl) c.requireEven(BOTH, d.fs, d.ft)
    c.setFcc(cc, test(read(c, d.fs), read(c, d.ft)))
  }
  const what = dbl ? '双精度' : '单精度'
  return [
    def(name, 'FCMP', ['fs', 'ft'], { op: 0x11, fmt, cc: 0, zero: 0, funct }, 'FP', `条件标志 0 ← ({fs} ${sym} {ft})（${what}）`, (c, d) => run(c, d, 0)),
    def(name, 'FCMP', ['cc', 'fs', 'ft'], { op: 0x11, fmt, zero: 0, funct }, 'FP', `条件标志 {cc} ← ({fs} ${sym} {ft})（${what}）`, (c, d) => run(c, d, d.ccLow)),
  ]
}

function moveOps(fmt: number, suffix: 's' | 'd'): InstrDef[] {
  const dbl = suffix === 'd'
  const copy = (c: Cpu, d: Decoded) => {
    if (dbl) {
      c.setFbits(d.fd, c.fbits(d.fs))
      c.setFbits(d.fd + 1, c.fbits(d.fs + 1))
    } else c.setFbits(d.fd, c.fbits(d.fs))
  }
  const even = (c: Cpu, d: Decoded) => {
    if (dbl) c.requireEven(BOTH, d.fd, d.fs)
  }
  const what = dbl ? '（双精度，复制一对寄存器）' : ''
  const M = (tf: number, withCc: boolean): InstrDef =>
    def(
      `mov${tf ? 't' : 'f'}.${suffix}`,
      'FMOVC',
      withCc ? ['fd', 'fs', 'cc'] : ['fd', 'fs'],
      { op: 0x11, fmt, nd: 0, tf, funct: 0x11, ...(withCc ? {} : { cc: 0 }) },
      'FP',
      `若条件标志 ${withCc ? '{cc}' : '0'} 为${tf ? '真' : '假'}，则 {fd} ← {fs}${what}`,
      (c, d) => {
        even(c, d)
        if (c.fcc(withCc ? d.cc : 0) === (tf === 1)) copy(c, d)
      },
    )
  return [
    FR(`mov.${suffix}`, fmt, 0x06, ['fd', 'fs'], `{fd} ← {fs}${what}`, (c, d) => {
      even(c, d)
      copy(c, d)
    }),
    M(0, false),
    M(0, true),
    M(1, false),
    M(1, true),
    def(`movn.${suffix}`, 'FRG', ['fd', 'fs', 'rt'], { op: 0x11, fmt, funct: 0x13 }, 'FP', `若 {rt} ≠ 0，则 {fd} ← {fs}${what}`, (c, d) => {
      even(c, d)
      if (c.g(d.rt) !== 0) copy(c, d)
    }),
    def(`movz.${suffix}`, 'FRG', ['fd', 'fs', 'rt'], { op: 0x11, fmt, funct: 0x12 }, 'FP', `若 {rt} = 0，则 {fd} ← {fs}${what}`, (c, d) => {
      even(c, d)
      if (c.g(d.rt) === 0) copy(c, d)
    }),
  ]
}

const ea = (c: Cpu, d: Decoded) => (c.g(d.rs) + d.simm) | 0

export const COP1: InstrDef[] = [
  single3('add', 0x00, '+', (a, b) => a + b),
  single3('sub', 0x01, '−', (a, b) => a - b),
  single3('mul', 0x02, '×', (a, b) => a * b),
  single3('div', 0x03, '÷', (a, b) => a / b),
  FR('sqrt.s', S, 0x04, ['fd', 'fs'], '{fd} ← √{fs}（单精度；负数得到 NaN）', (c, d) => c.setSingle(d.fd, f32(Math.sqrt(c.single(d.fs))))),
  ...roundingOps(S, 's'),
  double3('add', 0x00, '+', (a, b) => a + b),
  double3('sub', 0x01, '−', (a, b) => a - b),
  double3('mul', 0x02, '×', (a, b) => a * b),
  double3('div', 0x03, '÷', (a, b) => a / b),
  FR('sqrt.d', D, 0x04, ['fd', 'fs'], '{fd} ← √{fs}（双精度）', (c, d) => {
    c.requireEven(BOTH, d.fd, d.fs)
    c.setDouble(d.fd, Math.sqrt(c.double(d.fs)))
  }),
  ...roundingOps(D, 'd'),
  def('bc1t', 'FBR', ['off'], { op: 0x11, sub: 0x08, cc: 0, nd: 0, tf: 1 }, 'FP', '若条件标志 0 为真，跳到 {off}', (c, d) => {
    if (c.fcc(0)) c.branch(d.simm)
  }),
  def('bc1t', 'FBR', ['cc', 'off'], { op: 0x11, sub: 0x08, nd: 0, tf: 1 }, 'FP', '若条件标志 {cc} 为真，跳到 {off}', (c, d) => {
    if (c.fcc(d.cc)) c.branch(d.simm)
  }),
  def('bc1f', 'FBR', ['off'], { op: 0x11, sub: 0x08, cc: 0, nd: 0, tf: 0 }, 'FP', '若条件标志 0 为假，跳到 {off}', (c, d) => {
    if (!c.fcc(0)) c.branch(d.simm)
  }),
  def('bc1f', 'FBR', ['cc', 'off'], { op: 0x11, sub: 0x08, nd: 0, tf: 0 }, 'FP', '若条件标志 {cc} 为假，跳到 {off}', (c, d) => {
    if (!c.fcc(d.cc)) c.branch(d.simm)
  }),
  ...compare('c.eq.s', 0x32, S, '=', (a, b) => a === b),
  ...compare('c.le.s', 0x3e, S, '≤', (a, b) => a <= b),
  ...compare('c.lt.s', 0x3c, S, '<', (a, b) => a < b),
  ...compare('c.eq.d', 0x32, D, '=', (a, b) => a === b),
  ...compare('c.le.d', 0x3e, D, '≤', (a, b) => a <= b),
  ...compare('c.lt.d', 0x3c, D, '<', (a, b) => a < b),
  FR('abs.s', S, 0x05, ['fd', 'fs'], '{fd} ← |{fs}|（清除符号位）', (c, d) => c.setFbits(d.fd, c.fbits(d.fs) & 0x7fffffff)),
  FR('abs.d', D, 0x05, ['fd', 'fs'], '{fd} ← |{fs}|（双精度，清除高位寄存器的符号位）', (c, d) => {
    c.requireEven(BOTH, d.fd, d.fs)
    c.setFbits(d.fd + 1, c.fbits(d.fs + 1) & 0x7fffffff)
    c.setFbits(d.fd, c.fbits(d.fs))
  }),
  FR('cvt.d.s', S, 0x21, ['fd', 'fs'], '{fd} ← 单精度 {fs} 转成双精度', (c, d) => {
    c.requireEven(FIRST, d.fd)
    c.setDouble(d.fd, c.single(d.fs))
  }),
  FR('cvt.d.w', W, 0x21, ['fd', 'fs'], '{fd} ← {fs} 里的 32 位整数转成双精度', (c, d) => {
    c.requireEven(FIRST, d.fd)
    c.setDouble(d.fd, c.fbits(d.fs))
  }),
  FR('cvt.s.d', D, 0x20, ['fd', 'fs'], '{fd} ← 双精度 {fs} 转成单精度', (c, d) => {
    c.requireEven(SECOND, d.fs)
    c.setSingle(d.fd, f32(c.double(d.fs)))
  }),
  FR('cvt.s.w', W, 0x20, ['fd', 'fs'], '{fd} ← {fs} 里的 32 位整数转成单精度', (c, d) => c.setSingle(d.fd, f32(c.fbits(d.fs)))),
  FR('cvt.w.d', D, 0x24, ['fd', 'fs'], '{fd} ← 双精度 {fs} 截断成 32 位整数', (c, d) => {
    c.requireEven(SECOND, d.fs)
    c.setFbits(d.fd, javaInt(c.double(d.fs)))
  }),
  FR('cvt.w.s', S, 0x24, ['fd', 'fs'], '{fd} ← 单精度 {fs} 截断成 32 位整数', (c, d) => c.setFbits(d.fd, javaInt(c.single(d.fs)))),
  ...moveOps(D, 'd'),
  ...moveOps(S, 's'),
  def('mfc1', 'CP1M', ['rt', 'fs'], { op: 0x11, sub: 0x00, zero: 0 }, 'FP', '{rt} ← {fs} 的 32 位原始内容（不做转换）', (c, d) => c.sg(d.rt, c.fbits(d.fs))),
  def('mtc1', 'CP1M', ['rt', 'fs'], { op: 0x11, sub: 0x04, zero: 0 }, 'FP', '{fs} ← {rt} 的 32 位原始内容（不做转换）', (c, d) => c.setFbits(d.fs, c.g(d.rt))),
  FR('neg.d', D, 0x07, ['fd', 'fs'], '{fd} ← −{fs}（双精度，翻转符号位）', (c, d) => {
    c.requireEven(BOTH, d.fd, d.fs)
    c.setFbits(d.fd + 1, c.fbits(d.fs + 1) ^ 0x80000000)
    c.setFbits(d.fd, c.fbits(d.fs))
  }),
  FR('neg.s', S, 0x07, ['fd', 'fs'], '{fd} ← −{fs}（翻转符号位）', (c, d) => c.setFbits(d.fd, c.fbits(d.fs) ^ 0x80000000)),
  def('lwc1', 'FI', ['ft', 'mem'], { op: 0x31 }, 'FP', '{ft} ← 内存[{mem}] 的 4 字节', (c, d) => c.setFbits(d.ft, c.loadWord(ea(c, d)))),
  def('ldc1', 'FI', ['ft', 'mem'], { op: 0x35 }, 'FP', '{ft} 这一对寄存器 ← 内存[{mem}] 的 8 字节（地址必须是 8 的倍数）', (c, d) => {
    c.requireEven(FIRST, d.ft)
    const a = ea(c, d)
    c.requireDoubleAligned(a, false)
    c.setFbits(d.ft, c.loadWord(a))
    c.setFbits(d.ft + 1, c.loadWord(a + 4))
  }),
  def('swc1', 'FI', ['ft', 'mem'], { op: 0x39 }, 'FP', '内存[{mem}] ← {ft} 的 4 字节', (c, d) => c.storeWord(ea(c, d), c.fbits(d.ft))),
  def('sdc1', 'FI', ['ft', 'mem'], { op: 0x3d }, 'FP', '内存[{mem}] 的 8 字节 ← {ft} 这一对寄存器（地址必须是 8 的倍数）', (c, d) => {
    c.requireEven(FIRST, d.ft)
    const a = ea(c, d)
    c.requireDoubleAligned(a, true)
    c.storeWord(a, c.fbits(d.ft))
    c.storeWord(a + 4, c.fbits(d.ft + 1))
  }),
]
