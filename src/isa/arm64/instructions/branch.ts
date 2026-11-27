/**
 * Branches, exception-generating and system instructions: B, BL, B.cond, BC.cond, CBZ/CBNZ, TBZ/TBNZ,
 * BR/BLR/RET and their pointer-authenticating forms, SVC/HVC/SMC/BRK/HLT, ERET, the hints (NOP, WFI, BTI,
 * PAC*), barriers, CLREX, MSR (immediate) with CFINV/XAFLAG/AXFLAG, SYS/SYSL with DC/IC/AT/TLBI, MRS and MSR.
 *
 * Pointer authentication runs with its keys disabled, as the architecture allows: signing leaves a pointer
 * as it is and authenticating always succeeds, so the PAC hints are NOPs and RETAA is RET.
 */
import { T, type Text } from '../../../core/i18n'
import { sysOpOf } from '../encoding/operands'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Fields } from './types'
import { sext } from './util'

const sysEncOf = (f: Fields) => (f.op0! << 14) | (f.op1! << 11) | (f.CRn! << 7) | (f.CRm! << 3) | f.op2!

const nothing = () => {}

const exc = (m: string, opc: string, ll: string, desc: Text, exec: InstrSpec['exec']): InstrSpec => ({
  id: m,
  mnemonic: m,
  group: 'system',
  bits: `11010100 ${opc} imm16:16 000 ${ll}`,
  syntax: '#<u:imm16>',
  example: m === 'svc' ? 'svc #0' : undefined,
  desc,
  exec,
})

/** Register branches: opc, op3 and op4 pick the kind; PAuth forms authenticate with a modifier. */
const brReg = (id: string, m: string, opc: string, op3: string, rn: string, op4: string, syntax: string, desc: Text, exec: InstrSpec['exec']): InstrSpec => ({
  id,
  mnemonic: m,
  group: 'branch',
  feature: op3 === '000000' ? undefined : 'pauth',
  bits: `1101011 ${opc} 11111 ${op3} ${rn} ${op4}`,
  syntax,
  desc,
  exec,
})

const br = (c: Parameters<InstrSpec['exec']>[0], f: Fields) => c.branchTo(c.x(f.Rn!))
const blr = (c: Parameters<InstrSpec['exec']>[0], f: Fields) => {
  const target = c.x(f.Rn!)
  c.setX(30, c.pcVa + 4n)
  c.branchTo(target)
}

export const INSTRS: InstrSpec[] = [
  {
    id: 'b',
    mnemonic: 'b',
    group: 'branch',
    bits: '0 00101 imm26:26',
    syntax: '<label:imm26>',
    desc: T('无条件跳转到标签（±128 MB 以内）', 'Branch to a label (within ±128 MB)'),
    exec: (c, f) => c.branchRel(sext(f.imm26!, 26) * 4),
  },
  {
    id: 'bl',
    mnemonic: 'bl',
    group: 'branch',
    bits: '1 00101 imm26:26',
    syntax: '<label:imm26>',
    desc: T('调用函数：返回地址（下一条指令）放进 x30（lr），再跳转', 'Call: put the return address (the next instruction) in x30 (lr) and branch'),
    exec: (c, f) => {
      c.setX(30, c.pcVa + 4n)
      c.branchRel(sext(f.imm26!, 26) * 4)
    },
  },
  {
    id: 'b-cond',
    mnemonic: 'b.<cond>',
    group: 'branch',
    bits: '0101010 0 imm19:19 0 cond:4',
    syntax: '<label:imm19>',
    desc: T('条件成立时跳转（例如 b.eq、b.ne、b.lt、b.ge），条件看 NZCV 标志', 'Branch if the condition holds (e.g. b.eq, b.ne, b.lt, b.ge), based on the NZCV flags'),
    exec: (c, f) => {
      if (c.cond(f.cond!)) c.branchRel(sext(f.imm19!, 19) * 4)
    },
  },
  {
    id: 'bc-cond',
    mnemonic: 'bc.<cond>',
    group: 'branch',
    feature: 'hbc',
    bits: '0101010 0 imm19:19 1 cond:4',
    syntax: '<label:imm19>',
    desc: T('条件跳转，并提示处理器这个分支的走向会变化（行为和 b.cond 一样）', 'Conditional branch hinted as not behaving consistently (otherwise like b.cond)'),
    exec: (c, f) => {
      if (c.cond(f.cond!)) c.branchRel(sext(f.imm19!, 19) * 4)
    },
  },
  ...(['cbz', 'cbnz'] as const).map(
    (m, op): InstrSpec => ({
      id: m,
      mnemonic: m,
      group: 'branch',
      bits: `sf 011010 ${op} imm19:19 Rt:5`,
      syntax: '<Rt>, <label:imm19>',
      desc: op ? T('寄存器不为 0 时跳转', 'Branch if the register is not zero') : T('寄存器为 0 时跳转', 'Branch if the register is zero'),
      exec: (c, f) => {
        if ((c.r(f.sf!, f.Rt!) === 0n) !== (op === 1)) c.branchRel(sext(f.imm19!, 19) * 4)
      },
    }),
  ),
  ...(['tbz', 'tbnz'] as const).map(
    (m, op): InstrSpec => ({
      id: m,
      mnemonic: m,
      group: 'branch',
      bits: `b5 011011 ${op} b40:5 imm14:14 Rt:5`,
      syntax: '<tbzreg>, #<bitpos>, <label:imm14>',
      desc: op ? T('寄存器的某一位是 1 时跳转（±32 KB 以内）', 'Branch if a bit of the register is 1 (within ±32 KB)') : T('寄存器的某一位是 0 时跳转（±32 KB 以内）', 'Branch if a bit of the register is 0 (within ±32 KB)'),
      exec: (c, f) => {
        const bit = (c.x(f.Rt!) >> BigInt((f.b5! << 5) | f.b40!)) & 1n
        if ((bit === 0n) !== (op === 1)) c.branchRel(sext(f.imm14!, 14) * 4)
      },
    }),
  ),
  brReg('br', 'br', '0000', '000000', 'Rn:5', '00000', '<Xn>', T('跳转到寄存器里的地址', 'Branch to the address in a register'), br),
  brReg('blr', 'blr', '0001', '000000', 'Rn:5', '00000', '<Xn>', T('调用寄存器里的地址：返回地址放进 x30', 'Call the address in a register: the return address goes in x30'), blr),
  brReg('ret', 'ret', '0010', '000000', 'Rn:5', '00000', '{<Xn=30>}', T('从函数返回：跳到 x30（或给出的寄存器）里的地址', 'Return from a function: branch to the address in x30 (or the given register)'), br),
  brReg('eret', 'eret', '0100', '000000', '11111', '00000', '', T('异常返回：PC = ELR_EL1，处理器状态 = SPSR_EL1', 'Exception return: PC = ELR_EL1, processor state = SPSR_EL1'), (c) => c.eret()),
  brReg('braaz', 'braaz', '0000', '000010', 'Rn:5', '11111', '<Xn>', T('认证（用 A 密钥、修饰值 0）后跳转', 'Branch after authenticating with key A and a zero modifier'), br),
  brReg('brabz', 'brabz', '0000', '000011', 'Rn:5', '11111', '<Xn>', T('认证（用 B 密钥、修饰值 0）后跳转', 'Branch after authenticating with key B and a zero modifier'), br),
  brReg('blraaz', 'blraaz', '0001', '000010', 'Rn:5', '11111', '<Xn>', T('认证（A 密钥、修饰值 0）后调用', 'Call after authenticating with key A and a zero modifier'), blr),
  brReg('blrabz', 'blrabz', '0001', '000011', 'Rn:5', '11111', '<Xn>', T('认证（B 密钥、修饰值 0）后调用', 'Call after authenticating with key B and a zero modifier'), blr),
  brReg('retaa', 'retaa', '0010', '000010', '11111', '11111', '', T('认证 x30（A 密钥、以 sp 为修饰值）后返回', 'Return after authenticating x30 with key A and sp as the modifier'), (c) => c.branchTo(c.x(30))),
  brReg('retab', 'retab', '0010', '000011', '11111', '11111', '', T('认证 x30（B 密钥、以 sp 为修饰值）后返回', 'Return after authenticating x30 with key B and sp as the modifier'), (c) => c.branchTo(c.x(30))),
  brReg('eretaa', 'eretaa', '0100', '000010', '11111', '11111', '', T('认证 ELR（A 密钥）后异常返回', 'Exception return after authenticating ELR with key A'), (c) => c.eret()),
  brReg('eretab', 'eretab', '0100', '000011', '11111', '11111', '', T('认证 ELR（B 密钥）后异常返回', 'Exception return after authenticating ELR with key B'), (c) => c.eret()),
  brReg('braa', 'braa', '1000', '000010', 'Rn:5', 'Rm:5', '<Xn>, <Xm|SP>', T('认证（A 密钥、以 Xm 为修饰值）后跳转', 'Branch after authenticating with key A and Xm as the modifier'), br),
  brReg('brab', 'brab', '1000', '000011', 'Rn:5', 'Rm:5', '<Xn>, <Xm|SP>', T('认证（B 密钥、以 Xm 为修饰值）后跳转', 'Branch after authenticating with key B and Xm as the modifier'), br),
  brReg('blraa', 'blraa', '1001', '000010', 'Rn:5', 'Rm:5', '<Xn>, <Xm|SP>', T('认证（A 密钥、以 Xm 为修饰值）后调用', 'Call after authenticating with key A and Xm as the modifier'), blr),
  brReg('blrab', 'blrab', '1001', '000011', 'Rn:5', 'Rm:5', '<Xn>, <Xm|SP>', T('认证（B 密钥、以 Xm 为修饰值）后调用', 'Call after authenticating with key B and Xm as the modifier'), blr),
  exc('svc', '000', '01', T('系统调用：x8 是 Linux 系统调用号，x0–x5 是参数，结果放回 x0', 'Supervisor call: x8 holds the Linux system call number, x0–x5 the arguments; the result goes in x0'), (c, f) => c.svc(f.imm16!)),
  exc('hvc', '000', '10', T('调用虚拟机监控程序（EL2）：这里没有 EL2，所以是未定义指令', 'Hypervisor call (EL2): there is no EL2 here, so it is undefined'), (c) => c.undefinedInstr()),
  exc('smc', '000', '11', T('调用安全监控程序（EL3）：这里没有 EL3，所以是未定义指令', 'Secure monitor call (EL3): there is no EL3 here, so it is undefined'), (c) => c.undefinedInstr()),
  exc('brk', '001', '00', T('断点异常：没有异常向量表时程序停下（SIGTRAP）', 'Breakpoint exception: without a vector table the program stops (SIGTRAP)'), (c, f) => c.brk(f.imm16!)),
  exc('hlt', '010', '00', T('停机调试：没有外部调试器时是未定义指令', 'Halt for an external debugger: undefined without one'), (c) => c.undefinedInstr()),
  {
    id: 'udf',
    mnemonic: 'udf',
    group: 'system',
    bits: '0000000000000000 imm16:16',
    syntax: '#<u:imm16>',
    desc: T('永久未定义的指令：执行时引发未定义指令异常（SIGILL），imm16 只是给人看的编号', 'Permanently undefined: raises an undefined-instruction exception (SIGILL); imm16 is only a label for people'),
    exec: (c) => c.undefinedInstr(),
  },
  {
    id: 'hint',
    mnemonic: 'hint',
    group: 'system',
    bits: '11010101000000110010 imm:7 11111',
    syntax: '#<u:imm>',
    desc: T('提示指令：没有特定含义的编号什么也不做', 'Hint: numbers without a defined meaning do nothing'),
    exec: nothing,
  },
  // FEAT_WFxT (mandatory from Armv8.7): wait with a timeout; like WFE and WFI they may return at once.
  {
    id: 'wfet',
    mnemonic: 'wfet',
    group: 'system',
    bits: '11010101000000110001000000 0 Rt:5',
    syntax: '<Xt>',
    desc: T('等待事件，最多等到计数器 CNTVCT 达到 Xt（这里不等待，直接继续）', 'Wait for event, at most until the counter CNTVCT reaches Xt (continues at once here)'),
    exec: nothing,
  },
  {
    id: 'wfit',
    mnemonic: 'wfit',
    group: 'system',
    bits: '11010101000000110001000000 1 Rt:5',
    syntax: '<Xt>',
    desc: T('等待中断，最多等到计数器 CNTVCT 达到 Xt（这里不等待，直接继续）', 'Wait for interrupt, at most until the counter CNTVCT reaches Xt (continues at once here)'),
    exec: nothing,
  },
  {
    id: 'clrex',
    mnemonic: 'clrex',
    group: 'atomic',
    bits: '11010101000000110011 CRm:4 010 11111',
    syntax: '{#<u:CRm=15>}',
    desc: T('清除独占监视器：之后的 stxr 一定失败', 'Clear the exclusive monitor: a later stxr fails'),
    exec: (c) => c.clearExclusive(),
  },
  {
    id: 'dsb',
    mnemonic: 'dsb',
    group: 'system',
    bits: '11010101000000110011 CRm:4 100 11111',
    syntax: '<barrier>',
    desc: T('数据同步屏障：等之前的内存访问全部完成（这里按顺序执行，所以没有效果）', 'Data synchronization barrier: wait for earlier memory accesses (in-order here, so no effect)'),
    exec: nothing,
  },
  {
    id: 'dsb-nxs',
    mnemonic: 'dsb',
    group: 'system',
    feature: 'xs',
    bits: '11010101000000110011 imm2:2 10 001 11111',
    syntax: '<nxs>',
    desc: T('带 nXS 属性的数据同步屏障', 'Data synchronization barrier with the nXS qualifier'),
    exec: nothing,
  },
  {
    id: 'dmb',
    mnemonic: 'dmb',
    group: 'system',
    bits: '11010101000000110011 CRm:4 101 11111',
    syntax: '<barrier>',
    desc: T('数据内存屏障：屏障前后的内存访问不能交换顺序', 'Data memory barrier: memory accesses are not reordered across it'),
    exec: nothing,
  },
  {
    id: 'isb',
    mnemonic: 'isb',
    group: 'system',
    bits: '11010101000000110011 CRm:4 110 11111',
    syntax: '{<isbopt>}',
    desc: T('指令同步屏障：之后的指令重新取指', 'Instruction synchronization barrier: later instructions are fetched again'),
    exec: nothing,
  },
  {
    id: 'sb',
    mnemonic: 'sb',
    group: 'system',
    feature: 'sb',
    bits: '11010101000000110011 0000 111 11111',
    syntax: '',
    desc: T('推测屏障：之后的指令不会被推测执行', 'Speculation barrier'),
    exec: nothing,
  },
  {
    id: 'msr-imm',
    mnemonic: 'msr',
    group: 'system',
    bits: '1101010100000 op1:3 0100 CRm:4 op2:3 11111',
    syntax: '<pstate>, #<u:CRm>',
    valid: pstateKnown,
    desc: T('设置处理器状态字段，例如 msr daifset, #2 屏蔽中断', 'Set a processor state field, e.g. msr daifset, #2 masks interrupts'),
    exec: (c, f) => c.pstate(f.op1!, f.op2!, f.CRm!),
  },
  {
    // CRm is (0) in CFINV, XAFLAG and AXFLAG: ignored when decoding, as LLVM and the CPU we check against do.
    id: 'cfinv',
    mnemonic: 'cfinv',
    group: 'cond',
    feature: 'flagm',
    bits: '11010101000000000100 CRm:4 000 11111',
    syntax: '',
    desc: T('把进位标志 C 取反', 'Invert the carry flag C'),
    exec: (c) => c.setFlags(c.flags() ^ 2),
  },
  {
    id: 'xaflag',
    mnemonic: 'xaflag',
    group: 'cond',
    feature: 'flagm2',
    bits: '11010101000000000100 CRm:4 001 11111',
    syntax: '',
    desc: T('把浮点比较的标志从“外部格式”转成 Arm 格式', 'Convert floating-point comparison flags from the external format to Arm\'s'),
    exec: (c) => {
      const f = c.flags()
      const z = (f >> 2) & 1
      const cy = (f >> 1) & 1
      c.setFlags(((~cy & ~z & 1) << 3) | ((z & cy) << 2) | ((cy | z) << 1) | (~cy & z & 1))
    },
  },
  {
    id: 'axflag',
    mnemonic: 'axflag',
    group: 'cond',
    feature: 'flagm2',
    bits: '11010101000000000100 CRm:4 010 11111',
    syntax: '',
    desc: T('把浮点比较的标志从 Arm 格式转成“外部格式”', 'Convert floating-point comparison flags from Arm\'s format to the external one'),
    exec: (c) => {
      const f = c.flags()
      const z = (f >> 2) & 1
      const cy = (f >> 1) & 1
      const v = f & 1
      c.setFlags(((z | v) << 2) | ((cy & ~v & 1) << 1))
    },
  },
  {
    id: 'sys',
    mnemonic: 'sys',
    group: 'system',
    bits: '1101010100 0 01 op1:3 CRn:4 CRm:4 op2:3 Rt:5',
    syntax: '#<u:op1>, <cr:CRn>, <cr:CRm>, #<u:op2>{, <Xt=31>}',
    desc: T('系统操作（缓存、地址翻译、TLB 维护等）', 'System operation (cache, address translation, TLB maintenance, …)'),
    exec: (c, f) => c.sysOp(f.op1!, f.CRn!, f.CRm!, f.op2!, f.Rt!),
  },
  {
    id: 'sysl',
    mnemonic: 'sysl',
    group: 'system',
    bits: '1101010100 1 01 op1:3 CRn:4 CRm:4 op2:3 Rt:5',
    syntax: '<Xt>, #<u:op1>, <cr:CRn>, <cr:CRm>, #<u:op2>',
    desc: T('带结果的系统操作（这里没有定义任何一种，执行时是未定义指令）', 'System operation with a result (none is defined here; it is undefined when run)'),
    exec: (c) => c.undefinedInstr(),
  },
  {
    id: 'msr',
    mnemonic: 'msr',
    group: 'system',
    bits: '1101010100 0 op0:2 op1:3 CRn:4 CRm:4 op2:3 Rt:5',
    syntax: '<sysreg>, <Xt>',
    desc: T('把寄存器写入系统寄存器', 'Write a register to a system register'),
    exec: (c, f) => c.sysWrite(sysEncOf(f), c.x(f.Rt!)),
  },
  {
    id: 'mrs',
    mnemonic: 'mrs',
    group: 'system',
    bits: '1101010100 1 op0:2 op1:3 CRn:4 CRm:4 op2:3 Rt:5',
    syntax: '<Xt>, <sysreg>',
    desc: T('读系统寄存器到通用寄存器', 'Read a system register into a general register'),
    exec: (c, f) => c.setX(f.Rt!, c.sysRead(sysEncOf(f))),
  },
]

function pstateKnown(f: Fields): boolean {
  const known = [
    [0, 5],
    [3, 6],
    [3, 7],
    [0, 3],
    [0, 4],
    [3, 2],
    [3, 1],
  ]
  return known.some(([op1, op2]) => op1 === f.op1 && op2 === f.op2)
}

/* ------------------------------------------------------------------ aliases */

const HINTS: [string, number, Text][] = [
  ['nop', 0, T('空操作：什么也不做', 'No operation')],
  ['yield', 1, T('提示：可以先让别的线程运行（这里什么也不做）', 'Hint that other threads may run (no effect here)')],
  ['wfe', 2, T('等待事件（这里不等待，直接继续）', 'Wait for event (continues at once here)')],
  ['wfi', 3, T('等待中断（这里不等待，直接继续）', 'Wait for interrupt (continues at once here)')],
  ['sev', 4, T('发送事件（这里没有效果）', 'Send event (no effect here)')],
  ['sevl', 5, T('向本核发送事件（这里没有效果）', 'Send event locally (no effect here)')],
  ['dgh', 6, T('提示：不要合并之后的内存访问（这里没有效果）', 'Data gathering hint (no effect here)')],
  ['xpaclri', 7, T('去掉 x30 里的指针认证码（密钥未开启时本来就没有）', 'Strip the pointer authentication code from x30 (there is none with keys disabled)')],
  ['pacia1716', 8, T('用 A 密钥给 x17 签名，x16 是修饰值（密钥未开启：不变）', 'Sign x17 with key A and modifier x16 (keys disabled: unchanged)')],
  ['pacib1716', 10, T('用 B 密钥给 x17 签名（密钥未开启：不变）', 'Sign x17 with key B (keys disabled: unchanged)')],
  ['autia1716', 12, T('用 A 密钥认证 x17（密钥未开启：总是成功）', 'Authenticate x17 with key A (keys disabled: always succeeds)')],
  ['autib1716', 14, T('用 B 密钥认证 x17（密钥未开启：总是成功）', 'Authenticate x17 with key B (keys disabled: always succeeds)')],
  ['esb', 16, T('错误同步屏障（这里没有效果）', 'Error synchronization barrier (no effect here)')],
  ['csdb', 20, T('条件推测屏障（这里没有效果）', 'Consumption of speculative data barrier (no effect here)')],
  ['clrbhb', 22, T('清除分支历史（这里没有效果）', 'Clear branch history (no effect here)')],
  ['paciaz', 24, T('用 A 密钥给 x30 签名，修饰值 0（密钥未开启：不变）', 'Sign x30 with key A and a zero modifier (keys disabled: unchanged)')],
  ['paciasp', 25, T('用 A 密钥给 x30 签名，修饰值 sp；函数开头常用（密钥未开启：不变）', 'Sign x30 with key A and sp; common at function entry (keys disabled: unchanged)')],
  ['pacibz', 26, T('用 B 密钥给 x30 签名，修饰值 0（密钥未开启：不变）', 'Sign x30 with key B and a zero modifier (keys disabled: unchanged)')],
  ['pacibsp', 27, T('用 B 密钥给 x30 签名，修饰值 sp（密钥未开启：不变）', 'Sign x30 with key B and sp (keys disabled: unchanged)')],
  ['autiaz', 28, T('用 A 密钥认证 x30，修饰值 0（密钥未开启：总是成功）', 'Authenticate x30 with key A and a zero modifier (keys disabled: always succeeds)')],
  ['autiasp', 29, T('用 A 密钥认证 x30，修饰值 sp；函数返回前常用（密钥未开启：总是成功）', 'Authenticate x30 with key A and sp; common before returning (keys disabled: always succeeds)')],
  ['autibz', 30, T('用 B 密钥认证 x30，修饰值 0（密钥未开启：总是成功）', 'Authenticate x30 with key B and a zero modifier (keys disabled: always succeeds)')],
  ['autibsp', 31, T('用 B 密钥认证 x30，修饰值 sp（密钥未开启：总是成功）', 'Authenticate x30 with key B and sp (keys disabled: always succeeds)')],
]

const BTI: [string, number][] = [
  ['', 32],
  [' c', 34],
  [' j', 36],
  [' jc', 38],
]

const SYS_DESC: Record<string, Text> = {
  dc: T('数据缓存维护（dc zva 把一块内存清零，其余这里没有效果）', 'Data cache maintenance (dc zva zeroes a block; the others have no effect here)'),
  ic: T('指令缓存维护（这里没有效果）', 'Instruction cache maintenance (no effect here)'),
  at: T('地址翻译（这里没有页表，结果总是平坦映射）', 'Address translation (no page tables here)'),
  tlbi: T('TLB 失效（这里没有 TLB，没有效果）', 'TLB invalidate (no TLB here, no effect)'),
}

export const ALIASES: AliasSpec[] = [
  ...HINTS.map(([m, imm, desc]): AliasSpec => ({ id: m, of: 'hint', mnemonic: m, syntax: '', fixed: { imm }, desc })),
  ...BTI.map(
    ([target, imm]): AliasSpec => ({
      id: `bti${target.trim()}`,
      of: 'hint',
      mnemonic: 'bti',
      syntax: target.trim(),
      fixed: { imm },
      desc: T('分支目标标记：间接跳转可以落在这里（这里不检查，相当于 NOP）', 'Branch target identification: indirect branches may land here (not checked here, so a NOP)'),
    }),
  ),
  // Newer assemblers also accept (and LLVM prints) BTI without targets as "bti r"; we print plain "bti".
  {
    id: 'btir',
    of: 'hint',
    mnemonic: 'bti',
    syntax: 'r',
    fixed: { imm: 32 },
    prefer: false,
    desc: T('分支目标标记，不限定目标（同 bti）', 'Branch target identification without targets (the same as bti)'),
  },
  { id: 'psb', of: 'hint', mnemonic: 'psb', syntax: 'csync', fixed: { imm: 17 }, desc: T('性能采样同步屏障（这里没有效果）', 'Profiling synchronization barrier (no effect here)') },
  { id: 'ssbb', of: 'dsb', mnemonic: 'ssbb', syntax: '', fixed: { CRm: 0 }, desc: T('推测性存储旁路屏障', 'Speculative store bypass barrier') },
  { id: 'pssbb', of: 'dsb', mnemonic: 'pssbb', syntax: '', fixed: { CRm: 4 }, desc: T('按物理地址的推测性存储旁路屏障', 'Physical speculative store bypass barrier') },
  ...(['dc', 'ic', 'at', 'tlbi'] as const).flatMap((kind): AliasSpec[] => [
    {
      id: `${kind}`,
      of: 'sys',
      mnemonic: kind,
      syntax: `<sysop:${kind}>, <Xt>`,
      prefer: (f) => sysOpOf(kind, f)?.reg === true,
      desc: SYS_DESC[kind],
    },
    {
      id: `${kind}-noreg`,
      of: 'sys',
      mnemonic: kind,
      syntax: `<sysop:${kind}->`,
      // Assembled with Rt = 31; LLVM names the operation whatever Rt holds, and so do we.
      encode: (f) => {
        f.Rt = 31
      },
      prefer: (f) => sysOpOf(kind, f)?.reg === false,
      desc: SYS_DESC[kind],
    },
  ]).filter((a) => a.id !== 'dc-noreg' && a.id !== 'at-noreg'),
  ...([
    ['cfp', 4],
    ['dvp', 5],
    ['cosp', 6],
    ['cpp', 7],
  ] as const).map(
    ([m, op2]): AliasSpec => ({
      id: m,
      of: 'sys',
      mnemonic: m,
      syntax: 'rctx, <Xt>',
      fixed: { op1: 3, CRn: 7, CRm: 3, op2 },
      desc: T('按执行上下文限制预测（这里没有预测器，没有效果）', 'Restrict prediction by execution context (no predictors here, so no effect)'),
    }),
  ),
]

