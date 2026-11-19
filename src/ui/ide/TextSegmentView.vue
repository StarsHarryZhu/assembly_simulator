<script setup lang="ts">
/** The assembled text segment: address, machine code, basic instruction and the source line it came from. */
import { t } from '../i18n'
import { computed, nextTick, ref, watch } from 'vue'
import { hex8 } from '../../core/format'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const emit = defineEmits<{ decode: [word: string] }>()
const s = props.handle.session
const v = props.handle.version
const box = ref<HTMLElement | null>(null)

const rows = computed(() => {
  void v.value
  const p = s.result?.program
  if (!p) return null
  return p.instructions.map((i) => ({
    addr: i.addr,
    a: hex8(i.addr),
    w: hex8(i.word),
    basic: i.basic,
    line: i.part === 0 ? i.line : null,
    source: i.part === 0 ? i.source.trim() : '',
    part: i.parts > 1 ? `${i.part + 1}/${i.parts}` : '',
  }))
})

const pc = computed(() => {
  void v.value
  const m = s.machine
  return m && !m.halted ? m.programCounter : null
})

watch(pc, async (addr) => {
  if (addr == null || s.mode === 'running') return
  await nextTick()
  box.value?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div ref="box" class="seg">
    <p v-if="!rows" class="muted small pad">
      {{ t('汇编成功后，这里列出每条真指令的地址和机器码。', 'After a successful assembly, every basic instruction is listed here with its address and machine code.') }}
    </p>
    <table v-else class="mono">
      <thead>
        <tr class="small">
          <th>{{ t('地址', 'Address') }}</th>
          <th>{{ t('机器码', 'Code') }}</th>
          <th>{{ t('真指令', 'Basic') }}</th>
          <th>{{ t('行', 'Line') }}</th>
          <th>{{ t('源码', 'Source') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.addr" :class="{ cur: r.addr === pc }" :title="t('点击在“反汇编”里查看这条指令', 'Click to open this instruction in the disassembler')" @click="emit('decode', `${r.w} @ ${r.a}`)">
          <td class="muted">{{ r.a }}</td>
          <td>{{ r.w }}</td>
          <td class="basic">{{ r.basic }}</td>
          <td class="muted">{{ r.line ?? '' }}</td>
          <td class="src">
            <span v-if="r.part" class="badge">{{ r.part }}</span>
            {{ r.source }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.seg {
  height: 100%;
  overflow: auto;
  background: var(--surface-1);
}
.pad {
  padding: 10px 12px;
  margin: 0;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
th {
  position: sticky;
  top: 0;
  background: var(--surface-2);
  text-align: left;
  font-family: var(--font-sans);
  font-weight: 600;
  color: var(--text-secondary);
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
td {
  padding: 2px 8px;
  white-space: nowrap;
}
tr {
  cursor: pointer;
}
tbody tr:hover {
  background: var(--surface-2);
}
tr.cur {
  background: var(--bg-accent) !important;
  box-shadow: inset 3px 0 var(--accent);
}
.basic {
  color: var(--series-1);
}
.src {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}
.src .badge {
  margin-right: 4px;
}
</style>
