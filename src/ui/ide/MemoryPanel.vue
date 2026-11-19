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

/** Rows of an opened entry: elements, or 8-byte lines for strings and .space. */
function rows(e: MemoryEntry) {
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
        const b = Array.from({ length: n }, (_, j) => m.readByte(a + j))
        return { key: a, addr: hex8(a), idx: `+${i * 8}`, hex: b.map((x) => hexN(x, 2).slice(2)).join(' '), value: b.map((x) => charOf(x)).join(' '), flash: hit(a, n) }
      }),
      more: lines - max,
    }
  }
  const step = ELEM[e.kind]
  return {
    bytes: false,
    list: Array.from({ length: Math.min(e.count, max) }, (_, i) => {
      const a = e.addr + i * step
      return { key: a, addr: hex8(a), idx: `[${i}]`, ...elementText(isa, m, e.kind, a), flash: hit(a, step) }
    }),
    more: e.count - max,
  }
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
        <div v-if="open.has(e.key)" class="rows">
          <template v-for="r in [rows(e)]" :key="'r'">
            <div v-for="x in r.list" :key="x.key" class="row mono" :class="{ flash: x.flash, bytes: r.bytes }">
              <span class="muted">{{ x.addr }}</span>
              <span class="muted">{{ x.idx }}</span>
              <span>{{ x.hex }}</span>
              <span class="val">{{ x.value }}</span>
            </div>
            <button v-if="r.more > 0" class="btn more" @click="limit.set(e.key, (limit.get(e.key) ?? PAGE) + PAGE * 4)">{{ t(`再显示一些（还有 ${r.more} 行）`, `Show more (${r.more} rows left)`) }}</button>
          </template>
        </div>
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
.row {
  display: grid;
  grid-template-columns: 88px 44px 100px minmax(0, 1fr);
  gap: 6px;
  padding: 1px 5px;
  font-size: 11.5px;
  border-radius: 4px;
}
.row.bytes {
  grid-template-columns: 88px 36px minmax(150px, auto) minmax(0, 1fr);
}
.row.flash {
  background: var(--bg-danger);
}
.val {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
}
.more {
  margin: 4px;
  font-size: 11.5px;
}
@media (max-width: 420px) {
  .row,
  .row.bytes {
    grid-template-columns: 80px 36px minmax(0, 1fr);
  }
  .row .val {
    grid-column: 3;
  }
}
</style>
