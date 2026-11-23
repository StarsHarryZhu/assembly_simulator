<script setup lang="ts">
/**
 * 反汇编: one machine word per line (0x hex, 0b binary, 32 raw bits, or decimal; optionally "@ address"
 * for branch and jump targets) becomes assembly, bit fields and notes.
 */
import { lang, t } from '../i18n'
import { computed, ref, watch } from 'vue'
import { binGroups, hex8, hexAddr } from '../../core/format'
import type { IsaPlugin } from '../../core/isa'
import { isaKey, load, save } from '../storage'
import BitFields from './BitFields.vue'
import { parseAddress, parseWord } from './values'

const props = defineProps<{ isa: IsaPlugin; request: string | null }>()
const isa = props.isa
const addrBits = isa.layout.addressBits ?? 32
const hexA = (a: number) => hexAddr(a, addrBits)
const key = (k: string) => isaKey(isa.id, k)
const text = ref<string>(load(key('decText'), isa.samples.words))
const baseText = ref<string>(load(key('decBase'), hexA(isa.layout.textBase)))
watch(text, (t) => save(key('decText'), t))
watch(baseText, (b) => save(key('decBase'), b))

watch(
  () => props.request,
  (r) => {
    if (r) text.value = r
  },
  { immediate: true },
)

const EXAMPLES = isa.samples.decoderExamples

const base = computed(() => {
  return parseAddress(baseText.value, addrBits) ?? isa.layout.textBase
})

const results = computed(() => {
  let addr = base.value
  const out = []
  void lang.value
  for (const [i, raw] of text.value.split('\n').entries()) {
    const src = raw.replace(/#.*$/, '').trim()
    if (!src) continue
    const [wordPart, atPart] = src.split('@').map((s) => s.trim())
    if (atPart) {
      const a = parseAddress(atPart, addrBits)
      if (a != null) addr = a
    }
    const word = parseWord(wordPart!)
    if (word == null) {
      out.push({ key: i, src, error: t(
          `看不懂“${wordPart}”：支持 0x 十六进制、0b 二进制、32 个 0/1 或十进制`,
          `Cannot read "${wordPart}": use 0x hex, 0b binary, 32 zeros and ones, or decimal`,
        ), addr, word: 0, view: null })
    } else {
      out.push({ key: i, src, error: null, addr, word: word >>> 0, view: isa.decode(word >>> 0, addr) })
    }
    addr = addrBits === 64 ? addr + 4 : (addr + 4) >>> 0
  }
  return out
})

function add(word: string) {
  text.value = text.value.trim() ? `${text.value.replace(/\s+$/, '')}\n${word}` : word
}
</script>

<template>
  <div class="dec">
    <div class="card box">
      <div class="top">
        <label class="lbl" for="dec-in">
          <b>{{ t('机器码', 'Machine code') }}</b>
          <span class="small muted">{{
            t('每行一条：0x 十六进制、0b 二进制、32 位 0/1 或十进制；行尾可写“@ 地址”', 'One per line: 0x hex, 0b binary, 32 zeros and ones, or decimal; end a line with "@ address" to set its address')
          }}</span>
        </label>
        <label class="small muted base">
          {{ t('第一条的地址', 'First address') }}
          <input v-model.lazy="baseText" class="inp" spellcheck="false" :aria-label="t('第一条指令的地址', 'Address of the first instruction')" />
        </label>
      </div>
      <textarea id="dec-in" v-model="text" class="inp area" rows="5" spellcheck="false" />
      <div class="chips">
        <span class="small muted">{{ t('加一条：', 'Add:') }}</span>
        <button v-for="e in EXAMPLES" :key="e.word" class="chip" :title="e.word" @click="add(e.word)">{{ e.note }}</button>
        <button class="chip" @click="text = ''">{{ t('清空', 'Clear') }}</button>
      </div>
    </div>

    <p v-if="!results.length" class="muted small pad">{{ t('在上面输入机器码。', 'Type machine code above.') }}</p>
    <div v-for="r in results" :key="r.key" class="card box res">
      <template v-if="r.error">
        <span class="mono">{{ r.src }}</span>
        <p class="err small">{{ r.error }}</p>
      </template>
      <template v-else-if="r.view">
        <div class="ih">
          <b class="mono asm" :class="{ bad: !r.view.ok }">{{ r.view.text }}</b>
          <span class="mono hex">{{ hex8(r.word) }}</span>
          <span class="badge">{{ t(`${r.view.format} 格式`, `${r.view.format} format`) }}</span>
          <span class="small muted mono">@ {{ hexA(r.addr) }}</span>
        </div>
        <BitFields :fields="r.view.fields" />
        <div class="bin mono small">
          <span v-for="(g, i) in binGroups(r.word)" :key="i">{{ g }}</span>
          <span class="muted">= {{ r.word }} {{ t('（无符号）', '(unsigned)') }} = {{ r.word | 0 }} {{ t('（有符号）', '(signed)') }}</span>
        </div>
        <ul v-if="r.view.notes.length" class="notes small">
          <li v-for="n in r.view.notes" :key="n">{{ n }}</li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dec {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  max-width: 1100px;
  margin: 0 auto;
}
.box {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.top {
  display: flex;
  gap: 10px;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
}
.lbl {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.base {
  display: flex;
  gap: 6px;
  align-items: center;
}
.base .inp {
  width: 110px;
}
.area {
  font-size: 13.5px;
  line-height: 1.6;
  padding: 6px 10px;
  resize: vertical;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.pad {
  margin: 0;
  padding: 0 4px;
}
.ih {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
}
.asm {
  font-size: 16px;
}
.asm.bad {
  color: var(--danger);
}
.hex {
  font-weight: 600;
}
.err {
  color: var(--danger);
  margin: 0;
}
.bin {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--text-secondary);
}
.notes {
  margin: 0;
  padding-left: 18px;
  color: var(--text-secondary);
}
@media (max-width: 520px) {
  .dec {
    padding: 8px;
  }
}
</style>
