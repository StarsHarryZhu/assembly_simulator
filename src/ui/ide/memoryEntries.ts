/**
 * The memory panel's entries: one per data declaration, one per heap block, and one per run of other
 * words the program wrote, each with a one-line summary.
 *
 * Built after every step, so the cost must not grow with the size of a declaration or of the address
 * space: addresses are kept unsigned (kernel data lives at 0x90000000, which `& ~3` would turn negative),
 * and "was it ever written" comes from a binary search in the sorted list of written words.
 */
import { charOf, doubleFromBits, floatFromBits, hex8, hexN, javaDouble, javaFloat } from '../../core/format'
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
  /** The last step wrote into it. */
  flash: boolean
  /** Written at some point of the run. */
  ever: boolean
  summary: string
}

export const KIND_TITLE: Record<DataKind, string> = {
  word: '.word',
  half: '.half',
  byte: '.byte',
  ascii: '.ascii',
  asciiz: '.asciiz',
  space: '.space',
  float: '.float',
  double: '.double',
}

export const ELEM: Record<DataKind, number> = { word: 4, half: 2, byte: 1, ascii: 1, asciiz: 1, space: 1, float: 4, double: 8 }

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

type Base = Omit<MemoryEntry, 'flash' | 'ever' | 'summary'>

function summary(isa: IsaPlugin, m: Machine, e: Base, written: number[], ever: boolean): string {
  if (e.kind === 'ascii' || e.kind === 'asciiz') {
    let out = ''
    const n = e.kind === 'asciiz' ? e.size - 1 : e.size
    for (let i = 0; i < Math.min(n, 60); i++) out += charOf(m.readByte(e.addr + i))
    return `"${out}${n > 60 ? '…' : ''}"`
  }
  if (e.kind === 'space' || e.kind === 'byte') {
    if (e.kind === 'space') {
      // .space starts as zeros, so only the words written since can make it non-zero.
      let zeros = true
      const end = e.addr + e.size
      for (let i = lowerBound(written, (e.addr & ~3) >>> 0); ever && zeros && i < written.length && written[i]! < end; i++) {
        for (let b = 0; b < 4; b++) {
          const a = written[i]! + b
          if (a >= e.addr && a < end && m.readByte(a)) zeros = false
        }
      }
      if (zeros) return t(`${e.size} 字节，全是 0`, `${e.size} bytes, all zero`)
    }
    const n = Math.min(e.size, 16)
    const parts: string[] = []
    for (let i = 0; i < n; i++) parts.push(e.kind === 'byte' ? String((m.readByte(e.addr + i) << 24) >> 24) : hexN(m.readByte(e.addr + i), 2).slice(2))
    return `[${parts.join(e.kind === 'byte' ? ', ' : ' ')}${e.size > n ? ' …' : ''}]`
  }
  const step = ELEM[e.kind]
  const n = Math.min(e.count, 10)
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(elementText(isa, m, e.kind, e.addr + i * step).value)
  return `[${parts.join(', ')}${e.count > n ? ', …' : ''}]`
}

export function memoryEntries(m: Machine, p: Program, isa: IsaPlugin, fileName: string, touched: MemChange[]): MemoryEntry[] {
  const entries: Base[] = []
  for (const d of p.declarations) {
    entries.push({
      key: `d${d.addr}:${d.line}`,
      title: d.label ?? t('（无标签）', '(no label)'),
      kind: d.kind,
      addr: d.addr >>> 0,
      size: d.size,
      count: d.count,
      note: d.segment === 'data' ? '' : d.segment === 'kdata' ? '.kdata' : d.segment === 'extern' ? '.extern' : d.segment,
      line: d.file === fileName ? d.line : null,
    })
  }
  for (const h of m.heapBlocks()) {
    entries.push({ key: `h${h.addr}`, title: t(`堆块 #${h.index + 1}`, `heap block #${h.index + 1}`), kind: 'word', addr: h.addr >>> 0, size: h.size, count: Math.ceil(h.size / 4), note: 'sbrk', line: null })
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
    const a = run[0]!
    others.push({ key: `w${a}`, title: t('其他写入', 'other writes'), kind: 'word', addr: a, size: run.length * 4, count: run.length, note: t('未声明', 'undeclared'), line: null })
    run = []
  }
  let j = 0
  let reach = 0 // furthest end among the spans passed so far (they may overlap)
  for (const a of written) {
    while (j < spans.length && spans[j]![0] < a + 4) reach = Math.max(reach, spans[j++]![1])
    const covered = reach > a
    if (covered || (stack && a >= stack.start >>> 0 && a <= stack.end >>> 0) || a < lowest) continue
    if (run.length && a !== run[run.length - 1]! + 4) flush()
    run.push(a)
  }
  flush()
  const all = [...entries, ...others].sort((a, b) => a.addr - b.addr)

  return all.map((e) => {
    const end = e.addr + Math.max(e.size, 1)
    const flash = touched.some((c) => c.addr >>> 0 < end && (c.addr >>> 0) + c.size > e.addr)
    const first = lowerBound(written, (e.addr & ~3) >>> 0)
    const ever = first < written.length && written[first]! < end
    return { ...e, flash, ever, summary: summary(isa, m, e, written, ever) }
  })
}
