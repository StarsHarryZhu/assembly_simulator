<script setup lang="ts">
/**
 * One instruction word as a row of bit fields, each as wide as its bit count: title and bit range,
 * the bits, then the value and what it means. Operand fields are coloured; fixed fields are grey;
 * fields the instruction ignores are dimmed.
 */
import { t } from '../i18n'
import type { FieldView } from '../../core/isa'

const props = defineProps<{ fields: FieldView[]; compact?: boolean }>()

const bits = (f: FieldView) => (f.value >>> 0).toString(2).padStart(f.hi - f.lo + 1, '0')
function tip(f: FieldView): string {
  const range = f.hi === f.lo ? `${f.hi}` : `${f.hi}–${f.lo}`
  const role = f.fixed ? t('，由指令固定', ', fixed by the instruction') : f.used ? '' : t('，这条指令不用', ', unused by this instruction')
  return t(`${f.title}（第 ${range} 位）${role}：`, `${f.title} (bits ${range})${role}: `) + f.value + (f.meaning ? ' · ' + f.meaning : '')
}
const columns = () => props.fields.map((f) => `minmax(0, ${f.hi - f.lo + 1}fr)`).join(' ')
</script>

<template>
  <div class="bits" :class="{ compact }" :style="{ gridTemplateColumns: columns() }">
    <div
      v-for="f in fields"
      :key="f.name + f.lo"
      class="seg"
      :class="['f-' + f.name, { fixed: f.fixed, off: !f.used }]"
      :title="tip(f)"
    >
      <div class="k">
        <span class="name">{{ f.title }}</span><span class="range">{{ f.hi === f.lo ? f.hi : `${f.hi}–${f.lo}` }}</span>
      </div>
      <div class="b mono">{{ bits(f) }}</div>
      <div class="v mono">
        {{ f.value }}<template v-if="f.meaning"> · {{ f.meaning }}</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bits {
  display: grid;
  gap: 3px;
}
.seg {
  --c: var(--series-1);
  border: 1px solid color-mix(in srgb, var(--c) 45%, var(--border));
  background: color-mix(in srgb, var(--c) 12%, transparent);
  border-radius: 6px;
  padding: 4px 4px 3px;
  min-width: 0;
  text-align: center;
}
.seg.fixed {
  border-style: dashed;
  border-color: var(--border);
  background: var(--surface-3);
}
.seg.off {
  opacity: 0.45;
}
.k {
  display: flex;
  justify-content: space-between;
  gap: 3px;
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.range {
  color: var(--text-muted);
  font-size: 9.5px;
}
.b {
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--c) 70%, var(--text-primary));
  font-weight: 600;
}
.seg.fixed .b {
  color: var(--text-secondary);
}
.v {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.compact .b {
  font-size: 11px;
}
.compact .k,
.compact .v {
  font-size: 9px;
}
.f-op {
  --c: var(--series-6);
}
.f-rs,
.f-fs {
  --c: var(--series-4);
}
.f-rt,
.f-ft,
.f-target {
  --c: var(--series-3);
}
.f-rd,
.f-fd,
.f-imm {
  --c: var(--series-5);
}
.f-shamt,
.f-cc,
.f-code,
.f-fmt {
  --c: var(--series-2);
}
.f-funct,
.f-sub,
.f-co,
.f-nd,
.f-tf {
  --c: var(--series-1);
}
.f-zero {
  --c: var(--text-muted);
}
@media (max-width: 520px) {
  .seg {
    padding: 3px 2px 2px;
  }
  .k {
    font-size: 8px;
  }
  .range {
    display: none;
  }
  .b {
    font-size: 9.5px;
    letter-spacing: -0.02em;
  }
  .v {
    font-size: 8.5px;
  }
}
</style>
