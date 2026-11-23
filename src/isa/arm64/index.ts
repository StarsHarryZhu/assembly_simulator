/** AArch64 (ARMv9-A) as an IsaPlugin: GNU as assembler, simulator with Linux system calls and a C library, decoder. */
import { T, type Text } from '../../core/i18n'
import type { CatalogEntry, Environment, ExampleProgram, IsaPlugin, LabelKind, Program, SourceFile } from '../../core/isa'
import { assemble, DIRECTIVES, KTEXT_BASE, KSTACK_TOP, TEXT_BASE } from './assembler'
import { analyzeLine, buildLine } from './calc'
import { createMachine, INITIAL_SP } from './cpu'
import { decodeView } from './decoder'
import { allForms, mnemonicList, operandsOf, sampleLine } from './encoding/table'
import { formatSource } from './format'
import { loadTables } from './instructions/index'
import { HEAP_BASE, HEAP_LIMIT, MALLOC_BASE, MALLOC_LIMIT, MMAP_BASE, MMAP_LIMIT, STACK_SIZE, STACK_TOP, STUB_BASE, STUB_END } from './linux'
import { FP_REG, GPR_WORDS, parseGpr, PC, REGISTER_BANKS, REGISTER_COUNT, SP, SYSREGS } from './registers'
import { REFERENCES } from './references'

loadTables()

export const GROUP_TITLES: Record<string, Text> = {
  arith: T('算术', 'Arithmetic'),
  logic: T('逻辑', 'Logic'),
  move: T('传送', 'Move'),
  bits: T('位操作', 'Bit operations'),
  cond: T('条件', 'Conditional'),
  branch: T('分支', 'Branches'),
  load: T('加载存储', 'Loads and stores'),
  atomic: T('原子和独占', 'Atomics and exclusives'),
  mops: T('内存复制和设置', 'Memory copy and set'),
  system: T('系统', 'System'),
}

export const CATALOG: CatalogEntry[] = allForms().map((form) => ({
  key: form.key,
  mnemonic: form.mnemonic,
  example: sampleLine(form),
  group: form.group,
  // Aliases are real encodings under another name, not expansions.
  pseudo: false,
  description: form.desc,
}))

/** Where each mnemonic takes a label: branch targets want code, ADR, ADRP and literal loads want data. */
export const LABEL_OPERANDS: Record<string, Record<number, LabelKind>> = {}
for (const form of allForms()) {
  operandsOf(form.items).forEach((op, at) => {
    if (op.type.kind !== 'label') return
    const names = form.mnemonic.includes('<cond>') ? mnemonicList().filter((m) => m.startsWith(form.mnemonic.replace('<cond>', ''))) : [form.mnemonic]
    for (const name of names) {
      const slots = (LABEL_OPERANDS[name] ??= {})
      slots[at] ??= form.group === 'branch' ? 'code' : 'data'
    }
  })
}

/**
 * Example programs, in menu order. examples/<id>.s has Chinese comments, examples/en/<id>.s the same code
 * with English comments. Each file starts with "// <title>".
 */
const EXAMPLE_ORDER = ['welcome', 'hello', 'hello-printf', 'factorial', 'input', 'heap', 'exceptions']
const zhFiles = import.meta.glob('./examples/*.s', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const enFiles = import.meta.glob('./examples/en/*.s', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const idOf = (path: string) => path.replace(/^.*\/|\.s$/g, '')
const titleOf = (text: string, id: string) => /^\/\/\s*(.+)$/m.exec(text)?.[1]?.trim() ?? id
const enById = new Map(Object.entries(enFiles).map(([path, text]) => [idOf(path), text]))
export const EXAMPLES: ExampleProgram[] = Object.entries(zhFiles)
  .map(([path, zh]) => {
    const id = idOf(path)
    const en = enById.get(id) ?? zh
    return { id, title: T(titleOf(zh, id), titleOf(en, id)), text: T(zh, en) }
  })
  .sort((a, b) => (EXAMPLE_ORDER.indexOf(a.id) + 1 || 99) - (EXAMPLE_ORDER.indexOf(b.id) + 1 || 99))

export { decodeView }

export const arm64: IsaPlugin = {
  id: 'arm64',
  displayName: 'ARMv9-A (AArch64)',
  available: true,
  registers: REGISTER_BANKS,
  registerCount: REGISTER_COUNT,
  pcRegister: PC,
  spRegister: SP,
  fpRegister: FP_REG,
  layout: {
    littleEndian: true,
    addressBits: 64,
    segments: [
      { id: 'libc', title: T('C 库入口', 'C library entry points'), start: STUB_BASE, end: STUB_END - 1 },
      { id: 'text', title: T('程序 .text .rodata .data .bss', 'program .text .rodata .data .bss'), start: TEXT_BASE, end: HEAP_BASE - 1 },
      { id: 'heap', title: T('堆（brk）', 'heap (brk)'), start: HEAP_BASE, end: HEAP_LIMIT - 1 },
      { id: 'malloc', title: T('malloc 的内存', 'malloc arena'), start: MALLOC_BASE, end: MALLOC_LIMIT - 1 },
      { id: 'mmap', title: T('mmap 映射', 'mmap regions'), start: MMAP_BASE, end: MMAP_LIMIT - 1 },
      { id: 'stack', title: T('栈', 'stack'), start: STACK_TOP - STACK_SIZE, end: STACK_TOP - 1 },
      { id: 'kernel', title: T('内核 .ktext .kdata 和内核栈', 'kernel .ktext .kdata and kernel stack'), start: KTEXT_BASE, end: KSTACK_TOP - 1 },
    ],
    textBase: TEXT_BASE,
    dataBase: TEXT_BASE,
    heapBase: HEAP_BASE,
    stackBase: INITIAL_SP,
    stackGrowsDown: true,
    wordSize: 8,
  },
  language: {
    mnemonics: mnemonicList(),
    registers: [...GPR_WORDS, ...SYSREGS.map((r) => r.name.toLowerCase())],
    directives: DIRECTIVES,
    sections: ['.text', '.data', '.bss', '.rodata', '.section'],
    dataSections: ['.data', '.bss', '.rodata'],
    labelOperands: LABEL_OPERANDS,
    commentChar: '//',
    lineStartComment: '#',
    blockComment: ['/*', '*/'],
    statementSeparator: ';',
    isRegister: (word) => parseGpr(word) !== null,
    fileExtension: '.s',
    dataDirectives: { dword: '.quad', word: '.word', half: '.hword', byte: '.byte', ascii: '.ascii', asciiz: '.asciz', space: '.skip', float: '.float', double: '.double' },
  },
  catalog: CATALOG,
  catalogGroups: Object.entries(GROUP_TITLES).map(([id, title]) => ({ id, title })),
  examples: EXAMPLES,
  references: REFERENCES,
  samples: {
    line: 'add x0, x1, x2',
    words: '0x8b020020\n0xf9400420\n0x94000003 @ 0x400008\n0xd65f03c0',
    decoderExamples: [
      { word: '0x8b020020', note: 'add' },
      { word: '0xd2800540', note: 'mov' },
      { word: '0xf9400420', note: 'ldr' },
      { word: '0xa9bf7bfd', note: 'stp' },
      { word: '0x54000040', note: 'b.eq' },
      { word: '0x94000003', note: 'bl' },
      { word: '0xd65f03c0', note: 'ret' },
      { word: '0xd4000001', note: 'svc' },
      { word: '0xd503201f', note: 'nop' },
    ],
    push: 'stp x29, x30, [sp, #-16]!',
  },
  zeroRegister: undefined,
  assemble: (source: SourceFile, options) => assemble(source, options),
  createMachine: (program: Program, env: Environment) => createMachine(program, env),
  decode: (word: number, addr: number) => decodeView(word, addr),
  analyzeLine: (line, options) => analyzeLine(line, CATALOG, options),
  buildLine,
  format: formatSource,
}
