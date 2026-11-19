<script setup lang="ts">
/**
 * One reference table under the instruction set tab's title card (syscall services, coprocessor 0
 * registers, exception codes, floating-point flags, directives). Rows that list registers get two
 * columns, read (green) and written (red), as in the register panel; other rows get one column of text
 * with their note and example. `current` highlights one row. Below about 620 px of width each row folds
 * into a small card.
 */
import { computed } from 'vue'
import type { ReferenceTable } from '../../core/isa'
import { t, tx } from '../i18n'

const props = defineProps<{ table: ReferenceTable; current?: string }>()
const withRegs = computed(() => props.table.groups.some((g) => g.rows.some((r) => r.args || r.results)))
const columns = computed(() => (withRegs.value ? 4 : 3))
const keyParts = (key: string) => key.split(/\s+/)
</script>

<template>
  <section class="card ref" :aria-label="tx(table.title)">
    <b class="title">{{ tx(table.title) }}</b>
    <p class="intro">{{ tx(table.intro) }}</p>
    <table>
      <thead>
        <tr>
          <th class="key">{{ tx(table.keyTitle) }}</th>
          <th>{{ t('名称', 'Name') }}</th>
          <template v-if="withRegs">
            <th>{{ t('参数（读取）', 'Arguments (read)') }}</th>
            <th>{{ t('结果（写入）', 'Results (written)') }}</th>
          </template>
          <th v-else>{{ t('说明', 'Meaning') }}</th>
        </tr>
      </thead>
      <tbody v-for="(g, gi) in table.groups" :key="gi">
        <tr v-if="g.title" class="group">
          <th :colspan="columns" scope="colgroup">{{ tx(g.title) }}</th>
        </tr>
        <tr v-for="row in g.rows" :key="row.key" class="row" :class="{ current: row.key === current }" :aria-current="row.key === current ? 'true' : undefined">
          <td class="key mono">
            <span v-for="k in keyParts(row.key)" :key="k">{{ k }}</span>
          </td>
          <td class="name">
            <span>{{ tx(row.title) }}</span>
            <span v-if="row.note && withRegs" class="note">{{ tx(row.note) }}</span>
          </td>
          <template v-if="withRegs">
            <td class="cell" :class="{ empty: !row.args?.length }" :data-label="t('参数', 'Arguments')">
              <div v-for="a in row.args" :key="a.reg" class="reg">
                <span class="chip-reg read mono">{{ a.reg }}</span>
                <span>{{ tx(a.text) }}</span>
              </div>
              <span v-if="!row.args?.length" class="muted">—</span>
            </td>
            <td class="cell" :class="{ empty: !row.results?.length }" :data-label="t('结果', 'Results')">
              <div v-for="r in row.results" :key="r.reg" class="reg">
                <span class="chip-reg write mono">{{ r.reg }}</span>
                <span>{{ tx(r.text) }}</span>
              </div>
              <span v-if="!row.results?.length" class="muted">—</span>
            </td>
          </template>
          <td v-else class="cell text">
            <span v-if="row.text">{{ tx(row.text) }}</span>
            <span v-if="row.note" class="note">{{ tx(row.note) }}</span>
            <pre v-if="row.example" class="example mono">{{ row.example }}</pre>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.ref {
  padding: 12px 14px;
  container-type: inline-size;
  min-width: 0;
}
.title {
  font-size: 14px;
}
.intro {
  margin: 4px 0 8px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  line-height: 1.5;
}
thead th {
  text-align: left;
  font-weight: 600;
  font-size: 11.5px;
  color: var(--text-muted);
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.group th {
  text-align: left;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--surface-2);
  padding: 5px 8px;
}
.row td {
  padding: 6px 8px;
  vertical-align: top;
  border-bottom: 1px solid var(--border);
}
.key {
  width: 1%;
  white-space: nowrap;
}
td.key {
  font-weight: 600;
  color: var(--accent);
}
td.key span {
  display: block;
}
.name {
  width: 22%;
  font-weight: 500;
}
.note {
  display: block;
  margin-top: 2px;
  font-weight: 400;
  font-size: 11.5px;
  color: var(--text-muted);
}
.cell {
  color: var(--text-secondary);
}
.row.current td {
  background: var(--bg-accent);
}
.example {
  margin: 4px 0 0;
  padding: 3px 7px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--surface-2);
  border-radius: 5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  width: fit-content;
  max-width: 100%;
}
.reg {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.reg + .reg {
  margin-top: 3px;
}
.chip-reg {
  flex: none;
  font-size: 11.5px;
  padding: 0 5px;
  border-radius: 4px;
}
.chip-reg.read {
  background: var(--bg-success);
  color: var(--success);
}
.chip-reg.write {
  background: var(--bg-danger);
  color: var(--danger);
}

/* Narrow: each row becomes a small card, the key on the left. */
@container (max-width: 620px) {
  thead {
    display: none;
  }
  tbody,
  .group,
  .group th {
    display: block;
  }
  .row.current {
    background: var(--bg-accent);
  }
  .row.current td {
    background: none;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(2.4em, max-content) minmax(0, 1fr);
    column-gap: 10px;
    row-gap: 4px;
    padding: 7px 4px;
    border-bottom: 1px solid var(--border);
  }
  .row td {
    padding: 0;
    border: 0;
    width: auto;
  }
  td.key {
    grid-row: span 3;
    text-align: right;
  }
  .cell {
    grid-column: 2;
  }
  .cell.empty {
    display: none;
  }
  .cell[data-label]::before {
    content: attr(data-label);
    display: block;
    font-size: 11px;
    color: var(--text-muted);
  }
}
</style>
