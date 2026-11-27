<script setup lang="ts">
/**
 * A matrix register (SME's ZA) as a grid: one of its tiles for the chosen element size (horizontal slices
 * as rows), or the whole array row by row. Elements the last step changed are marked as the register grid
 * marks registers. Large grids are split into pages of rows so the page never holds more than CELLS cells.
 */
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import type { RegisterSpec } from '../../core/isa'
import { isaKey, load, save } from '../storage'
import { laneText, type LaneFormat } from './lanes'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle; spec: RegisterSpec; size: number; format: LaneFormat }>()
const s = props.handle.session
const v = props.handle.version

/** At most this many cells on screen at once. */
const CELLS = 4096
const LETTERS: Record<number, string> = { 1: 'b', 2: 'h', 4: 's', 8: 'd', 16: 'q' }

/** The tile shown (-1: the whole array), remembered per ISA; and the page of rows. */
const tile = ref<number>(load(isaKey(s.isa.id, 'matrixTile'), 0))
const page = ref(0)
function pick(n: number) {
  tile.value = n
  page.value = 0
  save(isaKey(s.isa.id, 'matrixTile'), n)
}
watch(
  () => props.size,
  () => (page.value = 0),
)

const grid = computed(() => {
  void v.value
  const m = s.machine
  const bytes = m?.readRegisterBytes?.(props.spec.id) ?? new Uint8Array(0)
  const n = Math.round(Math.sqrt(bytes.length))
  const size = Math.min(props.size, n || 1)
  const tiles = size
  const t0 = tile.value >= tiles ? 0 : tile.value
  // Bytes the last step changed: compare the rows it wrote with what they held before.
  const changed = new Set<number>()
  const wrote = s.mode !== 'running' && s.last?.writes.some((w) => w.id === props.spec.id)
  if (m && wrote)
    for (const { row, before } of m.lastRowWrites?.(props.spec.id) ?? [])
      for (let k = 0; k < n; k++) if (before[k] !== bytes[row * n + k]) changed.add(row * n + k)
  // Rows on screen: ZA rows of the tile (i × size + t) or every row.
  const rowsAll = t0 < 0 ? Array.from({ length: n }, (_, r) => r) : Array.from({ length: n / size }, (_, i) => i * size + t0)
  const cols = n / size
  const perPage = Math.max(1, Math.floor(CELLS / Math.max(cols, 1)))
  const pages = Math.max(1, Math.ceil(rowsAll.length / perPage))
  const p = Math.min(page.value, pages - 1)
  const rows = rowsAll.slice(p * perPage, (p + 1) * perPage).map((r, k) => ({
    label: p * perPage + k,
    row: r,
    cells: Array.from({ length: cols }, (_, j) => {
      const at = r * n + j * size
      let now = false
      for (let b = at; b < at + size && !now; b++) now = changed.has(b)
      return { text: laneText(bytes, at, size, props.format), now }
    }),
  }))
  return { n, size, tiles, tile: t0, cols, rows, pages, page: p, first: p * perPage, total: rowsAll.length, changed: changed.size > 0 }
})

const tileName = (k: number) => `${props.spec.name}${k}.${LETTERS[grid.value.size] ?? ''}`
</script>

<template>
  <div class="mx">
    <div v-if="grid.n === 0" class="small muted">{{ t('程序还没运行', 'The program has not started') }}</div>
    <template v-else>
      <div class="tiles">
        <span class="small muted">{{ t('显示', 'Show') }}</span>
        <button class="chip mono" :aria-pressed="grid.tile < 0" @click="pick(-1)">{{ t('整个阵列', 'whole array') }}</button>
        <button v-for="k in grid.tiles" :key="k" class="chip mono" :aria-pressed="grid.tile === k - 1" @click="pick(k - 1)">{{ tileName(k - 1) }}</button>
      </div>
      <div class="small muted">
        {{
          grid.tile < 0
            ? t(`${grid.n} 行，每行 ${grid.cols} 个元素；第 r 行是 ZA 的第 r 行`, `${grid.n} rows of ${grid.cols} elements; row r is ZA row r`)
            : t(
                `${grid.cols} × ${grid.cols} 的 tile：第 i 行是水平切片 ${tileName(grid.tile)}[i]（ZA 第 i × ${grid.size} + ${grid.tile} 行），第 j 列是竖直切片`,
                `A ${grid.cols} × ${grid.cols} tile: row i is the horizontal slice ${tileName(grid.tile)}[i] (ZA row i × ${grid.size} + ${grid.tile}), column j the vertical slice`,
              )
        }}
        <span v-if="grid.changed" class="now-note">{{ t('红色：上一步改的元素', 'Red: elements the last step changed') }}</span>
      </div>
      <div class="scroll">
        <table class="mono">
          <thead>
            <tr>
              <th />
              <th v-for="j in grid.cols" :key="j">{{ j - 1 }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in grid.rows" :key="r.row">
              <th :title="t(`ZA 第 ${r.row} 行`, `ZA row ${r.row}`)">{{ r.label }}</th>
              <td v-for="(c, j) in r.cells" :key="j" :class="{ now: c.now }">{{ c.text }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="grid.pages > 1" class="pager small">
        <button class="btn" :disabled="grid.page === 0" @click="page = grid.page - 1">{{ t('上一页', 'Previous') }}</button>
        <span class="muted">{{ t(`第 ${grid.first}–${grid.first + grid.rows.length - 1} 行，共 ${grid.total} 行`, `Rows ${grid.first}–${grid.first + grid.rows.length - 1} of ${grid.total}`) }}</span>
        <button class="btn" :disabled="grid.page === grid.pages - 1" @click="page = grid.page + 1">{{ t('下一页', 'Next') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mx {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.tiles {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.now-note {
  color: var(--danger);
  margin-left: 6px;
}
.scroll {
  overflow: auto;
  max-height: 340px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
table {
  border-collapse: collapse;
  font-size: 11px;
}
th,
td {
  padding: 1px 6px;
  text-align: right;
  white-space: nowrap;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
th {
  position: sticky;
  background: var(--surface-2);
  color: var(--text-muted);
  font-weight: 500;
}
thead th {
  top: 0;
  z-index: 1;
}
tbody th {
  left: 0;
}
thead th:first-child {
  left: 0;
  z-index: 2;
}
td.now {
  background: color-mix(in srgb, var(--danger) 28%, transparent);
  color: var(--text-primary);
  font-weight: 700;
}
.pager {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pager .btn {
  padding: 1px 8px;
}
</style>
