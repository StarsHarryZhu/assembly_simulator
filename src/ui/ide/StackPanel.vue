<script setup lang="ts">
/**
 * The stack from the stack pointer to the stack base: the top few words by default, all of it when
 * expanded. Marks where $sp and $fp point and highlights words the last step wrote.
 */
import { lang, t } from '../i18n'
import { computed, ref } from 'vue'
import { hex8 } from '../../core/format'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const s = props.handle.session
const v = props.handle.version
const isa = s.isa
const TOP = 8
const MAX_ROWS = 4096
const expanded = ref(false)

const view = computed(() => {
  void v.value
  const m = s.machine
  if (!m) return null
  const word = isa.layout.wordSize
  const base = isa.layout.stackBase >>> 0
  const sp = Number(m.readRegister(isa.spRegister)) >>> 0
  const fp = isa.fpRegister != null ? Number(m.readRegister(isa.fpRegister)) >>> 0 : null
  const depth = sp <= base && sp % word === 0 ? (base - sp) / word : 0
  const shown = Math.min(depth, expanded.value ? MAX_ROWS : TOP)
  const touched = new Set<number>()
  if (s.mode !== 'running')
    for (const c of s.last?.memory ?? []) {
      // Unsigned: a kernel address such as 0x90000000 must not turn negative.
      const start = c.addr >>> 0
      for (let a = (start - (start % word)) >>> 0; a < start + c.size; a += word) touched.add(a)
    }
  const rows = Array.from({ length: shown }, (_, i) => {
    const addr = (sp + i * word) >>> 0
    const val = m.readWord(addr)
    return {
      addr,
      off: i * word,
      hex: hex8(val),
      dec: String(val | 0),
      sp: i === 0,
      fp: fp === addr,
      flash: touched.has(addr),
      ever: m.everWritten(addr),
    }
  })
  return { sp, fp, base, depth, rows, more: depth - shown, odd: sp > base || sp % word !== 0 }
})
</script>

<template>
  <section class="card panel" :aria-label="t('栈', 'Stack')">
    <header class="head">
      <h3>{{ t('栈', 'Stack') }}</h3>
      <span v-if="view" class="small muted">
        $sp <b class="mono">{{ hex8(view.sp) }}</b> · {{ t(`${view.depth} 个 word`, `${view.depth} words`) }}
      </span>
      <button v-if="view && view.depth > 8" class="btn more" @click="expanded = !expanded">
        {{ expanded ? t('只看栈顶', 'Top only') : t(`展开全部 ${view.depth} 个`, `Show all ${view.depth}`) }}
      </button>
    </header>
    <p v-if="!view" class="muted small empty">{{ t('汇编成功后显示。', 'Shown after a successful assembly.') }}</p>
    <p v-else-if="view.odd" class="muted small empty">{{ t(`$sp（${hex8(view.sp)}）不在栈里，没法显示。`, `$sp (${hex8(view.sp)}) is not inside the stack, so there is nothing to show.`) }}</p>
    <p v-else-if="!view.depth" class="muted small empty">
      <template v-if="lang === 'en'">
        The stack is empty: $sp is still at the stack base {{ hex8(view.base) }}. After something like <code>addi $sp, $sp, -4</code>, whatever
        is pushed shows up here.
      </template>
      <template v-else>栈是空的：$sp 还在栈底 {{ hex8(view.base) }}。执行 <code>addi $sp, $sp, -4</code> 之类的指令后，压进去的内容会显示在这里。</template>
    </p>
    <div v-else class="table" :class="{ scroll: expanded }">
      <div class="row th small muted">
        <span>{{ t('地址', 'Address') }}</span><span>{{ t('位置', 'Offset') }}</span><span>{{ t('十六进制', 'Hex') }}</span><span>{{ t('十进制', 'Decimal') }}</span>
      </div>
      <div v-for="r in view.rows" :key="r.addr" class="row mono" :class="{ flash: r.flash, top: r.sp }">
        <span class="a">{{ hex8(r.addr) }}</span>
        <span class="o">
          <template v-if="r.sp"><b class="tag sp">$sp</b></template>
          <template v-else>$sp+{{ r.off }}</template>
          <b v-if="r.fp" class="tag fp">$fp</b>
        </span>
        <span class="h">{{ r.hex }}<i v-if="r.ever" class="ever" :title="t('程序写过这个位置', 'The program wrote here')" /></span>
        <span class="d">{{ r.dec }}</span>
      </div>
      <div v-if="view.more > 0" class="small muted foot">{{ t(`还有 ${view.more} 个 word 没显示`, `${view.more} more words not shown`) }}{{ expanded ? t('（只显示前 4096 个）', ' (only the first 4096 are shown)') : '' }}</div>
      <div class="small muted foot">{{ t(`栈底 ${hex8(view.base)}（栈向低地址增长）`, `Stack base ${hex8(view.base)} (the stack grows toward lower addresses)`) }}</div>
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
.more {
  margin-left: auto;
  padding: 1px 8px;
  font-size: 11.5px;
}
.empty {
  margin: 0;
}
code {
  font-family: var(--font-mono);
  background: var(--surface-2);
  padding: 0 4px;
  border-radius: 4px;
}
.table {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.table.scroll {
  max-height: 360px;
  overflow: auto;
}
.row {
  display: grid;
  grid-template-columns: 92px minmax(70px, 1fr) 92px minmax(60px, 1fr);
  gap: 6px;
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 12px;
  align-items: center;
}
.row.th {
  font-family: var(--font-sans);
  position: sticky;
  top: 0;
  background: var(--surface-1);
}
.row:not(.th):nth-child(even) {
  background: var(--surface-2);
}
.row.top {
  box-shadow: inset 3px 0 var(--accent);
}
.row.flash {
  background: var(--bg-danger) !important;
  animation: flash 0.9s ease-out;
}
@keyframes flash {
  0% {
    box-shadow: inset 0 0 0 2px var(--danger);
  }
  100% {
    box-shadow: none;
  }
}
.a {
  color: var(--text-muted);
}
.o {
  color: var(--text-secondary);
  display: flex;
  gap: 4px;
  align-items: center;
}
.tag {
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 4px;
  font-weight: 600;
}
.tag.sp {
  background: var(--bg-accent);
  color: var(--accent);
}
.tag.fp {
  background: var(--bg-warning);
  color: var(--warning);
}
.h {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ever {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
  display: inline-block;
}
.d {
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
}
.foot {
  padding: 2px 6px;
}
@media (max-width: 420px) {
  .row {
    grid-template-columns: 84px minmax(52px, 1fr) 84px;
  }
  .row .d,
  .row.th span:last-child {
    display: none;
  }
}
</style>
