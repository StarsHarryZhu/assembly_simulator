/** Machine word → named bit fields, assembly text and notes, for the calculator and the disassembler tab. */
import { L, T, tx, type Text } from '../../core/i18n'
import type { DecodedView, FieldView } from '../../core/isa'
import { vaOf } from '../../core/format'
import { decodeWord, displayForm, mnemonicOf, operandsOf, printForm, type Form } from './encoding/table'
import { printWidths } from './encoding/operands'
import type { Fields } from './instructions/types'

/** What each field is called. Fields without an entry show their own name. */
export const FIELD_TITLES: Record<string, Text> = {
  op: T('操作码', 'opcode'),
  sf: T('位宽', 'size flag'),
  Rd: T('目标寄存器', 'destination'),
  Rn: T('第一个操作数', 'first operand'),
  Rm: T('第二个操作数', 'second operand'),
  Ra: T('加数寄存器', 'addend'),
  Rt: T('数据寄存器', 'data register'),
  Rt2: T('第二个数据寄存器', 'second data register'),
  Rs: T('状态/比较寄存器', 'status/compare register'),
  imm12: T('12 位立即数', '12-bit immediate'),
  imm16: T('16 位立即数', '16-bit immediate'),
  imm19: T('19 位偏移', '19-bit offset'),
  imm26: T('26 位偏移', '26-bit offset'),
  imm14: T('14 位偏移', '14-bit offset'),
  imm9: T('9 位偏移', '9-bit offset'),
  imm7: T('7 位偏移', '7-bit offset'),
  imm6: T('移位量', 'shift amount'),
  imm3: T('左移量', 'left shift'),
  immlo: T('立即数低 2 位', 'immediate low 2 bits'),
  immhi: T('立即数高 19 位', 'immediate high 19 bits'),
  immr: T('循环右移量', 'rotate'),
  imms: T('位段长度', 'field size'),
  N: T('64 位模式', '64-bit pattern'),
  sh: T('左移 12 位', 'shift by 12'),
  shift: T('移位方式', 'shift type'),
  hw: T('左移 16 × hw', 'shift 16 × hw'),
  option: T('扩展方式', 'extend'),
  S: T('缩放', 'scale'),
  cond: T('条件', 'condition'),
  nzcv: T('标志值', 'flag value'),
  opc: T('操作', 'operation'),
  size: T('访问大小', 'access size'),
  b5: T('位号最高位', 'bit number top'),
  b40: T('位号低 5 位', 'bit number low 5'),
  CRn: T('CRn', 'CRn'),
  CRm: T('CRm', 'CRm'),
  op0: T('op0', 'op0'),
  op1: T('op1', 'op1'),
  op2: T('op2', 'op2'),
  o0: T('o0', 'o0'),
  L: T('加载', 'load'),
  A: T('获取', 'acquire'),
  R: T('释放', 'release'),
  M: T('修饰值', 'modifier'),
  Z: T('零修饰', 'zero modifier'),
  W: T('写回', 'writeback'),
  Q: T('全宽 128 位', 'full 128 bits'),
  Vd: T('目标寄存器', 'destination'),
  Vn: T('第一个操作数', 'first operand'),
  Vm: T('第二个操作数', 'second operand'),
  Vdn: T('目标兼第一个操作数', 'destination and first operand'),
  ftype: T('浮点类型', 'float type'),
  sz: T('元素大小', 'element size'),
  Zd: T('目标向量', 'destination vector'),
  Zn: T('第一个源向量', 'first source vector'),
  Zm: T('第二个源向量', 'second source vector'),
  Zk: T('第三个源向量', 'third source vector'),
  Za: T('加数向量', 'addend vector'),
  Zda: T('累加向量（读写）', 'accumulator (read and written)'),
  Zdn: T('目标兼第一个源向量', 'destination and first source'),
  Zt: T('数据向量', 'data vector'),
  Pg: T('执行谓词', 'governing predicate'),
  Pd: T('目标谓词', 'destination predicate'),
  Pn: T('第一个源谓词', 'first source predicate'),
  Pm: T('第二个源谓词', 'second source predicate'),
  Pdn: T('目标兼源谓词', 'destination and source predicate'),
  Pdm: T('目标兼源谓词', 'destination and source predicate'),
  Pt: T('数据谓词', 'data predicate'),
  PNd: T('目标谓词（计数形式）', 'destination predicate-as-counter'),
  PNn: T('源谓词（计数形式）', 'source predicate-as-counter'),
  pattern: T('元素个数模式', 'element count pattern'),
  tsz: T('大小和移位', 'size and shift'),
  tszh: T('大小和移位（高位）', 'size and shift (high)'),
  tszl: T('大小和移位（低位）', 'size and shift (low)'),
  msz: T('内存元素大小', 'memory element size'),
  xs: T('偏移的扩展方式', 'offset extend'),
  prfop: T('预取方式', 'prefetch operation'),
  rot: T('旋转角度', 'rotation'),
  imm4: T('4 位立即数', '4-bit immediate'),
  imm5: T('5 位立即数', '5-bit immediate'),
  imm8: T('8 位立即数', '8-bit immediate'),
}

const titleOf = (name: string) => (FIELD_TITLES[name] ? tx(FIELD_TITLES[name]!) : name)

/** The encoding class (op0, bits 28..25), as the Arm ARM groups encodings. */
export function classOf(word: number): string {
  const op0 = (word >>> 25) & 15
  if ((op0 & 0b1110) === 0b1000) return 'DP-imm'
  if ((op0 & 0b1110) === 0b1010) return 'Branch/System'
  if ((op0 & 0b0111) === 0b0101) return 'DP-reg'
  if ((op0 & 0b0111) === 0b0111) return 'SIMD&FP'
  if ((op0 & 0b0101) === 0b0100) return 'Load/Store'
  if (op0 === 0b0010) return 'SVE'
  if (op0 === 0) return word >>> 31 ? 'SME' : 'Reserved'
  return 'Unallocated'
}

/** The printed operand each field belongs to, for the field's meaning. */
function meanings(form: Form, f: Fields, pc: number): Map<string, string> {
  const out = new Map<string, string>()
  printWidths.current = form.instr.widths
  for (const op of operandsOf(form.items)) {
    let text: string
    try {
      text = op.type.print(f, op.arg, { pc })
    } catch {
      continue
    }
    for (const name of op.type.fields(op.arg)) if (!out.has(name)) out.set(name, text)
  }
  return out
}

export function decodeView(word: number, addr = 0x400000): DecodedView {
  word >>>= 0
  const d = decodeWord(word)
  const format = classOf(word)
  if (!d) {
    return {
      ok: false,
      text: L('（无法识别）', '(unrecognized)'),
      mnemonic: '',
      format,
      fields: [{ name: 'op', title: titleOf('op'), hi: 31, lo: 0, value: word, meaning: '', fixed: false, used: true }],
      notes: [L(`0x${word.toString(16).padStart(8, '0')} 不是这里实现的指令（未分配的编码，或不在支持范围内的扩展）`, `0x${word.toString(16).padStart(8, '0')} is not an instruction implemented here (an unallocated encoding, or an extension outside the supported set)`)],
    }
  }
  const { form, fields } = displayForm(d)
  const text = printForm(form, fields, { pc: addr })
  const shown = meanings(form, fields, addr)
  const base = form.alias ? meanings(d.instr.form, d.fields, addr) : shown
  const mnemonic = mnemonicOf(form, fields)
  const views: FieldView[] = d.instr.pattern.segments.map((s) => {
    const width = s.hi - s.lo + 1
    const value = s.name === null ? s.value : (word >>> s.lo) & (width === 32 ? 0xffffffff : (1 << width) - 1)
    if (s.name === null) return { name: 'op', title: titleOf('op'), hi: s.hi, lo: s.lo, value, meaning: L(`固定位 → ${d.instr.spec.mnemonic}`, `fixed → ${d.instr.spec.mnemonic}`), fixed: true, used: true }
    const name = s.name
    let meaning = shown.get(name) ?? base.get(name) ?? ''
    let used = meaning !== ''
    if (name === 'sf') {
      meaning = value ? L('64 位（x 寄存器）', '64-bit (x registers)') : L('32 位（w 寄存器）', '32-bit (w registers)')
      used = true
    } else if (!used && name in (form.fixed ?? {})) {
      meaning = L(`由 ${mnemonic} 固定`, `fixed by ${mnemonic}`)
      used = true
    }
    return { name, title: titleOf(name), hi: s.hi, lo: s.lo, value, meaning, fixed: false, used }
  })
  const notes: string[] = []
  if (form.alias) {
    const real = printForm(d.instr.form, d.fields, { pc: addr })
    notes.push(L(`${mnemonic} 是别名，实际的指令是 ${real}`, `${mnemonic} is an alias; the instruction is ${real}`))
  }
  notes.push(...(d.instr.spec.notes?.(d.fields, addr) ?? []))
  if ('imm26' in d.fields || 'imm19' in d.fields || 'imm14' in d.fields) {
    const bits = 'imm26' in d.fields ? 26 : 'imm19' in d.fields ? 19 : 14
    const raw = d.fields['imm' + bits]!
    const off = ((raw << (32 - bits)) >> (32 - bits)) * 4
    if (!/^(ldr|ldrsw|prfm)$/.test(d.instr.spec.mnemonic) || 'imm19' in d.fields)
      notes.push(L(`偏移 = 立即数 × 4 = ${off} 字节，从这条指令的地址（PC）算起，目标 0x${(vaOf(addr) + BigInt(off)).toString(16)}`, `Offset = immediate × 4 = ${off} bytes from this instruction's address (PC); target 0x${(vaOf(addr) + BigInt(off)).toString(16)}`))
  }
  return { ok: true, text, mnemonic, format, fields: views, notes, description: form.desc }
}
