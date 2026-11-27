/** AArch64 (ARMv9-A) as an IsaPlugin: GNU as assembler, simulator with Linux system calls and a C library, decoder. */
import { T, type Text } from '../../core/i18n'
import type { CatalogEntry, Environment, ExampleProgram, IsaPlugin, LabelKind, Program, SourceFile } from '../../core/isa'
import { assemble, DIRECTIVES, KTEXT_BASE, KSTACK_TOP, TEXT_BASE } from './assembler'
import { analyzeLine, buildLine } from './calc'
import { createMachine, DEFAULT_SVL, DEFAULT_VL, INITIAL_SP } from './cpu'
import { decodeView } from './decoder'
import { allForms, mnemonicList, operandsOf, sampleLine } from './encoding/table'
import { formatSource } from './format'
import { loadTables } from './instructions/index'
import { HEAP_BASE, HEAP_LIMIT, MALLOC_BASE, MALLOC_LIMIT, MMAP_BASE, MMAP_LIMIT, STACK_SIZE, STACK_TOP, STUB_BASE, STUB_END } from './linux'
import { FP_REG, GPR_WORDS, parseGpr, parseSveReg, parseVreg, PC, REGISTER_BANKS, REGISTER_COUNT, SP, SVE_WORDS, SYSREGS, VREG_WORDS } from './registers'
import { parseZa, SME_WORDS } from './encoding/sme'
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
  fp: T('标量浮点', 'Scalar floating point'),
  simd: T('向量整数（Neon）', 'Vector integer (Neon)'),
  simdfp: T('向量浮点（Neon）', 'Vector floating point (Neon)'),
  crypto: T('加密扩展', 'Cryptographic extensions'),
  vload: T('浮点和向量加载存储', 'FP and vector loads and stores'),
  sve: T('SVE 整数', 'SVE integer'),
  svepred: T('SVE 谓词', 'SVE predicates'),
  sveperm: T('SVE 置换', 'SVE permutes'),
  svefp: T('SVE 浮点', 'SVE floating point'),
  sveload: T('SVE 加载存储', 'SVE loads and stores'),
  sve2: T('SVE2 和 SVE2.1', 'SVE2 and SVE2.1'),
  sme: T('SME 矩阵', 'SME matrix'),
  sme2: T('SME2 多向量', 'SME2 multi-vector'),
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
const EXAMPLE_ORDER = ['welcome', 'hello', 'hello-printf', 'factorial', 'input', 'heap', 'float', 'simd', 'sve', 'sme', 'exceptions']
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
    registers: [...GPR_WORDS, ...VREG_WORDS, ...SVE_WORDS, ...SME_WORDS, ...SYSREGS.map((r) => r.name.toLowerCase())],
    directives: DIRECTIVES,
    sections: ['.text', '.data', '.bss', '.rodata', '.section'],
    dataSections: ['.data', '.bss', '.rodata'],
    labelOperands: LABEL_OPERANDS,
    commentChar: '//',
    lineStartComment: '#',
    blockComment: ['/*', '*/'],
    statementSeparator: ';',
    isRegister: (word) => parseGpr(word) !== null || parseVreg(word) !== null || parseSveReg(word) !== null || parseZa(word) !== null || ['ffr', 'zt0'].includes(word.toLowerCase()),
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
    search: ['lsl', '.quad'],
  },
  zeroRegister: undefined,
  assemble: (source: SourceFile, options) => assemble(source, options),
  settings: [
    {
      id: 'vl',
      title: T('SVE 向量长度', 'SVE vector length'),
      note: T('z 寄存器有多少位（VL）。程序不该依赖它：同一个程序在不同长度下都应该算出同样的结果。', 'How many bits a z register has (VL). Programs should not depend on it: the same program should compute the same result at every length.'),
      options: [128, 256, 512, 1024, 2048].map((v) => ({ value: v, label: T(`${v} 位`, `${v} bits`) })),
      default: DEFAULT_VL,
    },
    {
      id: 'svl',
      title: T('SME 流式向量长度', 'SME streaming vector length'),
      note: T('流式 SVE 模式（smstart 之后）里 z 寄存器的位数（SVL），也决定 ZA 的大小：SVL / 8 行，每行 SVL / 8 字节。', 'How many bits a z register has in Streaming SVE mode (after smstart), the SVL; it also sizes ZA: SVL / 8 rows of SVL / 8 bytes.'),
      options: [128, 256, 512, 1024, 2048].map((v) => ({ value: v, label: T(`${v} 位`, `${v} bits`) })),
      default: DEFAULT_SVL,
    },
  ],
  createMachine: (program: Program, env: Environment, options) => createMachine(program, env, options),
  decode: (word: number, addr: number) => decodeView(word, addr),
  analyzeLine: (line, options) => analyzeLine(line, CATALOG, options),
  buildLine,
  format: formatSource,
}
