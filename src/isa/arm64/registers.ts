/**
 * AArch64 registers: their flat ids (see IsaPlugin.registers), names, and the banks the register panel shows.
 *
 * Ids: x0–x30 0–30, sp 31 (the stack pointer of the current exception level), pc 32, the N Z C V flags
 * 33–36, the SIMD&FP registers v0–v31 40–71, the SVE registers z0–z31 72–103 (z<n> is the whole register
 * whose low 128 bits are v<n>, so both ids show the same storage), p0–p15 104–119 and FFR 120, and the
 * system registers from 140. Ids 121–132 are kept for the SME registers of a later phase.
 */
import { T, type Text } from '../../core/i18n'
import type { RegisterBank, RegisterSpec } from '../../core/isa'

export const SP = 31
export const PC = 32
export const FLAG_N = 33
export const FLAG_Z = 34
export const FLAG_C = 35
export const FLAG_V = 36
export const FP_REG = 29
/** v0, the first SIMD&FP register: v<n> is V0 + n. */
export const V0 = 40
export const LR = 30
/** z0: z<n> is Z0 + n, the same register as v<n> at the full vector length. */
export const Z0 = 72
/** p0: p<n> is P0 + n (0–15). */
export const P0 = 104
/** The first-fault register, kept like a 17th predicate. */
export const FFR = 120

/** System registers the machine keeps, with their ids and MRS/MSR encodings (o0:op1:CRn:CRm:op2 as 3:op1:n:m:op2). */
export interface SysRegDef {
  id: number
  name: string
  /** (op0 << 14) | (op1 << 11) | (CRn << 7) | (CRm << 3) | op2, as in the MRS and MSR instructions. */
  enc: number
  /** Lowest exception level that may read it (EL0 reads of EL1 registers trap). */
  readEl: 0 | 1
  /** Lowest exception level that may write it; null when it is read-only. */
  writeEl: 0 | 1 | null
  note: Text
  /** Shown in the register panel. */
  shown?: boolean
}

export const sysEnc = (op0: number, op1: number, crn: number, crm: number, op2: number) => (op0 << 14) | (op1 << 11) | (crn << 7) | (crm << 3) | op2

let nextId = 140
const sys = (name: string, e: number, readEl: 0 | 1, writeEl: 0 | 1 | null, note: Text, shown = false): SysRegDef => ({ id: nextId++, name, enc: e, readEl, writeEl, note, shown })

export const SYSREGS: SysRegDef[] = [
  sys('CurrentEL', sysEnc(3, 0, 4, 2, 2), 1, null, T('当前异常级别（第 3..2 位）：EL0 用户态、EL1 内核态', 'Current exception level (bits 3..2): EL0 user, EL1 kernel'), true),
  sys('SPSel', sysEnc(3, 0, 4, 2, 0), 1, 1, T('EL1 用哪个栈指针：0 = SP_EL0，1 = SP_EL1', 'Which stack pointer EL1 uses: 0 = SP_EL0, 1 = SP_EL1'), true),
  sys('DAIF', sysEnc(3, 3, 4, 2, 1), 1, 1, T('中断屏蔽位 D A I F（第 9..6 位）', 'Interrupt mask bits D A I F (bits 9..6)'), true),
  sys('NZCV', sysEnc(3, 3, 4, 2, 0), 0, 0, T('条件标志 N Z C V（第 31..28 位）', 'Condition flags N Z C V (bits 31..28)')),
  sys('SP_EL0', sysEnc(3, 0, 4, 1, 0), 1, 1, T('用户态（EL0）的栈指针', 'Stack pointer of EL0 (user mode)'), true),
  sys('SP_EL1', sysEnc(3, 4, 4, 1, 0), 1, null, T('内核态（EL1）的栈指针；在 EL1 用 sp 访问', 'Stack pointer of EL1 (kernel mode); reached as sp at EL1'), true),
  sys('ELR_EL1', sysEnc(3, 0, 4, 0, 1), 1, 1, T('异常返回地址：eret 跳回这里', 'Exception link register: eret returns here'), true),
  sys('SPSR_EL1', sysEnc(3, 0, 4, 0, 0), 1, 1, T('进入异常前保存的处理器状态（标志、屏蔽位、级别）', 'Saved processor state from before the exception (flags, masks, level)'), true),
  sys('ESR_EL1', sysEnc(3, 0, 5, 2, 0), 1, 1, T('异常原因：异常类别 EC 在第 31..26 位，细节 ISS 在第 24..0 位', 'Exception syndrome: class EC in bits 31..26, details ISS in bits 24..0'), true),
  sys('FAR_EL1', sysEnc(3, 0, 6, 0, 0), 1, 1, T('出错的数据地址（数据中止、对齐错误）', 'Faulting data address (data aborts, alignment faults)'), true),
  sys('VBAR_EL1', sysEnc(3, 0, 12, 0, 0), 1, 1, T('异常向量表的基址（按 2 KB 对齐）', 'Base address of the exception vector table (2 KB aligned)'), true),
  sys('TPIDR_EL0', sysEnc(3, 3, 13, 0, 2), 0, 0, T('线程指针，用户态可读写', 'Thread pointer, read-write at EL0'), true),
  sys('TPIDRRO_EL0', sysEnc(3, 3, 13, 0, 3), 0, 1, T('线程指针，用户态只读', 'Thread pointer, read-only at EL0'), true),
  sys('TPIDR_EL1', sysEnc(3, 0, 13, 0, 4), 1, 1, T('内核的线程指针', 'Kernel thread pointer'), true),
  sys('SCTLR_EL1', sysEnc(3, 0, 1, 0, 0), 1, 1, T('系统控制寄存器（这里只记录写入的值）', 'System control register (writes are only recorded here)')),
  sys('CPACR_EL1', sysEnc(3, 0, 1, 0, 2), 1, 1, T('浮点和 SIMD 的访问控制（这里只记录写入的值）', 'FP and SIMD access control (writes are only recorded here)')),
  sys('CONTEXTIDR_EL1', sysEnc(3, 0, 13, 0, 1), 1, 1, T('上下文编号', 'Context ID')),
  sys('MIDR_EL1', sysEnc(3, 0, 0, 0, 0), 1, null, T('处理器型号（Linux 在用户态模拟读取）', 'Main ID (Linux emulates reads at EL0)')),
  sys('MPIDR_EL1', sysEnc(3, 0, 0, 0, 5), 1, null, T('处理器编号', 'Multiprocessor affinity')),
  sys('REVIDR_EL1', sysEnc(3, 0, 0, 0, 6), 1, null, T('修订号', 'Revision ID')),
  sys('CTR_EL0', sysEnc(3, 3, 0, 0, 1), 0, null, T('缓存类型', 'Cache type')),
  sys('DCZID_EL0', sysEnc(3, 3, 0, 0, 7), 0, null, T('dc zva 清零的块大小', 'Block size of dc zva')),
  sys('CNTFRQ_EL0', sysEnc(3, 3, 14, 0, 0), 0, null, T('计时器频率（Hz）', 'Counter frequency (Hz)')),
  sys('CNTVCT_EL0', sysEnc(3, 3, 14, 0, 2), 0, null, T('虚拟计数器，按 CNTFRQ_EL0 的频率递增', 'Virtual counter, counting at CNTFRQ_EL0')),
  sys('CNTPCT_EL0', sysEnc(3, 3, 14, 0, 1), 0, null, T('物理计数器', 'Physical counter')),
  sys('ID_AA64PFR0_EL1', sysEnc(3, 0, 0, 4, 0), 1, null, T('处理器特性 0', 'Processor feature register 0')),
  sys('ID_AA64PFR1_EL1', sysEnc(3, 0, 0, 4, 1), 1, null, T('处理器特性 1', 'Processor feature register 1')),
  sys('ID_AA64ZFR0_EL1', sysEnc(3, 0, 0, 4, 4), 1, null, T('SVE 特性', 'SVE features')),
  sys('ID_AA64SMFR0_EL1', sysEnc(3, 0, 0, 4, 5), 1, null, T('SME 特性', 'SME features')),
  sys('ID_AA64ISAR0_EL1', sysEnc(3, 0, 0, 6, 0), 1, null, T('指令集特性 0', 'Instruction set attributes 0')),
  sys('ID_AA64ISAR1_EL1', sysEnc(3, 0, 0, 6, 1), 1, null, T('指令集特性 1', 'Instruction set attributes 1')),
  sys('ID_AA64ISAR2_EL1', sysEnc(3, 0, 0, 6, 2), 1, null, T('指令集特性 2', 'Instruction set attributes 2')),
  sys('ID_AA64MMFR0_EL1', sysEnc(3, 0, 0, 7, 0), 1, null, T('内存模型特性 0', 'Memory model features 0')),
  sys('ID_AA64MMFR1_EL1', sysEnc(3, 0, 0, 7, 1), 1, null, T('内存模型特性 1', 'Memory model features 1')),
  sys('ID_AA64MMFR2_EL1', sysEnc(3, 0, 0, 7, 2), 1, null, T('内存模型特性 2', 'Memory model features 2')),
  sys('ID_AA64DFR0_EL1', sysEnc(3, 0, 0, 5, 0), 1, null, T('调试特性 0', 'Debug features 0')),
  sys('FPCR', sysEnc(3, 3, 4, 4, 0), 0, 0, T('浮点控制：舍入方式 RMode（第 23..22 位）、清零 FZ、默认 NaN DN、替代处理 AH 等', 'Floating-point control: rounding mode RMode (bits 23..22), flush to zero FZ, default NaN DN, alternate handling AH and more')),
  sys('ZCR_EL1', sysEnc(3, 0, 1, 2, 0), 1, 1, T('SVE 控制：LEN（第 3..0 位）把向量长度限制在 (LEN + 1) × 128 位以内', 'SVE control: LEN (bits 3..0) limits the vector length to (LEN + 1) × 128 bits'), true),
  sys('FPSR', sysEnc(3, 3, 4, 4, 1), 0, 0, T('浮点状态：累计的异常标志 IOC DZC OFC UFC IXC IDC（第 7..0 位），饱和标志 QC（第 27 位）', 'Floating-point status: cumulative exceptions IOC DZC OFC UFC IXC IDC (bits 7..0), saturation QC (bit 27)')),
]

export const SYSREG_BY_ENC = new Map(SYSREGS.map((r) => [r.enc, r]))
export const SYSREG_BY_NAME = new Map(SYSREGS.map((r) => [r.name.toLowerCase(), r]))
export const SYSREG_BY_ID = new Map(SYSREGS.map((r) => [r.id, r]))
export const sysId = (name: string) => SYSREG_BY_NAME.get(name.toLowerCase())!.id

export const CURRENT_EL = sysId('CurrentEL')
export const SPSEL = sysId('SPSel')
export const DAIF = sysId('DAIF')
export const SP_EL0 = sysId('SP_EL0')
export const SP_EL1 = sysId('SP_EL1')
export const ELR_EL1 = sysId('ELR_EL1')
export const SPSR_EL1 = sysId('SPSR_EL1')
export const ESR_EL1 = sysId('ESR_EL1')
export const FAR_EL1 = sysId('FAR_EL1')
export const VBAR_EL1 = sysId('VBAR_EL1')
export const NZCV_SYS = sysId('NZCV')
export const FPCR_ID = sysId('FPCR')
export const FPSR_ID = sysId('FPSR')
export const ZCR_EL1 = sysId('ZCR_EL1')

export const REGISTER_COUNT = nextId

const GPR_NOTES: Record<number, Text> = {
  0: T('第 1 个参数和返回值；系统调用的第 1 个参数和结果', 'First argument and return value; first argument and result of system calls'),
  8: T('系统调用号（svc #0）；间接返回结果的地址', 'System call number (svc #0); address of an indirect result'),
  16: T('IP0：链接器用的临时寄存器', 'IP0: scratch register for the linker'),
  17: T('IP1：链接器用的临时寄存器', 'IP1: scratch register for the linker'),
  18: T('平台寄存器（有的系统保留）', 'Platform register (reserved on some systems)'),
  29: T('帧指针 fp', 'Frame pointer fp'),
  30: T('链接寄存器 lr：bl 把返回地址放在这里', 'Link register lr: bl puts the return address here'),
}

function gprNote(n: number): Text {
  if (GPR_NOTES[n]) return GPR_NOTES[n]!
  if (n < 8) return T(`第 ${n + 1} 个参数`, `Argument ${n + 1}`)
  if (n < 16) return T('临时寄存器（调用者保存）', 'Temporary (caller-saved)')
  return T('被调用者保存的寄存器', 'Callee-saved register')
}

function vNote(n: number): Text {
  if (n === 0) return T('第 1 个浮点或向量参数和返回值；它的低位是 b0 h0 s0 d0 q0', 'First FP or vector argument and return value; its low parts are b0 h0 s0 d0 q0')
  if (n < 8) return T(`第 ${n + 1} 个浮点或向量参数`, `FP or vector argument ${n + 1}`)
  if (n < 16) return T('被调用者保存（只有低 64 位 d 寄存器）', 'Callee-saved (only the low 64 bits, the d register)')
  return T('临时寄存器（调用者保存）', 'Temporary (caller-saved)')
}

function zNote(n: number): Text {
  const low = T(`低 128 位就是 v${n}`, `its low 128 bits are v${n}`)
  if (n < 8) return T(`SVE 向量寄存器，长度 VL；第 ${n + 1} 个向量参数；${low.zh}`, `SVE vector register of VL bits; vector argument ${n + 1}; ${low.en}`)
  return T(`SVE 向量寄存器，长度 VL；${low.zh}`, `SVE vector register of VL bits; ${low.en}`)
}

function pNote(n: number): Text {
  const gov = n < 8 ? T('可以作执行谓词 Pg', 'can govern instructions as Pg') : T('只能作结果或源操作数（Pg 只能是 p0–p7）', 'only a result or source (Pg must be p0–p7)')
  return T(`谓词寄存器：向量的每个字节一位，元素看它第一个字节的那一位；${gov.zh}`, `Predicate register: one bit per vector byte, each element uses the bit of its first byte; ${gov.en}`)
}

const gprs: RegisterSpec[] = Array.from({ length: 31 }, (_, n) => ({ id: n, name: `x${n}`, number: n, bits: 64, kind: 'int' as const, note: gprNote(n) }))

export const REGISTER_BANKS: RegisterBank[] = [
  {
    id: 'gpr',
    title: T('通用寄存器', 'General registers'),
    registers: [
      ...gprs,
      { id: SP, name: 'sp', bits: 64, kind: 'int', note: T('栈指针（当前异常级别的），访问时须按 16 字节对齐', 'Stack pointer (of the current exception level); must be 16-byte aligned when used') },
      { id: PC, name: 'pc', bits: 64, kind: 'special', untracked: true, note: T('下一条要执行的指令地址', 'Address of the next instruction') },
    ],
  },
  {
    id: 'flags',
    title: T('条件标志 NZCV', 'Condition flags NZCV'),
    registers: [
      { id: FLAG_N, name: 'N', bits: 1, kind: 'flag', note: T('负：结果的最高位', 'Negative: the top bit of the result') },
      { id: FLAG_Z, name: 'Z', bits: 1, kind: 'flag', note: T('零：结果为 0', 'Zero: the result is 0') },
      { id: FLAG_C, name: 'C', bits: 1, kind: 'flag', note: T('进位：无符号加法溢出，或减法没有借位', 'Carry: unsigned overflow on add, or no borrow on subtract') },
      { id: FLAG_V, name: 'V', bits: 1, kind: 'flag', note: T('溢出：有符号结果超出范围', 'Overflow: the signed result is out of range') },
    ],
  },
  {
    id: 'simd',
    title: T('浮点和向量寄存器', 'FP and vector registers'),
    registers: [
      ...Array.from({ length: 32 }, (_, n): RegisterSpec => ({ id: V0 + n, name: `v${n}`, number: n, bits: 128, kind: 'vector', partOf: Z0 + n, note: vNote(n) })),
      { id: FPCR_ID, name: 'FPCR', bits: 32, kind: 'special', note: SYSREG_BY_ID.get(FPCR_ID)!.note },
      { id: FPSR_ID, name: 'FPSR', bits: 32, kind: 'special', note: SYSREG_BY_ID.get(FPSR_ID)!.note },
    ],
  },
  {
    id: 'sve',
    title: T('SVE 寄存器', 'SVE registers'),
    registers: [
      ...Array.from({ length: 32 }, (_, n): RegisterSpec => ({ id: Z0 + n, name: `z${n}`, number: n, bits: 2048, kind: 'vector', note: zNote(n) })),
      ...Array.from({ length: 16 }, (_, n): RegisterSpec => ({ id: P0 + n, name: `p${n}`, number: n, bits: 256, kind: 'predicate', note: pNote(n) })),
      { id: FFR, name: 'ffr', bits: 256, kind: 'predicate', note: T('首次故障寄存器：首次故障和不故障加载把读不到的元素及其后的位清零', 'First-fault register: first-fault and non-fault loads clear the bits of the elements they could not read, and those after them') },
      { id: ZCR_EL1, name: 'ZCR_EL1', bits: 64, kind: 'special', note: SYSREG_BY_ID.get(ZCR_EL1)!.note },
    ],
  },
  {
    id: 'sys',
    title: T('系统寄存器', 'System registers'),
    registers: SYSREGS.filter((r) => r.shown && r.id !== ZCR_EL1).map((r) => ({ id: r.id, name: r.name, bits: 64, kind: 'special' as const, note: r.note })),
  },
]

/** x0, w0, sp, wsp, xzr, wzr: the name of general register `n` at a width, with 31 meaning sp or the zero register. */
export function gprName(n: number, x: boolean, spAt31: boolean): string {
  if (n === 31) return spAt31 ? (x ? 'sp' : 'wsp') : x ? 'xzr' : 'wzr'
  return (x ? 'x' : 'w') + n
}

export interface GprRef {
  n: number
  x: boolean
  sp: boolean
  zr: boolean
}

/** Read a general register name: x0–x30, w0–w30, sp, wsp, xzr, wzr, and fp, lr, ip0, ip1. */
export function parseGpr(name: string): GprRef | null {
  const s = name.toLowerCase()
  const m = /^([xw])(\d{1,2})$/.exec(s)
  if (m) {
    const n = Number(m[2])
    if (n > 30 || (m[2]!.length > 1 && m[2]![0] === '0')) return null
    return { n, x: m[1] === 'x', sp: false, zr: false }
  }
  switch (s) {
    case 'sp':
      return { n: 31, x: true, sp: true, zr: false }
    case 'wsp':
      return { n: 31, x: false, sp: true, zr: false }
    case 'xzr':
      return { n: 31, x: true, sp: false, zr: true }
    case 'wzr':
      return { n: 31, x: false, sp: false, zr: true }
    case 'fp':
      return { n: 29, x: true, sp: false, zr: false }
    case 'lr':
      return { n: 30, x: true, sp: false, zr: false }
    case 'ip0':
      return { n: 16, x: true, sp: false, zr: false }
    case 'ip1':
      return { n: 17, x: true, sp: false, zr: false }
  }
  return null
}

/** Every general register name, for highlighting and completion. */
export const GPR_WORDS = [
  ...Array.from({ length: 31 }, (_, i) => `x${i}`),
  ...Array.from({ length: 31 }, (_, i) => `w${i}`),
  'sp',
  'wsp',
  'xzr',
  'wzr',
  'fp',
  'lr',
  'ip0',
  'ip1',
]

/** A SIMD&FP register as written: b/h/s/d/q n (scalar), v n with an arrangement (.4s) or an element size (.s). */
export interface VregRef {
  n: number
  /** 'b' 'h' 's' 'd' 'q' for scalar names, 'v' for vector names. */
  kind: string
  /** Vector arrangement, e.g. '4s', '16b', or just an element size like 's' (before an index); '' for bare v0. */
  arr: string
}

/** Read a SIMD&FP register name: b0–b31, h, s, d, q, and v0–v31 with an optional .arrangement. */
export function parseVreg(name: string): VregRef | null {
  const m = /^([bhsdqv])(\d{1,2})(?:\.(\d*[bhsdq]))?$/.exec(name.toLowerCase())
  if (!m) return null
  const n = Number(m[2])
  if (n > 31 || (m[2]!.length > 1 && m[2]![0] === '0')) return null
  if (m[1] !== 'v' && m[3] !== undefined) return null
  return { n, kind: m[1]!, arr: m[3] ?? '' }
}

/** Every SIMD&FP register name, for highlighting and completion. */
export const VREG_WORDS = ['v', 'q', 'd', 's', 'h', 'b'].flatMap((k) => Array.from({ length: 32 }, (_, i) => `${k}${i}`))

/** An SVE register as written: z0–z31, p0–p15, pn0–pn15 (predicate-as-counter), with an optional .b/.h/.s/.d/.q. */
export interface SveRegRef {
  kind: 'z' | 'p' | 'pn'
  n: number
  /** Element size 0–4 (b h s d q), or null without a suffix. */
  es: number | null
}

export function parseSveReg(name: string): SveRegRef | null {
  const m = /^(z|pn|p)(\d{1,2})(?:\.([bhsdq]))?$/.exec(name.toLowerCase())
  if (!m) return null
  const n = Number(m[2])
  if (n > (m[1] === 'z' ? 31 : 15) || (m[2]!.length > 1 && m[2]![0] === '0')) return null
  return { kind: m[1] as SveRegRef['kind'], n, es: m[3] ? 'bhsdq'.indexOf(m[3]) : null }
}

/** Every SVE register name, for highlighting and completion. */
export const SVE_WORDS = [
  ...Array.from({ length: 32 }, (_, i) => `z${i}`),
  ...Array.from({ length: 16 }, (_, i) => `p${i}`),
  ...Array.from({ length: 16 }, (_, i) => `pn${i}`),
  'ffr',
]
