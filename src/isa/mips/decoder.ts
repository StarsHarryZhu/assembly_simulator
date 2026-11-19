/** Machine word -> named bit fields, assembly text and notes, for the calculator and the decoder tab. */
import { L, tx } from '../../core/i18n'
import type { DecodedView, FieldView } from '../../core/isa'
import { decodeFields, findDef, render } from './encoding'
import { FIELD_TITLES, FORMATS, fieldOfOp, getField } from './formats'
import type { InstrDef } from './instructions/types'
import { fprName, gprName } from './registers'

function hex(v: number, digits: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(digits, '0')
}

/** Which operand fills a field, for the field's meaning text. */
function operandForField(def: InstrDef, field: string): InstrDef['ops'][number] | null {
  for (const op of def.ops) {
    if (fieldOfOp(op) === field) return op
    if (op === 'mem' && field === 'rs') return op
  }
  return null
}

export function decodeView(word: number, addr?: number): DecodedView {
  word >>>= 0
  const def = findDef(word)
  if (!def) {
    const op = word >>> 26
    const fmt = op === 0 ? FORMATS.R : op === 2 || op === 3 ? FORMATS.J : FORMATS.I
    return {
      ok: false,
      text: L('（无法识别）', '(unrecognized)'),
      mnemonic: '',
      format: op === 0 ? 'R' : op === 2 || op === 3 ? 'J' : 'I',
      fields: fmt.map((s) => ({ name: s.name, title: FIELD_TITLES[s.name] ? tx(FIELD_TITLES[s.name]!) : s.name, hi: s.hi, lo: s.lo, value: getField(word, s), meaning: '', fixed: false, used: true })),
      notes: [L(`操作码 ${op}（${hex(op, 2)}）${op === 0 ? `、功能码 ${word & 63}（${hex(word & 63, 2)}）` : ''} 没有对应的指令`, `No instruction has opcode ${op} (${hex(op, 2)})${op === 0 ? ` and function code ${word & 63} (${hex(word & 63, 2)})` : ''}`)],
    }
  }
  const d = decodeFields(word)
  const fields: FieldView[] = FORMATS[def.fmt].map((s) => {
    const value = getField(word, s)
    const fixed = s.name in def.fixed
    const op = operandForField(def, s.name)
    let meaning = ''
    if (fixed) {
      if (s.name === 'op' || s.name === 'funct' || s.name === 'sub' || s.name === 'fmt' || s.name === 'co') meaning = `${hex(value, 2)} → ${def.name}`
      else if (s.name === 'rt' && def.group === 'REGIMM') meaning = L(`子操作 ${value}`, `sub-op ${value}`)
      else if (s.name === 'rt' && def.group === 'TRAP' && def.fmt === 'I') meaning = L(`子操作 ${value}`, `sub-op ${value}`)
      else if (s.name === 'tf') meaning = value ? L('条件为真', 'if true') : L('条件为假', 'if false')
      else if (s.name === 'rd' && def.name === 'jalr') meaning = L('$ra（固定）', '$ra (fixed)')
      else meaning = value === 0 ? L('固定为 0', 'fixed at 0') : L(`固定为 ${value}`, `fixed at ${value}`)
    } else if (op) {
      switch (op) {
        case 'rd':
        case 'rs':
        case 'rt':
          meaning = gprName(value)
          break
        case 'mem':
          meaning = s.name === 'rs' ? L(`基址 ${gprName(value)}`, `base ${gprName(value)}`) : L(`偏移 ${d.simm}`, `offset ${d.simm}`)
          break
        case 'fd':
        case 'fs':
        case 'ft':
          meaning = fprName(value)
          break
        case 'c0':
          meaning = `CP0 $${value}`
          break
        case 'imm':
          meaning = String(d.simm)
          break
        case 'immu':
          meaning = `${value}（${hex(value, 4)}）`
          break
        case 'off':
          meaning = addr == null ? L(`偏移 ${d.simm} 条指令`, `offset ${d.simm} instructions`) : L(`目标 ${hex((addr + 4 + d.simm * 4) >>> 0, 8)}`, `target ${hex((addr + 4 + d.simm * 4) >>> 0, 8)}`)
          break
        case 'tgt':
          meaning = L(`目标 ${hex((((addr ?? 0) + 4) & 0xf0000000) | (value << 2), 8)}`, `target ${hex((((addr ?? 0) + 4) & 0xf0000000) | (value << 2), 8)}`)
          break
        default:
          meaning = String(value)
      }
    }
    return { name: s.name, title: FIELD_TITLES[s.name] ? tx(FIELD_TITLES[s.name]!) : s.name, hi: s.hi, lo: s.lo, value, meaning, fixed, used: fixed || op != null }
  })
  const notes: string[] = []
  if (def.ops.includes('off')) notes.push(L(`分支偏移 = 立即数 × 4 = ${d.simm * 4} 字节，从下一条指令（PC + 4）算起`, `Branch offset = immediate × 4 = ${d.simm * 4} bytes, counted from the next instruction (PC + 4)`))
  if (def.ops.includes('tgt')) notes.push(L('跳转目标只存了 26 位：实际地址 = (PC + 4) 的高 4 位 + target × 4', 'Only 26 bits of the target are stored: address = top 4 bits of (PC + 4) + target × 4'))
  if (def.ops.includes('mem')) notes.push(L(`有效地址 = ${gprName(d.rs)} + (${d.simm})`, `Effective address = ${gprName(d.rs)} + (${d.simm})`))
  if (def.name === 'lui') notes.push(L('这 16 位会放进结果的 31..16 位，低 16 位补 0', 'These 16 bits go into bits 31..16 of the result; the low 16 bits become 0'))
  return { ok: true, text: render(def, word, { addr }), mnemonic: def.name, format: def.fmt, fields, notes }
}
