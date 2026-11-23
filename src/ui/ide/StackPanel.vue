<script setup lang="ts">
/**
 * The stack from the stack pointer to the stack base: the top few slots (one word each, of the ISA's word
 * size) by default, all of it when expanded. Marks where the stack and frame pointers point and highlights
 * slots the last step wrote.
 */
import { lang, t } from '../i18n'
import { computed, ref } from 'vue'
import { hexAddr, hexBits, signedText } from '../../core/format'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const s = props.handle.session
const v = props.handle.version
const isa = s.isa
const TOP = 8
const MAX_ROWS = 4096
const expanded = ref(false)
const bits = isa.layout.addressBits ?? 32
const hexA = (a: number) => hexAddr(a, bits)
/** Unsigned 32-bit numbers in a 32-bit address space; addresses as they are in a 64-bit one. */
const u = bits === 64 ? (a: number) => a : (a: number) => a >>> 0
const nameOf = (id: number | undefined) => isa.registers.flatMap((b) => b.registers).find((r) => r.id === id)?.name ?? ''
const spName = nameOf(isa.spRegister)
const fpName = nameOf(isa.fpRegister)
const word = isa.layout.wordSize
/** What one slot is called: MIPS has always said "word". */
const unit = (n: number) => (word === 4 ? t(`${n} 个 word`, `${n} words`) : t(`${n} 个 ${word} 字节的格`, `${n} slots of ${word} bytes`))
const moreText = (n: number) => (word === 4 ? t(`还有 ${n} 个 word 没显示`, `${n} more words not shown`) : t(`还有 ${n} 格没显示`, `${n} more slots not shown`))

const view = computed(() => {
  void v.value
  const m = s.machine
  if (!m) return null
  const base = u(isa.layout.stackBase)
  const sp = u(Number(m.readRegister(isa.spRegister)))
  const fp = isa.fpRegister != null ? u(Number(m.readRegister(isa.fpRegister))) : null
  const depth = sp <= base && sp % word === 0 ? (base - sp) / word : 0
  const shown = Math.min(depth, expanded.value ? MAX_ROWS : TOP)
  const touched = new Set<number>()
  if (s.mode !== 'running')
    for (const c of s.last?.memory ?? []) {
      // Unsigned: a kernel address such as 0x90000000 must not turn negative.
      const start = u(c.addr)
      for (let a = start - (start % word); a < start + c.size; a += word) touched.add(a)
    }
  const rows = Array.from({ length: shown }, (_, i) => {
    const addr = u(sp + i * word)
    const val = word === 8 ? (BigInt(m.readWord(addr + 4) >>> 0) << 32n) | BigInt(m.readWord(addr) >>> 0) : m.readWord(addr)
    return {
      addr,
      off: i * word,
      hex: hexBits(val, word * 8),
      dec: signedText(val, word * 8),
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
        {{ spName }} <b class="mono">{{ hexA(view.sp) }}</b> · {{ unit(view.depth) }}
      </span>
      <button v-if="view && view.depth > 8" class="btn more" @click="expanded = !expanded">
        {{ expanded ? t('只看栈顶', 'Top only') : t(`展开全部 ${view.depth} 个`, `Show all ${view.depth}`) }}
      </button>
    </header>
    <p v-if="!view" class="muted small empty">{{ t('汇编成功后显示。', 'Shown after a successful assembly.') }}</p>
    <p v-else-if="view.odd" class="muted small empty">{{ t(`${spName}（${hexA(view.sp)}）不在栈里，没法显示。`, `${spName} (${hexA(view.sp)}) is not inside the stack, so there is nothing to show.`) }}</p>
    <p v-else-if="!view.depth" class="muted small empty">
      <template v-if="lang === 'en'">
        The stack is empty: {{ spName }} is still at the stack base {{ hexA(view.base) }}. After something like <code>{{ isa.samples.push }}</code>, whatever
        is pushed shows up here.
      </template>
      <template v-else>栈是空的：{{ spName }} 还在栈底 {{ hexA(view.base) }}。执行 <code>{{ isa.samples.push }}</code> 之类的指令后，压进去的内容会显示在这里。</template>
    </p>
    <div v-else class="table" :class="{ scroll: expanded }" :style="{ '--addr': bits === 64 ? '150px' : '92px', '--addr-narrow': bits === 64 ? '140px' : '84px' }">
      <div class="row th small muted">
        <span>{{ t('地址', 'Address') }}</span><span>{{ t('位置', 'Offset') }}</span><span>{{ t('十六进制', 'Hex') }}</span><span>{{ t('十进制', 'Decimal') }}</span>
      </div>
      <div v-for="r in view.rows" :key="r.addr" class="row mono" :class="{ flash: r.flash, top: r.sp }">
        <span class="a">{{ hexA(r.addr) }}</span>
        <span class="o">
          <template v-if="r.sp"><b class="tag sp">{{ spName }}</b></template>
          <template v-else>{{ spName }}+{{ r.off }}</template>
          <b v-if="r.fp" class="tag fp">{{ fpName }}</b>
        </span>
        <span class="h">{{ r.hex }}<i v-if="r.ever" class="ever" :title="t('程序写过这个位置', 'The program wrote here')" /></span>
        <span class="d">{{ r.dec }}</span>
      </div>
      <div v-if="view.more > 0" class="small muted foot">{{ moreText(view.more) }}{{ expanded ? t('（只显示前 4096 个）', ' (only the first 4096 are shown)') : '' }}</div>
      <div class="small muted foot">{{ isa.layout.stackGrowsDown ? t(`栈底 ${hexA(view.base)}（栈向低地址增长）`, `Stack base ${hexA(view.base)} (the stack grows toward lower addresses)`) : t(`栈底 ${hexA(view.base)}`, `Stack base ${hexA(view.base)}`) }}</div>
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
  grid-template-columns: var(--addr) minmax(70px, 1fr) var(--addr) minmax(60px, 1fr);
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
    grid-template-columns: var(--addr-narrow) minmax(52px, 1fr) var(--addr-narrow);
  }
  .row .d,
  .row.th span:last-child {
    display: none;
  }
}
</style>
