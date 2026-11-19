<script setup lang="ts">
/**
 * Every register in one grid, coloured by what the program has done to it so far: grey = not used,
 * green = read, red = written. Registers the last step wrote stay highlighted until the next step.
 * Clicking a cell opens its details (hex, binary, signed, unsigned, ASCII, float) under the grid.
 */
import { t, tx } from '../i18n'
import { computed, ref } from 'vue'
import { asciiOfWord, binGroups, doubleFromBits, floatFromBits, hex8, javaDouble, javaFloat } from '../../core/format'
import { READ, WRITTEN, type RegisterSpec, type RegValue } from '../../core/isa'
import { load, save } from '../storage'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const s = props.handle.session
const v = props.handle.version
const isa = s.isa

const banks = isa.registers
const bank = ref<string>(load('regBank', banks[0]!.id))
if (!banks.some((b) => b.id === bank.value)) bank.value = banks[0]!.id
const selected = ref<number | null>(null)
const specs = new Map<number, RegisterSpec>()
for (const b of banks) for (const r of b.registers) specs.set(r.id, r)

const num = (x: RegValue) => (typeof x === 'bigint' ? Number(BigInt.asIntN(32, x)) : x)

function pickBank(id: string) {
  bank.value = id
  save('regBank', id)
}

const view = computed(() => {
  void v.value
  const m = s.machine
  const last = s.mode === 'running' ? null : s.last
  const wrote = new Map<number, { before: number; after: number }>()
  for (const w of last?.writes ?? []) wrote.set(w.id, { before: num(w.before), after: num(w.after) })
  const current = banks.find((b) => b.id === bank.value) ?? banks[0]!
  const cells = current.registers
    .filter((r) => !r.untracked)
    .map((r) => {
      const value = m ? num(m.readRegister(r.id)) : 0
      const status = m ? m.registerStatus(r.id) : 0
      return {
        spec: r,
        value,
        text: r.kind === 'flag' ? String(value & 1) : hex8(value),
        cls: status === WRITTEN ? 'w' : status === READ ? 'r' : 'i',
        now: wrote.has(r.id),
      }
    })
  const counts = new Map<string, number>()
  for (const b of banks) {
    let n = 0
    if (m) for (const r of b.registers) if (!r.untracked && m.registerStatus(r.id) === WRITTEN) n++
    counts.set(b.id, n)
  }
  return { cells, pc: m ? hex8(num(m.readRegister(isa.pcRegister))) : '—', counts, wrote }
})

const detail = computed(() => {
  void v.value
  const id = selected.value
  if (id == null) return null
  const spec = specs.get(id)
  if (!spec) return null
  const m = s.machine
  const value = m ? num(m.readRegister(id)) : 0
  const rows: { k: string; v: string }[] = [
    { k: t('有符号', 'Signed'), v: String(value | 0) },
    { k: t('无符号', 'Unsigned'), v: String(value >>> 0) },
    { k: 'ASCII', v: asciiOfWord(value) },
  ]
  if (spec.kind === 'float') {
    rows.unshift({ k: t('单精度', 'Single'), v: javaFloat(floatFromBits(value)) })
    if (spec.number != null && spec.number % 2 === 0 && m) {
      const high = num(m.readRegister(id + 1))
      rows.splice(1, 0, { k: t(`双精度（和 $f${spec.number + 1}）`, `Double (with $f${spec.number + 1})`), v: javaDouble(doubleFromBits(value, high)) })
    }
  }
  const w = view.value.wrote.get(id)
  return {
    spec,
    hex: hex8(value),
    groups: binGroups(value),
    rows,
    change: w ? `${hex8(w.before)} → ${hex8(w.after)}` : null,
    status: m ? m.registerStatus(id) : 0,
  }
})

function toggle(id: number) {
  selected.value = selected.value === id ? null : id
}
</script>

<template>
  <section class="card panel regs" :aria-label="t('寄存器', 'Registers')">
    <header class="head">
      <h3>{{ t('寄存器', 'Registers') }}</h3>
      <span class="pc small">pc <b class="mono">{{ view.pc }}</b></span>
      <span class="legend small">
        <i class="dot i" />{{ t('未用', 'unused') }} <i class="dot r" />{{ t('读过', 'read') }} <i class="dot w" />{{ t('改过', 'written') }}
      </span>
    </header>
    <div class="banks" role="tablist" :aria-label="t('寄存器组', 'Register banks')">
      <button v-for="b in banks" :key="b.id" class="chip" role="tab" :aria-pressed="bank === b.id" :aria-selected="bank === b.id" @click="pickBank(b.id)">
        {{ tx(b.title) }}<span v-if="view.counts.get(b.id)" class="cnt">{{ view.counts.get(b.id) }}</span>
      </button>
    </div>
    <div class="grid">
      <button
        v-for="c in view.cells"
        :key="c.spec.id"
        class="cell"
        :class="[c.cls, { now: c.now, sel: selected === c.spec.id }]"
        :title="(c.spec.note ? tx(c.spec.note) : '') + (c.now ? t('（上一步改了它）', ' (changed by the last step)') : '')"
        :aria-pressed="selected === c.spec.id"
        @click="toggle(c.spec.id)"
      >
        <span class="n mono">{{ c.spec.name }}<small v-if="c.spec.number != null && c.spec.kind === 'int'">{{ c.spec.number }}</small></span>
        <span class="val mono">{{ c.text }}</span>
      </button>
    </div>
    <div v-if="detail" class="detail">
      <div class="dh">
        <b class="mono">{{ detail.spec.name }}</b>
        <span class="small muted">{{ detail.spec.note ? tx(detail.spec.note) : '' }}</span>
        <span class="badge" :class="{ err: detail.status === 2 }" :style="detail.status === 1 ? 'background:var(--bg-success);color:var(--success)' : ''">{{
          detail.status === 2 ? t('改过', 'written') : detail.status === 1 ? t('读过', 'read') : t('未用', 'unused')
        }}</span>
        <button class="btn x" @click="selected = null">{{ t('收起', 'Close') }}</button>
      </div>
      <div class="hex mono">{{ detail.hex }}</div>
      <div v-if="detail.change" class="small mono changed">{{ t('本步：', 'This step: ') }}{{ detail.change }}</div>
      <div class="bits mono">
        <span v-for="(g, i) in detail.groups" :key="i" class="byte">
          <span class="b">{{ g }}</span>
          <small>{{ 31 - i * 8 }}…{{ 24 - i * 8 }}</small>
        </span>
      </div>
      <dl class="rows">
        <template v-for="r in detail.rows" :key="r.k">
          <dt>{{ r.k }}</dt>
          <dd class="mono">{{ r.v }}</dd>
        </template>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
.pc b {
  font-size: 12.5px;
  color: var(--accent);
}
.legend {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
}
.dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 3px;
  margin-left: 6px;
  border: 1px solid var(--border);
}
.dot.i {
  background: var(--surface-2);
}
.dot.r {
  background: var(--bg-success);
  border-color: var(--success);
}
.dot.w {
  background: var(--bg-danger);
  border-color: var(--danger);
}
.banks {
  display: flex;
  gap: 4px;
}
.banks .chip {
  font-family: var(--font-sans);
  display: flex;
  gap: 4px;
  align-items: center;
}
.cnt {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 10px;
  background: var(--bg-danger);
  color: var(--danger);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(98px, 1fr));
  gap: 4px;
}
.cell {
  appearance: none;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: var(--surface-2);
  cursor: pointer;
  min-width: 0;
  color: var(--text-muted);
}
.cell .n {
  font-size: 10.5px;
  display: flex;
  justify-content: space-between;
}
.cell .n small {
  opacity: 0.7;
}
.cell .val {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell.r {
  background: var(--bg-success);
  border-color: color-mix(in srgb, var(--success) 55%, transparent);
  color: var(--text-primary);
}
.cell.r .n {
  color: var(--success);
}
.cell.w {
  background: var(--bg-danger);
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
  color: var(--text-primary);
}
.cell.w .n {
  color: var(--danger);
}
.cell.sel {
  outline: 2px solid var(--accent);
  outline-offset: 0;
}
/* Written by the last step: a steady, stronger red until the next step. */
.cell.now {
  background: color-mix(in srgb, var(--danger) 28%, transparent);
  border-color: var(--danger);
  box-shadow: inset 0 0 0 1px var(--danger);
}
.cell.now .val {
  font-weight: 700;
}
.detail {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dh {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.x {
  margin-left: auto;
  padding: 1px 8px;
  font-size: 11.5px;
}
.hex {
  font-size: 17px;
  font-weight: 600;
}
.changed {
  color: var(--danger);
}
.bits {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}
.byte {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3px 2px;
  border-radius: 5px;
  background: var(--surface-2);
}
.byte .b {
  font-size: 12px;
  letter-spacing: 0.04em;
}
.byte small {
  font-size: 9.5px;
  color: var(--text-muted);
}
.rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 12.5px;
}
.rows dt {
  color: var(--text-muted);
}
.rows dd {
  margin: 0;
  word-break: break-all;
}
</style>
