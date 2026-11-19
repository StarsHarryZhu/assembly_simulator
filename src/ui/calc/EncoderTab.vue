<script setup lang="ts">
/**
 * Instruction set tab: pick an instruction (or type a line), set its operands, and see the machine code as bit
 * fields. Pseudo-instructions show every basic instruction they expand to. Below, a demo runs the line.
 */
import type { Text } from '../../core/i18n'
import { lang, t, tx } from '../i18n'
import { plainDesc } from '../ide/editor'
import { computed, reactive, ref, watch } from 'vue'
import { binGroups, hex8 } from '../../core/format'
import type { CatalogEntry, IsaPlugin } from '../../core/isa'
import { load, save } from '../storage'
import BitFields from './BitFields.vue'
import DemoRunner from './DemoRunner.vue'
import { parseWord } from './values'

const props = defineProps<{ isa: IsaPlugin; request?: { line: string; n: number } | null }>()
const emit = defineEmits<{ consumed: [n: number] }>()
const isa = props.isa

const group = ref<string>(load('calcGroup', 'all'))
const query = ref('')
const line = ref<string>(load('calcLine', 'add $t0, $t1, $t2'))
const atText = ref<string>(load('calcAt', hex8(isa.layout.textBase)))
const labelAddrs = reactive<Record<string, number>>({})
watch(group, (g) => save('calcGroup', g))
watch(line, (l) => save('calcLine', l))
watch(atText, (a) => save('calcAt', a))

// A line opened from the editor replaces the saved one; the label addresses start from scratch. The tab
// is re-created whenever it is shown, so tell the app the request was used: a remount must keep later edits.
watch(
  () => props.request,
  (r) => {
    if (!r) return
    line.value = r.line
    for (const name of Object.keys(labelAddrs)) delete labelAddrs[name]
    emit('consumed', r.n)
  },
  { immediate: true },
)

const at = computed(() => {
  const v = parseWord(atText.value)
  return v == null ? isa.layout.textBase : ((v >>> 0) & ~3) >>> 0
})

// Reading lang makes a language switch re-run the analysis, whose messages are localized.
const analysis = computed(() => (void lang.value, isa.analyzeLine(line.value, { at: at.value, labels: { ...labelAddrs } })))

const descOf = new Map<string, Text>()
for (const e of isa.catalog) if (!e.pseudo && !descOf.has(e.mnemonic)) descOf.set(e.mnemonic, e.description)

const mnemonics = computed(() => {
  const q = query.value.trim().toLowerCase()
  const seen = new Map<string, CatalogEntry>()
  for (const e of isa.catalog) {
    if (group.value !== 'all' && e.group !== group.value) continue
    if (q && !e.mnemonic.includes(q) && !e.description.zh.includes(q) && !e.description.en.toLowerCase().includes(q)) continue
    if (!seen.has(e.mnemonic)) seen.set(e.mnemonic, e)
  }
  return [...seen.values()]
})

const forms = computed(() => isa.catalog.filter((e) => e.mnemonic === analysis.value.mnemonic))

const groupTitle = (id: string) => {
  const g = isa.catalogGroups.find((x) => x.id === id)
  return g ? tx(g.title) : id
}

function pick(e: CatalogEntry) {
  line.value = e.example
}

function setOperand(i: number, text: string) {
  const a = analysis.value
  if (!a.entry) return
  const texts = a.operands.map((o) => o.text)
  texts[i] = text.trim()
  line.value = isa.buildLine(a.entry.key, texts)
}

function setLabel(name: string, text: string) {
  const v = parseWord(text)
  if (v != null) labelAddrs[name] = v >>> 0
}

const totalWords = computed(() => analysis.value.instructions.map((i) => hex8(i.word)).join(' '))
</script>

<template>
  <div class="calc">
    <aside class="picker card">
      <div class="chips groups" role="radiogroup" :aria-label="t('指令分类', 'Instruction groups')">
        <button class="chip" :aria-pressed="group === 'all'" @click="group = 'all'">{{ t('全部', 'All') }}</button>
        <button v-for="g in isa.catalogGroups" :key="g.id" class="chip" :aria-pressed="group === g.id" @click="group = g.id">{{ tx(g.title) }}</button>
      </div>
      <input v-model="query" class="inp search" type="search" :placeholder="t('搜索指令或说明，如 sll、乘法', 'Search instructions or descriptions, e.g. sll, multiply')"
        spellcheck="false"
        :aria-label="t('搜索指令', 'Search instructions')"
      />
      <div class="list" role="listbox" :aria-label="t('指令', 'Instructions')">
        <button
          v-for="e in mnemonics"
          :key="e.key"
          class="chip mn"
          role="option"
          :aria-selected="analysis.mnemonic === e.mnemonic"
          :aria-pressed="analysis.mnemonic === e.mnemonic"
          :title="plainDesc(e.description)"
          @click="pick(e)"
        >
          {{ e.mnemonic }}
        </button>
        <p v-if="!mnemonics.length" class="small muted">{{ t('没有匹配的指令。', 'No matching instructions.') }}</p>
      </div>
      <p class="small muted count">{{ t(`${mnemonics.length} 个助记符`, `${mnemonics.length} mnemonics`) }}</p>
    </aside>

    <section class="main">
      <div class="card box">
        <label class="lbl small muted" for="calc-line">{{ t('一行汇编（可以直接改）', 'One line of assembly (edit it directly)') }}</label>
        <input id="calc-line" v-model="line" class="inp line" spellcheck="false" autocomplete="off" />
        <p v-if="analysis.error" class="err small">{{ analysis.error }}</p>

        <template v-if="analysis.entry">
          <div class="title">
            <b class="mono">{{ analysis.entry.mnemonic }}</b>
            <span class="badge" :class="{ warn: analysis.entry.pseudo }">{{
              analysis.entry.pseudo ? t('伪指令', 'Pseudo') : groupTitle(analysis.entry.group)
            }}</span>
            <span class="desc">{{ plainDesc(analysis.entry.description) }}</span>
          </div>
          <div v-if="forms.length > 1" class="forms">
            <span class="small muted">{{ t('写法', 'Forms') }}</span>
            <button v-for="f in forms" :key="f.key" class="chip" :aria-pressed="f.key === analysis.entry.key" :title="plainDesc(f.description)" @click="pick(f)">
              {{ f.example }}
            </button>
          </div>
          <div v-if="analysis.operands.length" class="ops">
            <label v-for="(o, i) in analysis.operands" :key="i" class="op">
              <span class="small muted">{{ o.hint }}</span>
              <select v-if="o.options" class="inp" :value="o.text" @change="setOperand(i, ($event.target as HTMLSelectElement).value)">
                <option v-if="!o.options.includes(o.text)" :value="o.text">{{ o.text || t('（选择）', '(choose)') }}</option>
                <option v-for="opt in o.options" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <input v-else class="inp" :value="o.text" spellcheck="false" @change="setOperand(i, ($event.target as HTMLInputElement).value)" />
            </label>
          </div>
          <div class="ops">
            <label class="op">
              <span class="small muted">{{ t('这条指令的地址', 'Address of this instruction') }}</span>
              <input v-model.lazy="atText" class="inp" spellcheck="false" />
            </label>
            <label v-for="l in analysis.labels" :key="l.name" class="op">
              <span class="small muted">{{ t(`标签 ${l.name} 的地址`, `Address of label ${l.name}`) }}</span>
              <input class="inp" :value="hex8(l.addr)" spellcheck="false" @change="setLabel(l.name, ($event.target as HTMLInputElement).value)" />
            </label>
          </div>
        </template>
      </div>

      <div v-if="analysis.ok" class="card box">
        <div class="code-head">
          <span class="small muted">{{ t('机器码', 'Machine code') }}</span>
          <span class="hexv mono">{{ totalWords }}</span>
          <span v-if="analysis.instructions.length > 1" class="badge warn">{{
            t(`展开成 ${analysis.instructions.length} 条真指令`, `expands to ${analysis.instructions.length} basic instructions`)
          }}</span>
        </div>
        <div v-for="(ins, k) in analysis.instructions" :key="k" class="ins" :class="{ sub: analysis.instructions.length > 1 }">
          <div class="ih">
            <span v-if="analysis.instructions.length > 1" class="small muted">{{
              t(`第 ${k + 1}/${analysis.instructions.length} 条`, `part ${k + 1}/${analysis.instructions.length}`)
            }}</span>
            <b class="mono asm">{{ ins.basic }}</b>
            <span class="mono hex2">{{ hex8(ins.word) }}</span>
            <span class="small muted mono">{{ hex8(ins.addr) }}</span>
            <span class="small muted role">{{ plainDesc(descOf.get(ins.view.mnemonic)) }}</span>
          </div>
          <BitFields :fields="ins.view.fields" :compact="analysis.instructions.length > 2" />
          <div class="bin mono small">
            <span v-for="(g, i) in binGroups(ins.word)" :key="i">{{ g }}</span>
            <span class="muted">= {{ ins.word >>> 0 }} {{ t('（无符号）', '(unsigned)') }}</span>
          </div>
          <ul v-if="ins.view.notes.length" class="notes small">
            <li v-for="n in ins.view.notes" :key="n">{{ n }}</li>
          </ul>
        </div>
      </div>

      <DemoRunner v-if="analysis.ok" :isa="isa" :analysis="analysis" />
    </section>
  </div>
</template>

<style scoped>
.calc {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 12px;
  padding: 12px;
  max-width: 1400px;
  margin: 0 auto;
  align-items: start;
}
.picker {
  position: sticky;
  top: 0;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: calc(100dvh - 90px);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.groups .chip {
  font-family: var(--font-sans);
}
.search {
  font-family: var(--font-sans);
  padding: 5px 8px;
}
.list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  overflow: auto;
  min-height: 0;
  align-content: flex-start;
}
.mn {
  font-size: 12px;
}
.count {
  margin: 0;
}
.main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.box {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.line {
  font-size: 16px;
  padding: 6px 10px;
}
.err {
  color: var(--danger);
  margin: 0;
}
.title {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.title b {
  font-size: 15px;
}
.desc {
  color: var(--text-secondary);
  font-size: 13px;
}
.forms {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
}
.op {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 110px;
}
.op .inp {
  font-size: 12.5px;
  padding: 4px 6px;
}
.code-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
}
.hexv {
  font-size: 19px;
  font-weight: 600;
  word-break: break-all;
}
.ins {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.ins.sub {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background: var(--surface-2);
}
.ih {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.asm {
  font-size: 14px;
}
.hex2 {
  font-weight: 600;
}
.role {
  font-family: var(--font-sans);
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
@media (max-width: 860px) {
  .calc {
    grid-template-columns: 1fr;
    padding: 8px;
  }
  .picker {
    position: static;
    max-height: none;
  }
  .list {
    max-height: 180px;
  }
}
</style>
