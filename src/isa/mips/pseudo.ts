/**
 * Pseudo-instructions: every form MARS 4.5 accepts, in the order MARS tries them.
 *
 * A form is written as its example ("lw $t1,label+100000($t2)"). The example decides which operands
 * match: the same tokenizer classifies it, so "-100" means a signed 16-bit value, "100" an unsigned
 * 16-bit value, "100000" any 32-bit value, "10" a 5-bit value and "label" a symbol.
 *
 * expand() receives the operand values in source order, separated into registers (r) and numbers (v;
 * labels arrive as their addresses), and returns basic instructions. A basic instruction is
 * [mnemonic, ...operands] in that instruction's own operand order; a "mem" operand takes two slots
 * (offset, base) and a branch target is an absolute address or { rel: n } (n words after the next PC).
 */

import { cat, T, type Text } from '../../core/i18n'

export interface Rel {
  rel: number
}
export type Emit = [string, ...(number | Rel)[]]

export interface PseudoArgs {
  r: number[]
  v: number[]
}

export interface PseudoForm {
  name: string
  example: string
  /** One-liner for the calculator, in both languages. */
  desc: Text
  expand: (a: PseudoArgs) => Emit[]
}

const AT = 1
const ZERO = 0
/** Low 16 bits. */
const lo = (v: number) => v & 0xffff
/** High 16 bits, exact: pairs with ori, which zero-extends. */
const hiX = (v: number) => (v >>> 16) & 0xffff
/** High 16 bits adjusted for a sign-extended low half: pairs with a load/store offset. */
const hiA = (v: number) => (((v | 0) + 0x8000) >>> 16) & 0xffff

/** $at <- v, exactly (lui + ori). */
const loadAt = (v: number): Emit[] => [
  ['lui', AT, hiX(v)],
  ['ori', AT, AT, lo(v)],
]

const forms: PseudoForm[] = []
function F(name: string, example: string, desc: Text, expand: (a: PseudoArgs) => Emit[]): void {
  forms.push({ name, example: `${name} ${example}`, desc, expand })
}

/* ---------------------------------------------------------------- arithmetic with immediates */

F('not', '$t1,$t2', T('按位取反：和 $zero 做 nor', 'Bitwise NOT: nor with $zero'), ({ r }) => [['nor', r[0]!, r[1]!, ZERO]])

F('add', '$t1,$t2,-100', T('立即数放得进 16 位：直接用 addi', 'The immediate fits in 16 bits: use addi directly'), ({ r, v }) => [['addi', r[0]!, r[1]!, lo(v[0]!)]])
F('add', '$t1,$t2,100000', T('32 位立即数：先用 lui + ori 装进 $at，再 add', '32-bit immediate: load it into $at with lui + ori, then add'), ({ r, v }) => [...loadAt(v[0]!), ['add', r[0]!, r[1]!, AT]])
F('addu', '$t1,$t2,100000', T('立即数装进 $at，再 addu', 'Load the immediate into $at, then addu'), ({ r, v }) => [...loadAt(v[0]!), ['addu', r[0]!, r[1]!, AT]])
F('addi', '$t1,$t2,100000', T('立即数超出 16 位：装进 $at，再 add', 'Immediate wider than 16 bits: load it into $at, then add'), ({ r, v }) => [...loadAt(v[0]!), ['add', r[0]!, r[1]!, AT]])
F('addiu', '$t1,$t2,100000', T('立即数超出 16 位：装进 $at，再 addu', 'Immediate wider than 16 bits: load it into $at, then addu'), ({ r, v }) => [...loadAt(v[0]!), ['addu', r[0]!, r[1]!, AT]])
F('sub', '$t1,$t2,-100', T('立即数先装进 $at，再 sub', 'Load the immediate into $at first, then sub'), ({ r, v }) => [['addi', AT, ZERO, lo(v[0]!)], ['sub', r[0]!, r[1]!, AT]])
F('sub', '$t1,$t2,100000', T('32 位立即数装进 $at，再 sub', 'Load the 32-bit immediate into $at, then sub'), ({ r, v }) => [...loadAt(v[0]!), ['sub', r[0]!, r[1]!, AT]])
F('subu', '$t1,$t2,100000', T('立即数装进 $at，再 subu', 'Load the immediate into $at, then subu'), ({ r, v }) => [...loadAt(v[0]!), ['subu', r[0]!, r[1]!, AT]])
F('subi', '$t1,$t2,-100', T('减立即数：立即数装进 $at，再 sub', 'Subtract an immediate: load it into $at, then sub'), ({ r, v }) => [['addi', AT, ZERO, lo(v[0]!)], ['sub', r[0]!, r[1]!, AT]])
F('subi', '$t1,$t2,100000', T('减 32 位立即数：装进 $at，再 sub', 'Subtract a 32-bit immediate: load it into $at, then sub'), ({ r, v }) => [...loadAt(v[0]!), ['sub', r[0]!, r[1]!, AT]])
F('subiu', '$t1,$t2,100000', T('减立即数（不查溢出）：装进 $at，再 subu', 'Subtract an immediate (no overflow check): load it into $at, then subu'), ({ r, v }) => [...loadAt(v[0]!), ['subu', r[0]!, r[1]!, AT]])

for (const [imm, reg] of [
  ['andi', 'and'],
  ['ori', 'or'],
  ['xori', 'xor'],
] as const) {
  F(imm, '$t1,$t2,100000', T(`立即数超出 16 位：装进 $at，再 ${reg}`, `Immediate wider than 16 bits: load it into $at, then ${reg}`), ({ r, v }) => [...loadAt(v[0]!), [reg, r[0]!, r[1]!, AT]])
  F(imm, '$t1,100', T(`两操作数写法：$t1 ← $t1 ${opSym(reg)} 立即数`, `Two-operand form: $t1 ← $t1 ${opSym(reg)} immediate`), ({ r, v }) => [[imm, r[0]!, r[0]!, lo(v[0]!)]])
  F(imm, '$t1,100000', T(`两操作数、32 位立即数：装进 $at，再 ${reg}`, `Two-operand form with a 32-bit immediate: load it into $at, then ${reg}`), ({ r, v }) => [...loadAt(v[0]!), [reg, r[0]!, r[0]!, AT]])
}
for (const [reg, imm] of [
  ['and', 'andi'],
  ['or', 'ori'],
  ['xor', 'xori'],
] as const) {
  F(reg, '$t1,$t2,100', T(`第三个操作数是立即数：换成 ${imm}`, `The third operand is an immediate: becomes ${imm}`), ({ r, v }) => [[imm, r[0]!, r[1]!, lo(v[0]!)]])
  F(reg, '$t1,100', T(`两操作数写法：换成 ${imm}，结果写回自己`, `Two-operand form: becomes ${imm}, writing the result back to $t1`), ({ r, v }) => [[imm, r[0]!, r[0]!, lo(v[0]!)]])
}
function opSym(reg: string) {
  return reg === 'and' ? '&' : reg === 'or' ? '|' : '^'
}

/* ---------------------------------------------------------------- set on condition */

type Core = (rd: number, rs: number, rt: number) => Emit[]
const SETS: [string, Text, Core][] = [
  ['seq', T('{rd} ← ({rs} == {rt}) ? 1 : 0', '{rd} ← ({rs} == {rt}) ? 1 : 0'), (d, s, t) => [['subu', d, s, t], ['ori', AT, ZERO, 1], ['sltu', d, d, AT]]],
  ['sne', T('{rd} ← ({rs} != {rt}) ? 1 : 0', '{rd} ← ({rs} != {rt}) ? 1 : 0'), (d, s, t) => [['subu', d, s, t], ['sltu', d, ZERO, d]]],
  ['sge', T('{rd} ← ({rs} >= {rt}) ? 1 : 0（有符号）', '{rd} ← ({rs} >= {rt}) ? 1 : 0 (signed)'), (d, s, t) => [['slt', d, s, t], ['ori', AT, ZERO, 1], ['subu', d, AT, d]]],
  ['sgeu', T('{rd} ← ({rs} >= {rt}) ? 1 : 0（无符号）', '{rd} ← ({rs} >= {rt}) ? 1 : 0 (unsigned)'), (d, s, t) => [['sltu', d, s, t], ['ori', AT, ZERO, 1], ['subu', d, AT, d]]],
  ['sgt', T('{rd} ← ({rs} > {rt}) ? 1 : 0（有符号）', '{rd} ← ({rs} > {rt}) ? 1 : 0 (signed)'), (d, s, t) => [['slt', d, t, s]]],
  ['sgtu', T('{rd} ← ({rs} > {rt}) ? 1 : 0（无符号）', '{rd} ← ({rs} > {rt}) ? 1 : 0 (unsigned)'), (d, s, t) => [['sltu', d, t, s]]],
  ['sle', T('{rd} ← ({rs} <= {rt}) ? 1 : 0（有符号）', '{rd} ← ({rs} <= {rt}) ? 1 : 0 (signed)'), (d, s, t) => [['slt', d, t, s], ['ori', AT, ZERO, 1], ['subu', d, AT, d]]],
  ['sleu', T('{rd} ← ({rs} <= {rt}) ? 1 : 0（无符号）', '{rd} ← ({rs} <= {rt}) ? 1 : 0 (unsigned)'), (d, s, t) => [['sltu', d, t, s], ['ori', AT, ZERO, 1], ['subu', d, AT, d]]],
]
for (const [name, desc, core] of SETS) {
  F(name, '$t1,$t2,$t3', desc, ({ r }) => core(r[0]!, r[1]!, r[2]!))
  F(name, '$t1,$t2,-100', cat(desc, T('；立即数先装进 $at', '; the immediate goes into $at first')), ({ r, v }) => [['addi', AT, ZERO, lo(v[0]!)], ...core(r[0]!, r[1]!, AT)])
  F(name, '$t1,$t2,100000', cat(desc, T('；32 位立即数先装进 $at', '; the 32-bit immediate goes into $at first')), ({ r, v }) => [...loadAt(v[0]!), ...core(r[0]!, r[1]!, AT)])
}

/* ---------------------------------------------------------------- moves */

F('move', '$t1,$t2', T('复制：$t1 ← $t2 + 0', 'Copy: $t1 ← $t2 + 0'), ({ r }) => [['addu', r[0]!, ZERO, r[1]!]])
F('abs', '$t1,$t2', T('绝对值：用符号掩码异或再相减', 'Absolute value: XOR with the sign mask, then subtract it'), ({ r }) => [
  ['sra', AT, r[1]!, 31],
  ['xor', r[0]!, AT, r[1]!],
  ['subu', r[0]!, r[0]!, AT],
])
F('neg', '$t1,$t2', T('取负：0 − $t2（溢出时异常）', 'Negate: 0 − $t2 (traps on overflow)'), ({ r }) => [['sub', r[0]!, ZERO, r[1]!]])
F('negu', '$t1,$t2', T('取负：0 − $t2（不查溢出）', 'Negate: 0 − $t2 (no overflow check)'), ({ r }) => [['subu', r[0]!, ZERO, r[1]!]])

/* ---------------------------------------------------------------- branches */

F('b', 'label', T('无条件跳转：$zero ≥ 0 永远成立', 'Unconditional branch: $zero ≥ 0 always holds'), ({ v }) => [['bgez', ZERO, v[0]!]])
F('beqz', '$t1,label', T('等于 0 就跳转', 'Branch if equal to 0'), ({ r, v }) => [['beq', r[0]!, ZERO, v[0]!]])
F('bnez', '$t1,label', T('不等于 0 就跳转', 'Branch if not equal to 0'), ({ r, v }) => [['bne', r[0]!, ZERO, v[0]!]])
for (const name of ['beq', 'bne'] as const) {
  F(name, '$t1,-100,label', T('和立即数比较：立即数先装进 $at', 'Compare with an immediate: load it into $at first'), ({ r, v }) => [['addi', AT, ZERO, lo(v[0]!)], [name, AT, r[0]!, v[1]!]])
  F(name, '$t1,100000,label', T('和 32 位立即数比较：先装进 $at', 'Compare with a 32-bit immediate: load it into $at first'), ({ r, v }) => [...loadAt(v[0]!), [name, AT, r[0]!, v[1]!]])
}

/** Compare-and-branch pseudo-instructions: [name, slt flavour, register form, -100 form, 100000 form]. */
type B3 = (rs: number, rt: number, imm: number, label: number) => Emit[]
const BR: [string, Text, B3, B3, B3][] = [
  ['bge', T('若 $t1 ≥ 第二个操作数（有符号）就跳转', 'Branch if $t1 ≥ the second operand (signed)'),
    (s, t, _, l) => [['slt', AT, s, t], ['beq', AT, ZERO, l]],
    (s, _, i, l) => [['slti', AT, s, lo(i)], ['beq', AT, ZERO, l]],
    (s, _, i, l) => [...loadAt(i), ['slt', AT, s, AT], ['beq', AT, ZERO, l]]],
  ['bgeu', T('若 $t1 ≥ 第二个操作数（无符号）就跳转', 'Branch if $t1 ≥ the second operand (unsigned)'),
    (s, t, _, l) => [['sltu', AT, s, t], ['beq', AT, ZERO, l]],
    (s, _, i, l) => [['sltiu', AT, s, lo(i)], ['beq', AT, ZERO, l]],
    (s, _, i, l) => [...loadAt(i), ['sltu', AT, s, AT], ['beq', AT, ZERO, l]]],
  ['bgt', T('若 $t1 > 第二个操作数（有符号）就跳转', 'Branch if $t1 > the second operand (signed)'),
    (s, t, _, l) => [['slt', AT, t, s], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [['addi', AT, ZERO, lo(i)], ['slt', AT, AT, s], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [...loadAt((i + 1) | 0), ['slt', AT, s, AT], ['beq', AT, ZERO, l]]],
  ['bgtu', T('若 $t1 > 第二个操作数（无符号）就跳转', 'Branch if $t1 > the second operand (unsigned)'),
    (s, t, _, l) => [['sltu', AT, t, s], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [['addi', AT, ZERO, lo(i)], ['sltu', AT, AT, s], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [...loadAt(i), ['sltu', AT, AT, s], ['bne', AT, ZERO, l]]],
  ['ble', T('若 $t1 ≤ 第二个操作数（有符号）就跳转', 'Branch if $t1 ≤ the second operand (signed)'),
    (s, t, _, l) => [['slt', AT, t, s], ['beq', AT, ZERO, l]],
    (s, _, i, l) => [['addi', AT, s, 0xffff], ['slti', AT, AT, lo(i)], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [...loadAt((i + 1) | 0), ['slt', AT, s, AT], ['bne', AT, ZERO, l]]],
  ['bleu', T('若 $t1 ≤ 第二个操作数（无符号）就跳转', 'Branch if $t1 ≤ the second operand (unsigned)'),
    (s, t, _, l) => [['sltu', AT, t, s], ['beq', AT, ZERO, l]],
    (s, _, i, l) => [['addi', AT, ZERO, lo(i)], ['sltu', AT, AT, s], ['beq', AT, ZERO, l]],
    (s, _, i, l) => [...loadAt(i), ['sltu', AT, AT, s], ['beq', AT, ZERO, l]]],
  ['blt', T('若 $t1 < 第二个操作数（有符号）就跳转', 'Branch if $t1 < the second operand (signed)'),
    (s, t, _, l) => [['slt', AT, s, t], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [['slti', AT, s, lo(i)], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [...loadAt(i), ['slt', AT, s, AT], ['bne', AT, ZERO, l]]],
  ['bltu', T('若 $t1 < 第二个操作数（无符号）就跳转', 'Branch if $t1 < the second operand (unsigned)'),
    (s, t, _, l) => [['sltu', AT, s, t], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [['sltiu', AT, s, lo(i)], ['bne', AT, ZERO, l]],
    (s, _, i, l) => [...loadAt(i), ['sltu', AT, s, AT], ['bne', AT, ZERO, l]]],
]
for (const [name, desc, rr, ri, rb] of BR) {
  F(name, '$t1,$t2,label', cat(desc, T('：slt 算出比较结果放进 $at，再看 $at', ': slt puts the comparison into $at, then the branch tests $at')), ({ r, v }) => rr(r[0]!, r[1]!, 0, v[0]!))
  F(name, '$t1,-100,label', cat(desc, T('（和 16 位立即数比较）', ' (against a 16-bit immediate)')), ({ r, v }) => ri(r[0]!, 0, v[0]!, v[1]!))
  F(name, '$t1,100000,label', cat(desc, T('（和 32 位立即数比较）', ' (against a 32-bit immediate)')), ({ r, v }) => rb(r[0]!, 0, v[0]!, v[1]!))
}

/* ---------------------------------------------------------------- rotates */

F('rol', '$t1,$t2,$t3', T('循环左移，位数在寄存器里', 'Rotate left by the amount in a register'), ({ r }) => [
  ['subu', AT, ZERO, r[2]!],
  ['srlv', AT, r[1]!, AT],
  ['sllv', r[0]!, r[1]!, r[2]!],
  ['or', r[0]!, r[0]!, AT],
])
F('rol', '$t1,$t2,10', T('循环左移：高位挪到 $at 的低位，主体左移，再拼起来', 'Rotate left: move the high bits to the low end of $at, shift the rest left, then OR them together'), ({ r, v }) => [
  ['srl', AT, r[1]!, (32 - v[0]!) & 31],
  ['sll', r[0]!, r[1]!, v[0]!],
  ['or', r[0]!, r[0]!, AT],
])
F('ror', '$t1,$t2,$t3', T('循环右移，位数在寄存器里', 'Rotate right by the amount in a register'), ({ r }) => [
  ['subu', AT, ZERO, r[2]!],
  ['sllv', AT, r[1]!, AT],
  ['srlv', r[0]!, r[1]!, r[2]!],
  ['or', r[0]!, r[0]!, AT],
])
F('ror', '$t1,$t2,10', T('循环右移：低位挪到 $at 的高位，主体右移，再拼起来', 'Rotate right: move the low bits to the high end of $at, shift the rest right, then OR them together'), ({ r, v }) => [
  ['sll', AT, r[1]!, (32 - v[0]!) & 31],
  ['srl', r[0]!, r[1]!, v[0]!],
  ['or', r[0]!, r[0]!, AT],
])

/* ---------------------------------------------------------------- coprocessor-1 pairs */

F('mfc1.d', '$t1,$f2', T('一对浮点寄存器的原始内容搬到一对通用寄存器', 'Move the raw bits of a float register pair into a general register pair'), ({ r }) => [
  ['mfc1', r[0]!, r[1]!],
  ['mfc1', r[0]! + 1, r[1]! + 1],
])
F('mtc1.d', '$t1,$f2', T('一对通用寄存器的内容搬到一对浮点寄存器', 'Move a general register pair into a float register pair'), ({ r }) => [
  ['mtc1', r[0]!, r[1]!],
  ['mtc1', r[0]! + 1, r[1]! + 1],
])

/* ---------------------------------------------------------------- multiply, divide */

const withImm = (name: string, desc: Text, core: (rd: number, rs: number, rt: number) => Emit[], regForm: boolean) => {
  if (regForm) F(name, '$t1,$t2,$t3', desc, ({ r }) => core(r[0]!, r[1]!, r[2]!))
  F(name, '$t1,$t2,-100', cat(desc, T('；立即数先装进 $at', '; the immediate goes into $at first')), ({ r, v }) => [['addi', AT, ZERO, lo(v[0]!)], ...core(r[0]!, r[1]!, AT)])
  F(name, '$t1,$t2,100000', cat(desc, T('；32 位立即数先装进 $at', '; the 32-bit immediate goes into $at first')), ({ r, v }) => [...loadAt(v[0]!), ...core(r[0]!, r[1]!, AT)])
}
withImm('mul', T('$t1 ← $t2 × 立即数的低 32 位', '$t1 ← low 32 bits of $t2 × immediate'), (d, s, t) => [['mul', d, s, t]], false)
withImm('mulu', T('$t1 ← $t2 × $t3 的低 32 位（无符号）', '$t1 ← low 32 bits of $t2 × $t3 (unsigned)'), (d, s, t) => [['multu', s, t], ['mflo', d]], true)
withImm('mulo', T('有符号乘法，溢出时执行 break', 'Signed multiply; executes break on overflow'), (d, s, t) => [
  ['mult', s, t],
  ['mfhi', AT],
  ['mflo', d],
  ['sra', d, d, 31],
  ['beq', AT, d, { rel: 1 }],
  ['break'],
  ['mflo', d],
], true)
withImm('mulou', T('无符号乘法，溢出时执行 break', 'Unsigned multiply; executes break on overflow'), (d, s, t) => [
  ['multu', s, t],
  ['mfhi', AT],
  ['beq', AT, ZERO, { rel: 1 }],
  ['break'],
  ['mflo', d],
], true)
for (const [name, base, take, what] of [
  ['div', 'div', 'mflo', T('商', 'quotient')],
  ['divu', 'divu', 'mflo', T('商（无符号）', 'quotient (unsigned)')],
  ['rem', 'div', 'mfhi', T('余数', 'remainder')],
  ['remu', 'divu', 'mfhi', T('余数（无符号）', 'remainder (unsigned)')],
] as const) {
  F(name, '$t1,$t2,$t3', T(`$t1 ← $t2 ÷ $t3 的${what.zh}；除数为 0 时先执行 break`, `$t1 ← ${what.en} of $t2 ÷ $t3; a zero divisor executes break first`), ({ r }) => [
    ['bne', r[2]!, ZERO, { rel: 1 }],
    ['break'],
    [base, r[1]!, r[2]!],
    [take, r[0]!],
  ])
  F(name, '$t1,$t2,-100', T(`$t1 ← $t2 ÷ 立即数的${what.zh}`, `$t1 ← ${what.en} of $t2 ÷ immediate`), ({ r, v }) => [['addi', AT, ZERO, lo(v[0]!)], [base, r[1]!, AT], [take, r[0]!]])
  F(name, '$t1,$t2,100000', T(`$t1 ← $t2 ÷ 32 位立即数的${what.zh}`, `$t1 ← ${what.en} of $t2 ÷ 32-bit immediate`), ({ r, v }) => [...loadAt(v[0]!), [base, r[1]!, AT], [take, r[0]!]])
}

/* ---------------------------------------------------------------- load immediate / address */

F('li', '$t1,-100', T('立即数放得进 16 位（有符号）：$zero + imm，一条 addiu', 'The immediate fits in signed 16 bits: $zero + imm, one addiu'), ({ r, v }) => [['addiu', r[0]!, ZERO, lo(v[0]!)]])
F('li', '$t1,100', T('立即数放得进 16 位（无符号）：$zero | imm，一条 ori', 'The immediate fits in unsigned 16 bits: $zero | imm, one ori'), ({ r, v }) => [['ori', r[0]!, ZERO, lo(v[0]!)]])
F('li', '$t1,100000', T('32 位立即数：lui 装高 16 位，ori 补低 16 位', '32-bit immediate: lui loads the high 16 bits, ori fills in the low 16'), ({ r, v }) => [
  ['lui', AT, hiX(v[0]!)],
  ['ori', r[0]!, AT, lo(v[0]!)],
])

F('la', '$t1,($t2)', T('取地址：$t1 ← $t2', 'Load address: $t1 ← $t2'), ({ r }) => [['addi', r[0]!, r[1]!, 0]])
F('la', '$t1,-100', T('把 16 位有符号地址装进 $t1', 'Load a signed 16-bit address into $t1'), ({ r, v }) => [['addiu', r[0]!, ZERO, lo(v[0]!)]])
F('la', '$t1,100', T('把 16 位无符号地址装进 $t1', 'Load an unsigned 16-bit address into $t1'), ({ r, v }) => [['ori', r[0]!, ZERO, lo(v[0]!)]])
F('la', '$t1,100000', T('把 32 位地址装进 $t1', 'Load a 32-bit address into $t1'), ({ r, v }) => [['lui', AT, hiX(v[0]!)], ['ori', r[0]!, AT, lo(v[0]!)]])
F('la', '$t1,100($t2)', T('$t1 ← $t2 + 偏移', '$t1 ← $t2 + offset'), ({ r, v }) => [['ori', AT, ZERO, lo(v[0]!)], ['add', r[0]!, r[1]!, AT]])
F('la', '$t1,100000($t2)', T('$t1 ← $t2 + 32 位偏移', '$t1 ← $t2 + 32-bit offset'), ({ r, v }) => [...loadAt(v[0]!), ['add', r[0]!, r[1]!, AT]])
F('la', '$t1,label', T('标签地址：lui 装高 16 位，ori 补低 16 位', 'Label address: lui loads the high 16 bits, ori fills in the low 16'), ({ r, v }) => [['lui', AT, hiX(v[0]!)], ['ori', r[0]!, AT, lo(v[0]!)]])
F('la', '$t1,label($t2)', T('$t1 ← 标签地址 + $t2', '$t1 ← label address + $t2'), ({ r, v }) => [...loadAt(v[0]!), ['add', r[0]!, r[1]!, AT]])
F('la', '$t1,label+100000', T('$t1 ← 标签地址 + 常数', '$t1 ← label address + constant'), ({ r, v }) => {
  const a = (v[0]! + v[1]!) | 0
  return [['lui', AT, hiX(a)], ['ori', r[0]!, AT, lo(a)]]
})
F('la', '$t1,label+100000($t2)', T('$t1 ← 标签地址 + 常数 + $t2', '$t1 ← label address + constant + $t2'), ({ r, v }) => [...loadAt((v[0]! + v[1]!) | 0), ['add', r[0]!, r[1]!, AT]])

/* ---------------------------------------------------------------- loads and stores with any address */

/** 10 address forms shared by lw, sw, lb, ..., ll, sc. `full` adds the "100" and "100($t2)" forms. */
function memoryForms(name: string, op: string, what: Text, full: boolean): void {
  F(name, '$t1,($t2)', cat(what, T('：省略偏移，等于 0($t2)', ': offset omitted, same as 0($t2)')), ({ r }) => [[op, r[0]!, 0, r[1]!]])
  F(name, '$t1,-100', cat(what, T('：地址就是一个 16 位常数（基址 $zero）', ': the address is a 16-bit constant (base $zero)')), ({ r, v }) => [[op, r[0]!, lo(v[0]!), ZERO]])
  if (full) F(name, '$t1,100', cat(what, T('：16 位无符号地址先用 ori 装进 $at', ': an unsigned 16-bit address goes into $at with ori first')), ({ r, v }) => [['ori', AT, ZERO, lo(v[0]!)], [op, r[0]!, 0, AT]])
  F(name, '$t1,100000', cat(what, T('：32 位地址，高半部分用 lui 装进 $at', ': 32-bit address; lui loads the high half into $at')), ({ r, v }) => [['lui', AT, hiA(v[0]!)], [op, r[0]!, lo(v[0]!), AT]])
  if (full)
    F(name, '$t1,100($t2)', cat(what, T('：偏移放不进有符号 16 位，先装进 $at 再加基址', ': the offset does not fit in signed 16 bits: load it into $at, then add the base')), ({ r, v }) => [
      ['ori', AT, ZERO, lo(v[0]!)],
      ['addu', AT, AT, r[1]!],
      [op, r[0]!, 0, AT],
    ])
  F(name, '$t1,100000($t2)', cat(what, T('：32 位偏移加基址', ': 32-bit offset plus base')), ({ r, v }) => [
    ['lui', AT, hiA(v[0]!)],
    ['addu', AT, AT, r[1]!],
    [op, r[0]!, lo(v[0]!), AT],
  ])
  F(name, '$t1,label', cat(what, T('：按标签地址访问（lui 装高位，低位作偏移）', ": at a label's address (lui loads the high half, the low half is the offset)")), ({ r, v }) => [['lui', AT, hiA(v[0]!)], [op, r[0]!, lo(v[0]!), AT]])
  F(name, '$t1,label($t2)', cat(what, T('：标签地址 + $t2', ': label address + $t2')), ({ r, v }) => [
    ['lui', AT, hiA(v[0]!)],
    ['addu', AT, AT, r[1]!],
    [op, r[0]!, lo(v[0]!), AT],
  ])
  F(name, '$t1,label+100000', cat(what, T('：标签地址 + 常数', ': label address + constant')), ({ r, v }) => {
    const a = (v[0]! + v[1]!) | 0
    return [['lui', AT, hiA(a)], [op, r[0]!, lo(a), AT]]
  })
  F(name, '$t1,label+100000($t2)', cat(what, T('：标签地址 + 常数 + $t2', ': label address + constant + $t2')), ({ r, v }) => {
    const a = (v[0]! + v[1]!) | 0
    return [['lui', AT, hiA(a)], ['addu', AT, AT, r[1]!], [op, r[0]!, lo(a), AT]]
  })
}

const MEM_WHAT: Record<string, Text> = {
  lw: T('读 4 字节', 'Load 4 bytes'),
  sw: T('写 4 字节', 'Store 4 bytes'),
  lh: T('读 2 字节（符号扩展）', 'Load 2 bytes (sign-extended)'),
  sh: T('写 2 字节', 'Store 2 bytes'),
  lb: T('读 1 字节（符号扩展）', 'Load 1 byte (sign-extended)'),
  sb: T('写 1 字节', 'Store 1 byte'),
  lhu: T('读 2 字节（零扩展）', 'Load 2 bytes (zero-extended)'),
  lbu: T('读 1 字节（零扩展）', 'Load 1 byte (zero-extended)'),
  lwl: T('非对齐读左半部分', 'Unaligned load, left part'),
  swl: T('非对齐写左半部分', 'Unaligned store, left part'),
  lwr: T('非对齐读右半部分', 'Unaligned load, right part'),
  swr: T('非对齐写右半部分', 'Unaligned store, right part'),
  ll: T('载入链接', 'Load linked'),
  sc: T('条件存储', 'Store conditional'),
}
for (const op of ['lw', 'sw', 'lh', 'sh', 'lb', 'sb', 'lhu', 'lbu', 'lwl', 'swl', 'lwr', 'swr', 'll', 'sc']) memoryForms(op, op, MEM_WHAT[op]!, true)

/* ---------------------------------------------------------------- unaligned and doubleword helpers */

type Addr =
  | { kind: 'base'; off: number; base: number } // -100($t2)
  | { kind: 'abs'; addr: number } // 100000, label, label+100000
  | { kind: 'reg'; base: number } // ($t2)
  | { kind: 'absBase'; addr: number; base: number } // 100000($t2), label($t2), label+100000($t2)

/** Address forms in the order MARS lists them for ulw, ulh, ulhu, ld, usw, ush, sd. */
function wideForms(name: string, desc: Text, body: (rt: number, a: Addr) => Emit[]): void {
  F(name, '$t1,-100($t2)', desc, ({ r, v }) => body(r[0]!, { kind: 'base', off: v[0]!, base: r[1]! }))
  F(name, '$t1,100000', desc, ({ r, v }) => body(r[0]!, { kind: 'abs', addr: v[0]! }))
  F(name, '$t1,label', desc, ({ r, v }) => body(r[0]!, { kind: 'abs', addr: v[0]! }))
  F(name, '$t1,label+100000', desc, ({ r, v }) => body(r[0]!, { kind: 'abs', addr: (v[0]! + v[1]!) | 0 }))
  F(name, '$t1,($t2)', desc, ({ r }) => body(r[0]!, { kind: 'reg', base: r[1]! }))
  F(name, '$t1,100000($t2)', desc, ({ r, v }) => body(r[0]!, { kind: 'absBase', addr: v[0]!, base: r[1]! }))
  F(name, '$t1,label($t2)', desc, ({ r, v }) => body(r[0]!, { kind: 'absBase', addr: v[0]!, base: r[1]! }))
  F(name, '$t1,label+100000($t2)', desc, ({ r, v }) => body(r[0]!, { kind: 'absBase', addr: (v[0]! + v[1]!) | 0, base: r[1]! }))
}

/**
 * One memory access at address+k, the way MARS spells it for each address form.
 * For "-100($t2)" the k = 0 access uses the base register directly, others go through $at.
 */
function access(op: string, rt: number, a: Addr, k: number): Emit[] {
  switch (a.kind) {
    case 'reg':
      return [[op, rt, k, a.base]]
    case 'abs': {
      const x = (a.addr + k) | 0
      return [['lui', AT, hiA(x)], [op, rt, lo(x), AT]]
    }
    case 'absBase': {
      const x = (a.addr + k) | 0
      return [['lui', AT, hiA(x)], ['addu', AT, AT, a.base], [op, rt, lo(x), AT]]
    }
    case 'base': {
      if (k === 0) return [[op, rt, lo(a.off), a.base]]
      const x = (a.off + k) | 0
      return [['lui', AT, hiA(x)], ['addu', AT, AT, a.base], [op, rt, lo(x), AT]]
    }
  }
}

wideForms('ulw', T('非对齐读一个字：lwl 读高位部分，lwr 读低位部分', 'Unaligned word load: lwl reads the high part, lwr the low part'), (rt, a) =>
  a.kind === 'base' ? [...access('lwl', rt, a, 3), ...access('lwr', rt, a, 0)] : [...access('lwl', rt, a, 3), ...access('lwr', rt, a, 0)],
)
const ulh = (first: string) => (rt: number, a: Addr): Emit[] => [
  ...access(first, rt, a, 1),
  ...access('lbu', AT, a, 0),
  ['sll', rt, rt, 8],
  ['or', rt, rt, AT],
]
wideForms('ulh', T('非对齐读半字（符号扩展）：分两次读字节再拼起来', 'Unaligned halfword load (sign-extended): read two bytes and combine them'), ulh('lb'))
wideForms('ulhu', T('非对齐读半字（零扩展）：分两次读字节再拼起来', 'Unaligned halfword load (zero-extended): read two bytes and combine them'), ulh('lbu'))
wideForms('ld', T('读 8 字节到一对通用寄存器 $t1、$t1+1', 'Load 8 bytes into the register pair $t1, $t1+1'), (rt, a) => [...access('lw', rt, a, 0), ...access('lw', rt + 1, a, 4)])
wideForms('usw', T('非对齐写一个字：swl 写高位部分，swr 写低位部分', 'Unaligned word store: swl writes the high part, swr the low part'), (rt, a) => [...access('swl', rt, a, 3), ...access('swr', rt, a, 0)])
wideForms('ush', T('非对齐写半字：先写低字节，循环移位后写高字节，再移回来', 'Unaligned halfword store: write the low byte, rotate, write the high byte, rotate back'), (rt, a) => [
  ...access('sb', rt, a, 0),
  ['sll', AT, rt, 24],
  ['srl', rt, rt, 8],
  ['or', rt, rt, AT],
  ...access('sb', rt, a, 1),
  ['srl', AT, rt, 24],
  ['sll', rt, rt, 8],
  ['or', rt, rt, AT],
])
wideForms('sd', T('把一对通用寄存器 $t1、$t1+1 写成 8 字节', 'Store the register pair $t1, $t1+1 as 8 bytes'), (rt, a) => [...access('sw', rt, a, 0), ...access('sw', rt + 1, a, 4)])

/* ---------------------------------------------------------------- floating-point loads and stores */

/** lwc1/ldc1/swc1/sdc1 and the l.s/s.s/l.d/s.d aliases: 8 address forms, no "100" variants. */
function fpMemoryForms(name: string, op: string, what: Text): void {
  const reg = name.includes('d') ? '$f2' : '$f1'
  const ex = (s: string) => s.replace('$t1', reg)
  F(name, ex('$t1,($t2)'), cat(what, T('：省略偏移，等于 0($t2)', ': offset omitted, same as 0($t2)')), ({ r }) => [[op, r[0]!, 0, r[1]!]])
  F(name, ex('$t1,-100'), cat(what, T('：地址就是 16 位常数', ': the address is a 16-bit constant')), ({ r, v }) => [[op, r[0]!, lo(v[0]!), ZERO]])
  F(name, ex('$t1,100000'), cat(what, T('：32 位地址', ': 32-bit address')), ({ r, v }) => [['lui', AT, hiA(v[0]!)], [op, r[0]!, lo(v[0]!), AT]])
  F(name, ex('$t1,100000($t2)'), cat(what, T('：32 位偏移加基址', ': 32-bit offset plus base')), ({ r, v }) => [
    ['lui', AT, hiA(v[0]!)],
    ['addu', AT, AT, r[1]!],
    [op, r[0]!, lo(v[0]!), AT],
  ])
  F(name, ex('$t1,label'), cat(what, T('：按标签地址访问', ": at a label's address")), ({ r, v }) => [['lui', AT, hiA(v[0]!)], [op, r[0]!, lo(v[0]!), AT]])
  F(name, ex('$t1,label($t2)'), cat(what, T('：标签地址 + $t2', ': label address + $t2')), ({ r, v }) => [
    ['lui', AT, hiA(v[0]!)],
    ['addu', AT, AT, r[1]!],
    [op, r[0]!, lo(v[0]!), AT],
  ])
  F(name, ex('$t1,label+100000'), cat(what, T('：标签地址 + 常数', ': label address + constant')), ({ r, v }) => {
    const a = (v[0]! + v[1]!) | 0
    return [['lui', AT, hiA(a)], [op, r[0]!, lo(a), AT]]
  })
  F(name, ex('$t1,label+100000($t2)'), cat(what, T('：标签地址 + 常数 + $t2', ': label address + constant + $t2')), ({ r, v }) => {
    const a = (v[0]! + v[1]!) | 0
    return [['lui', AT, hiA(a)], ['addu', AT, AT, r[1]!], [op, r[0]!, lo(a), AT]]
  })
}
fpMemoryForms('lwc1', 'lwc1', T('读单精度', 'Load single precision'))
fpMemoryForms('ldc1', 'ldc1', T('读双精度', 'Load double precision'))
fpMemoryForms('swc1', 'swc1', T('写单精度', 'Store single precision'))
fpMemoryForms('sdc1', 'sdc1', T('写双精度', 'Store double precision'))
fpMemoryForms('l.s', 'lwc1', T('读单精度（lwc1 的别名）', 'Load single precision (alias of lwc1)'))
fpMemoryForms('s.s', 'swc1', T('写单精度（swc1 的别名）', 'Store single precision (alias of swc1)'))
fpMemoryForms('l.d', 'ldc1', T('读双精度（ldc1 的别名）', 'Load double precision (alias of ldc1)'))
fpMemoryForms('s.d', 'sdc1', T('写双精度（sdc1 的别名）', 'Store double precision (alias of sdc1)'))

export const PSEUDO: PseudoForm[] = forms

export const PSEUDO_BY_NAME = new Map<string, PseudoForm[]>()
for (const p of forms) {
  const list = PSEUDO_BY_NAME.get(p.name)
  if (list) list.push(p)
  else PSEUDO_BY_NAME.set(p.name, [p])
}
