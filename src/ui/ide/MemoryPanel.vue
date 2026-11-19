<script setup lang="ts">
/**
 * Data memory as entries: one per data declaration, one per heap block, and one per run of other words
 * the program wrote. Each entry shows a one-line summary and opens to show every element. Entries the
 * last step wrote are highlighted; entries written at any point carry a marker.
 */
import { t } from '../i18n'
import { computed, reactive } from 'vue'
import { charOf, hex8, hexN } from '../../core/format'
import { ELEM, elementText, KIND_TITLE, memoryEntries, type MemoryEntry } from './memoryEntries'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const s = props.handle.session
const v = props.handle.version
const isa = s.isa
const open = reactive(new Set<string>())
const limit = reactive(new Map<string, number>())
const PAGE = 256

const view = computed(() => {
  void v.value
  const m = s.machine
  const p = s.result?.program
  if (!m || !p) return null
  return memoryEntries(m, p, isa, s.file.name, s.mode === 'running' ? [] : (s.last?.memory ?? []))
})

/** One byte of a string or .space line: two hex digits and one fixed-width character cell. */
interface ByteCell {
  hex: string
  /** Printable ASCII as itself; space, control and non-ASCII bytes as a dim symbol, so every cell is 1ch. */
  ch: string
  symbol: boolean
  zero: boolean
  /** The last step wrote this byte. */
  hit: boolean
  tip: string
}

interface Row {
  key: number
  addr: string
  idx: string
  /** Byte lines only. */
  cells: ByteCell[] | null
  hex: string
  value: string
  zero: boolean
  flash: boolean
}

const SYMBOL: Record<number, string> = { 0: '∅', 9: '→', 10: '↵', 32: '·' }

function byteCell(b: number, hit: boolean): ByteCell {
  const printable = b > 32 && b < 127
  return {
    hex: hexN(b, 2).slice(2),
    ch: printable ? String.fromCharCode(b) : (SYMBOL[b] ?? '.'),
    symbol: !printable,
    zero: b === 0,
    hit,
    tip: `${hexN(b, 2)} = ${b}${b === 32 ? t('（空格）', ' (space)') : b < 32 || b === 127 ? `  ${charOf(b)}` : ''}`,
  }
}

/**
 * Rows of an opened entry: elements, or 8-byte lines for strings and .space. Every column has a fixed
 * width in ch (passed as CSS variables), so a short last line still lines up with the ones above.
 */
function rows(e: MemoryEntry): { bytes: boolean; list: Row[]; more: number; idxWidth: number; hexWidth: number } {
  const m = s.machine!
  const max = limit.get(e.key) ?? PAGE
  const touched = s.mode === 'running' ? [] : (s.last?.memory ?? [])
  const hit = (a: number, n: number) => touched.some((c) => c.addr >>> 0 < a + n && (c.addr >>> 0) + c.size > a)
  if (e.kind === 'ascii' || e.kind === 'asciiz' || e.kind === 'space') {
    const lines = Math.ceil(e.size / 8)
    return {
      bytes: true,
      list: Array.from({ length: Math.min(lines, max) }, (_, i) => {
        const a = e.addr + i * 8
        const n = Math.min(8, e.size - i * 8)
        const cells = Array.from({ length: n }, (_, j) => byteCell(m.readByte(a + j), hit(a + j, 1)))
        return { key: a, addr: hex8(a), idx: `+${i * 8}`, cells, hex: '', value: '', zero: false, flash: false }
      }),
      more: lines - max,
      idxWidth: `+${(lines - 1) * 8}`.length,
      hexWidth: 24,
    }
  }
  const step = ELEM[e.kind]
  const list = Array.from({ length: Math.min(e.count, max) }, (_, i) => {
    const a = e.addr + i * step
    const { hex, value } = elementText(isa, m, e.kind, a)
    return { key: a, addr: hex8(a), idx: `[${i}]`, cells: null, hex, value, zero: /^0x0+$/.test(hex), flash: hit(a, step) }
  })
  return { bytes: false, list, more: e.count - max, idxWidth: `[${e.count - 1}]`.length, hexWidth: list[0]?.hex.length ?? 10 }
}

function toggle(key: string) {
  if (open.has(key)) open.delete(key)
  else open.add(key)
}
</script>

<template>
  <section class="card panel" :aria-label="t('内存', 'Memory')">
    <header class="head">
      <h3>{{ t('内存', 'Memory') }}</h3>
      <span class="small muted">{{ t('按数据声明分条，点开看每个元素', 'One entry per data declaration; open one to see every element') }}</span>
    </header>
    <p v-if="!view" class="muted small empty">{{ t('汇编成功后显示。', 'Shown after a successful assembly.') }}</p>
    <p v-else-if="!view.length" class="muted small empty">
      {{ t('程序没有数据声明（.data）。运行时写到数据段或堆里的内容会显示在这里。', 'The program declares no data (.data). Anything it writes to the data segment or the heap will show up here.') }}
    </p>
    <div v-else class="list">
      <div v-for="e in view" :key="e.key" class="entry" :class="{ flash: e.flash }">
        <button class="eh" :aria-expanded="open.has(e.key)" @click="toggle(e.key)">
          <span class="caret">{{ open.has(e.key) ? '▾' : '▸' }}</span>
          <span class="t mono">{{ e.title }}</span>
          <span class="badge">{{ KIND_TITLE[e.kind] }}{{ e.count > 1 && !['ascii', 'asciiz', 'space'].includes(e.kind) ? ` ×${e.count}` : '' }}</span>
          <span v-if="e.note" class="badge warn">{{ e.note }}</span>
          <span v-if="e.ever" class="badge err">{{ t('改过', 'written') }}</span>
          <span class="addr mono small muted">{{ hex8(e.addr) }}</span>
          <span class="sum mono">{{ e.summary }}</span>
        </button>
        <template v-if="open.has(e.key)">
          <div v-for="r in [rows(e)]" :key="'r'" class="rows" :style="{ '--idx': `${r.idxWidth}ch`, '--hex': `${r.hexWidth}ch` }">
            <div v-for="x in r.list" :key="x.key" class="row mono" :class="{ flash: x.flash, bytes: r.bytes }">
              <span class="a">{{ x.addr }}</span>
              <span class="i">{{ x.idx }}</span>
              <template v-if="x.cells">
                <span class="hx"><template v-for="(c, j) in x.cells" :key="j">{{ j === 0 ? '' : j === 4 ? '  ' : ' ' }}<span :class="{ z: c.zero, hit: c.hit }">{{ c.hex }}</span></template></span>
                <span class="cs">
                  <span v-for="(c, j) in x.cells" :key="j" :class="{ sym: c.symbol, hit: c.hit }" :title="c.tip">{{ c.ch }}</span>
                </span>
              </template>
              <template v-else>
                <span :class="{ z: x.zero }">{{ x.hex }}</span>
                <span class="val">{{ x.value }}</span>
              </template>
            </div>
            <button v-if="r.more > 0" class="btn more" @click="limit.set(e.key, (limit.get(e.key) ?? PAGE) + PAGE * 4)">{{ t(`再显示一些（还有 ${r.more} 行）`, `Show more (${r.more} rows left)`) }}</button>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
h3 {
  margin: 0;
  font-size: 13.5px;
}
.empty {
  margin: 0;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.entry {
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}
.entry.flash {
  border-color: var(--danger);
  animation: flash 0.9s ease-out;
}
@keyframes flash {
  0% {
    box-shadow: 0 0 0 3px var(--bg-danger);
  }
  100% {
    box-shadow: none;
  }
}
.eh {
  appearance: none;
  border: 0;
  background: var(--surface-1);
  width: 100%;
  text-align: left;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 7px;
  padding: 5px 8px;
  cursor: pointer;
  color: var(--text-primary);
}
.eh:hover {
  background: var(--surface-2);
}
.entry.flash .eh {
  background: var(--bg-danger);
}
.caret {
  color: var(--text-muted);
  width: 10px;
}
.t {
  font-weight: 600;
  font-size: 12.5px;
}
.addr {
  margin-left: auto;
}
.sum {
  flex-basis: 100%;
  padding-left: 17px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rows {
  border-top: 1px solid var(--border);
  max-height: 320px;
  overflow: auto;
  padding: 3px;
  background: var(--surface-2);
}
/* Columns are sized in ch of the monospace font, so every row of an entry lines up. */
.row {
  display: grid;
  grid-template-columns: 10ch var(--idx) var(--hex) minmax(0, 1fr);
  column-gap: 1ch;
  align-items: baseline;
  padding: 1px 4px;
  font-size: 11.5px;
  line-height: 1.55;
  border-radius: 4px;
  white-space: pre;
}
.row:hover {
  background: var(--surface-1);
}
.row.flash {
  background: var(--bg-danger);
}
.a {
  color: var(--text-muted);
}
.i {
  color: var(--text-muted);
  text-align: right;
}
.z,
.sym {
  color: var(--text-muted);
}
/* Byte lines: eight hex pairs as plain spaced text (so they copy as text) and eight 1ch characters, both split 4 + 4. */
.cs > span {
  display: inline-block;
  width: 1ch;
  text-align: center;
}
.cs > span:nth-child(5) {
  margin-left: 0.5ch;
}
.hit {
  background: var(--bg-danger);
  color: var(--danger);
  border-radius: 2px;
}
.val {
  padding-left: 1ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.more {
  margin: 4px;
  font-size: 11.5px;
}
/*
 * Too narrow for one line (a phone): the value or the characters go under the hex. A byte line needs
 * about 48ch (about 340px at 11.5px), an element line much less.
 */
.rows {
  container-type: inline-size;
}
@container (max-width: 340px) {
  .row.bytes {
    grid-template-columns: 10ch var(--idx) minmax(0, 1fr);
  }
  .row.bytes .cs {
    grid-column: 3;
  }
}
@container (max-width: 260px) {
  .row {
    grid-template-columns: 10ch var(--idx) minmax(0, 1fr);
  }
  .row .val {
    grid-column: 3;
  }
}
</style>
