/** MIPS32 as an IsaPlugin: MARS 4.5 instruction set, assembler, simulator and decoder. */
import { T, type Text } from '../../core/i18n'
import type { CatalogEntry, Environment, ExampleProgram, IsaPlugin, LabelKind, Program, SourceFile } from '../../core/isa'
import { assemble, DATA_BASE, DIRECTIVES, MNEMONICS, TEXT_BASE } from './assembler'
import { analyzeLine, buildLine } from './calc'
import { createMachine, HEAP_BASE, INITIAL_SP } from './cpu'
import { decodeView } from './decoder'
import { FIELD_TITLES } from './formats'
import { ALL_FORMS } from './forms'
import { tokenize } from './lexer'
import { FP, GPR_NAMES, PC, REGISTER_BANKS, REGISTER_COUNT, SP } from './registers'
import { REFERENCES } from './references'

const GROUP_TITLES: Record<string, Text> = {
  R: T('R 型', 'R-type'),
  I: T('I 型', 'I-type'),
  J: T('J 型', 'J-type'),
  REGIMM: T('REGIMM', 'REGIMM'),
  SPECIAL2: T('SPECIAL2', 'SPECIAL2'),
  TRAP: T('陷阱', 'Traps'),
  CP0: T('CP0', 'CP0'),
  FP: T('浮点', 'Float'),
  PSEUDO: T('伪指令', 'Pseudo'),
}

export const CATALOG: CatalogEntry[] = ALL_FORMS.map((f) => ({
  key: f.key,
  mnemonic: f.name,
  example: f.example,
  group: f.basic ? f.basic.group : 'PSEUDO',
  pseudo: !f.basic,
  description: f.basic ? f.basic.desc : f.pseudo!.desc,
}))

export { GROUP_TITLES }

/**
 * Where each mnemonic takes a label, read off its forms: an operand whose example holds a name (`label`,
 * `target`, `label+100000($t2)`). Basic instructions take labels only as branch or jump targets; among
 * pseudo-instructions the branches (b…) want code and the rest (la, lw, s.d, …) an address in data.
 */
export const LABEL_OPERANDS: Record<string, Record<number, LabelKind>> = {}
for (const f of ALL_FORMS) {
  f.example
    .slice(f.name.length)
    .split(',')
    .forEach((operand, at) => {
      if (!tokenize(operand).some((t) => t.kind === 'ident')) return
      const wants: LabelKind = f.basic || /^[bj]/.test(f.name) ? 'code' : 'data'
      const slots = (LABEL_OPERANDS[f.name] ??= {})
      slots[at] ??= wants
    })
}

/**
 * Example programs, in menu order. examples/<id>.asm has Chinese comments, examples/en/<id>.asm the same
 * code with English comments. Each file starts with "# <title>".
 */
const EXAMPLE_ORDER = ['welcome', 'hello', 'factorial', 'input', 'float', 'heap', 'exceptions']
const zhFiles = import.meta.glob('./examples/*.asm', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const enFiles = import.meta.glob('./examples/en/*.asm', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const idOf = (path: string) => path.replace(/^.*\/|\.asm$/g, '')
const titleOf = (text: string, id: string) => /^#\s*(.+)$/m.exec(text)?.[1]?.trim() ?? id
const enById = new Map(Object.entries(enFiles).map(([path, text]) => [idOf(path), text]))
export const EXAMPLES: ExampleProgram[] = Object.entries(zhFiles)
  .map(([path, zh]) => {
    const id = idOf(path)
    const en = enById.get(id) ?? zh
    return { id, title: T(titleOf(zh, id), titleOf(en, id)), text: T(zh, en) }
  })
  .sort((a, b) => (EXAMPLE_ORDER.indexOf(a.id) + 1 || 99) - (EXAMPLE_ORDER.indexOf(b.id) + 1 || 99))

export { decodeView }

export { FIELD_TITLES }

export const mips: IsaPlugin = {
  id: 'mips32',
  displayName: 'MIPS32 (MARS 4.5)',
  available: true,
  registers: REGISTER_BANKS,
  registerCount: REGISTER_COUNT,
  pcRegister: PC,
  spRegister: SP,
  fpRegister: FP,
  layout: {
    littleEndian: true,
    segments: [
      { id: 'text', title: T('代码段 .text', 'text segment .text'), start: TEXT_BASE, end: 0x0ffffffc },
      { id: 'extern', title: T('外部变量 .extern', 'externs .extern'), start: 0x10000000, end: 0x1000ffff },
      { id: 'data', title: T('数据段 .data', 'data segment .data'), start: DATA_BASE, end: HEAP_BASE - 1 },
      { id: 'heap', title: T('堆（sbrk）', 'heap (sbrk)'), start: HEAP_BASE, end: 0x7effffff },
      { id: 'stack', title: T('栈', 'stack'), start: 0x7f000000, end: 0x7fffffff },
      { id: 'ktext', title: T('内核代码 .ktext', 'kernel text .ktext'), start: 0x80000000, end: 0x8ffffffc },
      { id: 'kdata', title: T('内核数据 .kdata', 'kernel data .kdata'), start: 0x90000000, end: 0xfffeffff },
      { id: 'mmio', title: T('内存映射 I/O', 'memory-mapped I/O'), start: 0xffff0000, end: 0xffffffff },
    ],
    textBase: TEXT_BASE,
    dataBase: DATA_BASE,
    heapBase: HEAP_BASE,
    stackBase: INITIAL_SP,
    stackGrowsDown: true,
    wordSize: 4,
  },
  language: {
    mnemonics: MNEMONICS,
    registers: [...GPR_NAMES.map((n) => '$' + n), ...Array.from({ length: 32 }, (_, i) => '$' + i), ...Array.from({ length: 32 }, (_, i) => '$f' + i)],
    directives: DIRECTIVES,
    sections: ['.text', '.data', '.ktext', '.kdata'],
    dataSections: ['.data', '.kdata'],
    labelOperands: LABEL_OPERANDS,
    commentChar: '#',
  },
  catalog: CATALOG,
  catalogGroups: Object.entries(GROUP_TITLES).map(([id, title]) => ({ id, title })),
  examples: EXAMPLES,
  references: REFERENCES,
  assemble: (source: SourceFile, options) => assemble(source, options),
  createMachine: (program: Program, env: Environment) => createMachine(program, env),
  decode: (word: number, addr: number) => decodeView(word, addr),
  analyzeLine: (line, options) => analyzeLine(line, CATALOG, options),
  buildLine,
}
