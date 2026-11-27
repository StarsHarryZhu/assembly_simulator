/**
 * The memory panel's entries: one per data declaration, one per heap block, and one per run of other
 * words the program wrote, each with a one-line summary.
 *
 * Built after every step, so the cost must not grow with the size of a declaration or of the address
 * space: addresses are kept unsigned (kernel data lives at 0x90000000, which `& ~3` would turn negative),
 * and "was it ever written" comes from a binary search in the sorted list of written words.
 *
 * A declaration without a label belongs to the label above it: when it holds the same kind of data and starts
 * right where that entry ends, it joins the entry (`A: .word 1, 2` and a next line `.word 3, 4` are four words
 * of A; strings join strings), otherwise it is its own entry named by its offset from that label (`A+8`).
 *
 * Every entry can be read as another kind (a .space buffer as words or as text, a word as its bytes); the
 * summary and the rows follow that view.
 */
import { charOf, doubleFromBits, floatFromBits, hex16, hex8, hexN, javaDouble, javaFloat } from '../../core/format'
import type { DataKind, IsaPlugin, Machine, MemChange, Program } from '../../core/isa'
import { t } from '../i18n'

export interface MemoryEntry {
  key: string
  title: string
  kind: DataKind
  /** Unsigned start address. */
  addr: number
  size: number
  count: number
  note: string
  line: number | null
  /** How it is read: its own kind unless the viewer picked another. */
  view: DataKind
  /** The last step wrote into it. */
  flash: boolean
  /** Written at some point of the run. */
  ever: boolean
  summary: string
}

export const KIND_TITLE: Record<DataKind, string> = {
  dword: '.dword',
  word: '.word',
  half: '.half',
  byte: '.byte',
  ascii: '.ascii',
  asciiz: '.asciiz',
  space: '.space',
  float: '.float',
  double: '.double',
}

/** The directive that declares a kind of data in this ISA's assembler (`.hword` rather than `.half` in GNU as). */
export function kindTitle(isa: IsaPlugin, kind: DataKind): string {
  return isa.language.dataDirectives?.[kind] ?? KIND_TITLE[kind]
}

/**
 * Addresses as the memory panel compares them: unsigned 32-bit numbers in a 32-bit address space, as they
 * are in a 64-bit one (`>>> 0` would cut them to 32 bits there).
 */
export function addressNormalizer(isa: IsaPlugin): (a: number) => number {
  return isa.layout.addressBits === 64 ? (a) => a : (a) => a >>> 0
}

/** The address of the 4-byte word holding `a`; arithmetic rather than `& ~3`, which only works below 2^31. */
const wordOf = (a: number) => a - (a % 4)

export const ELEM: Record<DataKind, number> = { dword: 8, word: 4, half: 2, byte: 1, ascii: 1, asciiz: 1, space: 1, float: 4, double: 8 }

const TEXT = new Set<DataKind>(['ascii', 'asciiz'])

/** Elements an entry holds when read as `view`; a view other than its own kind takes the whole elements that fit. */
export function elementCount(e: { kind: DataKind; size: number; count: number }, view: DataKind): number {
  return view === e.kind ? e.count : Math.floor(e.size / ELEM[view])
}

function readHalf(isa: IsaPlugin, m: Machine, a: number) {
  return isa.layout.littleEndian ? m.readByte(a) | (m.readByte(a + 1) << 8) : (m.readByte(a) << 8) | m.readByte(a + 1)
}

export function elementText(isa: IsaPlugin, m: Machine, kind: DataKind, a: number): { hex: string; value: string } {
  switch (kind) {
    case 'word': {
      const w = m.readWord(a)
      return { hex: hex8(w), value: String(w | 0) }
    }
    case 'half': {
      const h = readHalf(isa, m, a)
      return { hex: hexN(h, 4), value: String((h << 16) >> 16) }
    }
    case 'float': {
      const w = m.readWord(a)
      return { hex: hex8(w), value: javaFloat(floatFromBits(w)) }
    }
    case 'dword': {
      const lo = BigInt(m.readWord(a) >>> 0)
      const hi = BigInt(m.readWord(a + 4) >>> 0)
      const v = (hi << 32n) | lo
      return { hex: hex16(v), value: BigInt.asIntN(64, v).toString() }
    }
    case 'double': {
      const lo = m.readWord(a)
      const hi = m.readWord(a + 4)
      return { hex: hex8(hi) + hex8(lo).slice(2), value: javaDouble(doubleFromBits(lo, hi)) }
    }
    default: {
      const b = m.readByte(a)
      return { hex: hexN(b, 2), value: `${(b << 24) >> 24}  ${charOf(b)}` }
    }
  }
}

/** Index of the first element of the ascending list that is >= a. */
function lowerBound(list: number[], a: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid]! < a) lo = mid + 1
    else hi = mid
  }
  return lo
}

type Base = Omit<MemoryEntry, 'view' | 'flash' | 'ever' | 'summary'>

function summary(isa: IsaPlugin, m: Machine, e: Base, view: DataKind, written: number[], ever: boolean): string {
  if (e.kind === 'space') {
    // .space starts as zeros, so only the words written since can make it non-zero.
    let zeros = true
    const end = e.addr + e.size
    for (let i = lowerBound(written, wordOf(e.addr)); ever && zeros && i < written.length && written[i]! < end; i++) {
      for (let b = 0; b < 4; b++) {
        const a = written[i]! + b
        if (a >= e.addr && a < end && m.readByte(a)) zeros = false
      }
    }
    if (zeros) return t(`${e.size} 字节，全是 0`, `${e.size} bytes, all zero`)
  }
  if (TEXT.has(view)) {
    // A declared string shows all of its text; other memory read as text stops at the first 0, as print_string does.
    const declared = TEXT.has(e.kind)
    let n = declared && e.kind === 'asciiz' ? e.size - 1 : e.size
    let out = ''
    for (let i = 0; i < Math.min(n, 60); i++) {
      const b = m.readByte(e.addr + i)
      if (!declared && b === 0) {
        n = i
        break
      }
      out += charOf(b)
    }
    return `"${out}${n > 60 ? '…' : ''}"`
  }
  if (view === 'space' || view === 'byte') {
    const n = Math.min(e.size, 16)
    const parts: string[] = []
    for (let i = 0; i < n; i++) parts.push(view === 'byte' ? String((m.readByte(e.addr + i) << 24) >> 24) : hexN(m.readByte(e.addr + i), 2).slice(2))
    return `[${parts.join(view === 'byte' ? ', ' : ' ')}${e.size > n ? ' …' : ''}]`
  }
  const step = ELEM[view]
  const count = elementCount(e, view)
  const n = Math.min(count, 10)
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(elementText(isa, m, view, e.addr + i * step).value)
  return `[${parts.join(', ')}${count > n ? ', …' : ''}]`
}

/** Same kind of data, so the second can continue the first: strings join strings. */
const joins = (a: DataKind, b: DataKind) => a === b || (TEXT.has(a) && TEXT.has(b))

/**
 * `views` maps an entry's key to the kind it is read as. Keys of labelled declarations are their label, so
 * the choice survives edits that move lines.
 */
export function memoryEntries(
  m: Machine,
  p: Program,
  isa: IsaPlugin,
  fileName: string,
  touched: MemChange[],
  views?: ReadonlyMap<string, DataKind>,
): MemoryEntry[] {
  const u = addressNormalizer(isa)
  const entries: Base[] = []
  // Per segment: the entry of the last declaration, the label it belongs to, and where it ends.
  const chain = new Map<string, { entry: Base; label: string | null; labelAddr: number; end: number }>()
  for (const d of p.declarations) {
    const addr = u(d.addr)
    const prev = chain.get(d.segment)
    // Only alignment padding (under 8 bytes) may lie between this declaration and the one before.
    const follows = !!prev && addr >= prev.end && addr - prev.end < 8
    if (!d.label && follows && addr === prev!.end && joins(prev!.entry.kind, d.kind)) {
      const e = prev!.entry
      e.size = addr + d.size - e.addr
      e.count += d.count
      if (TEXT.has(d.kind)) e.kind = d.kind // a string ends the way its last part does
      prev!.end = addr + d.size
      continue
    }
    const owner = d.label ? { label: d.label, labelAddr: addr } : follows && prev!.label ? { label: prev!.label, labelAddr: prev!.labelAddr } : { label: null, labelAddr: addr }
    const entry: Base = {
      key: d.label ? `l${d.label}` : `d${addr}:${d.line}`,
      title: d.label ?? (owner.label ? `${owner.label}+${addr - owner.labelAddr}` : t('（无标签）', '(no label)')),
      kind: d.kind,
      addr,
      size: d.size,
      count: d.count,
      note: d.segment === 'data' ? '' : d.segment === 'kdata' ? '.kdata' : d.segment === 'extern' ? '.extern' : d.segment,
      line: d.file === fileName ? d.line : null,
    }
    entries.push(entry)
    chain.set(d.segment, { entry, ...owner, end: addr + d.size })
  }
  // Undeclared memory is shown in the machine's word size: doublewords on a 64-bit ISA.
  const unit = isa.layout.wordSize === 8 ? 8 : 4
  const unitKind: DataKind = unit === 8 ? 'dword' : 'word'
  for (const h of m.heapBlocks()) {
    entries.push({ key: `h${h.addr}`, title: t(`堆块 #${h.index + 1}`, `heap block #${h.index + 1}`), kind: unitKind, addr: u(h.addr), size: h.size, count: Math.ceil(h.size / unit), note: h.note ?? 'sbrk', line: null })
  }

  // Written words outside every entry above, the stack and the text segment, grouped into runs. Both
  // lists are walked in address order, so this is linear in their lengths.
  const written = m.writtenWords()
  const spans = entries.map((e) => [e.addr, e.addr + Math.max(e.size, 1)] as const).sort((a, b) => a[0] - b[0])
  const stack = isa.layout.segments.find((g) => g.id === 'stack')
  const lowest = isa.layout.dataBase - 0x10000
  const others: Base[] = []
  let run: number[] = []
  const flush = () => {
    if (!run.length) return
    const a = run[0]! - (run[0]! % unit)
    const size = Math.ceil((run[run.length - 1]! + 4 - a) / unit) * unit
    others.push({ key: `w${a}`, title: t('其他写入', 'other writes'), kind: unitKind, addr: a, size, count: size / unit, note: t('未声明', 'undeclared'), line: null })
    run = []
  }
  let j = 0
  let reach = 0 // furthest end among the spans passed so far (they may overlap)
  for (const a of written) {
    while (j < spans.length && spans[j]![0] < a + 4) reach = Math.max(reach, spans[j++]![1])
    const covered = reach > a
    if (covered || (stack && a >= u(stack.start) && a <= u(stack.end)) || a < lowest) continue
    if (run.length && a !== run[run.length - 1]! + 4) flush()
    run.push(a)
  }
  flush()
  const all = [...entries, ...others].sort((a, b) => a.addr - b.addr)

  return all.map((e) => {
    const end = e.addr + Math.max(e.size, 1)
    const flash = touched.some((c) => u(c.addr) < end && u(c.addr) + c.size > e.addr)
    const first = lowerBound(written, wordOf(e.addr))
    const ever = first < written.length && written[first]! < end
    const view = views?.get(e.key) ?? e.kind
    return { ...e, view, flash, ever, summary: summary(isa, m, e, view, written, ever) }
  })
}
