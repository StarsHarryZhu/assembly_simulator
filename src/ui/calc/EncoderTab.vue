<script setup lang="ts">
/**
 * Instruction set tab: pick an instruction (or type a line), set its operands, and see the machine code as bit
 * fields. Pseudo-instructions show every basic instruction they expand to. Below, a demo runs the line.
 * Instructions with a reference table (syscall services, CP0, ...) show it below the demo; a line that
 * starts with a directive shows the directive table instead, with that directive highlighted.
 */
import type { Text } from '../../core/i18n'
import { lang, t, tx } from '../i18n'
import { plainDesc } from '../ide/editor'
import { computed, reactive, ref, watch } from 'vue'
import { binGroups, hex8, hexAddr } from '../../core/format'
import type { IsaPlugin, RefRow } from '../../core/isa'
import { isaKey, load, save } from '../storage'
import BitFields from './BitFields.vue'
import DemoRunner from './DemoRunner.vue'
import ReferenceTable from './ReferenceTable.vue'
import { parseAddress } from './values'

const props = defineProps<{ isa: IsaPlugin; request?: { line: string; n: number } | null }>()
const emit = defineEmits<{ consumed: [n: number] }>()
const isa = props.isa

const addrBits = isa.layout.addressBits ?? 32
const hexA = (a: number) => hexAddr(a, addrBits)
const key = (k: string) => isaKey(isa.id, k)
const group = ref<string>(load(key('calcGroup'), 'all'))
const query = ref('')
const line = ref<string>(load(key('calcLine'), isa.samples.line))
const atText = ref<string>(load(key('calcAt'), hexA(isa.layout.textBase)))
const labelAddrs = reactive<Record<string, number>>({})
watch(group, (g) => save(key('calcGroup'), g))
watch(line, (l) => save(key('calcLine'), l))
watch(atText, (a) => save(key('calcAt'), a))

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
  return parseAddress(atText.value, addrBits) ?? isa.layout.textBase
})

// Reading lang makes a language switch re-run the analysis, whose messages are localized.
const analysis = computed(() => (void lang.value, isa.analyzeLine(line.value, { at: at.value, labels: { ...labelAddrs } })))

const descOf = new Map<string, Text>()
for (const e of isa.catalog) if (!e.pseudo && !descOf.has(e.mnemonic)) descOf.set(e.mnemonic, e.description)

// Searching for what a reference row names ("sbrk", "打印字符串", "epc") finds the instructions it belongs to.
const referenceText = new Map<string, string>()
for (const table of isa.references ?? []) {
  const words = [table.title, ...table.groups.flatMap((g) => g.rows.map((r) => r.title))].flatMap((x) => [x.zh, x.en])
  for (const m of table.mnemonics) referenceText.set(m, [referenceText.get(m) ?? '', ...words].join('\n').toLowerCase())
}

/** Picker group of the directives, after the ISA's instruction groups. */
const DIRECTIVES = 'directives'

// Each directive's row in a reference table, for the picker and the title card.
const directiveRows = new Map<string, RefRow>()
for (const table of isa.references ?? [])
  for (const g of table.groups) for (const row of g.rows) if (isa.language.directives.includes(row.key)) directiveRows.set(row.key, row)

/** The line to put in the input for a directive: its example's line that uses it (examples may span lines). */
const directiveLine = (d: string) => directiveRows.get(d)?.example?.split('\n').find((l) => l.includes(d))?.trim() ?? d

/** The directive the line starts with, after any labels; null for an instruction. */
const directive = computed(() => {
  const d = /^\s*(?:[\w.$]+:\s*)*(\.[A-Za-z_]\w*)/.exec(line.value)?.[1]?.toLowerCase()
  return d && isa.language.directives.includes(d) ? d : null
})

interface Item {
  key: string
  name: string
  tip: string
  line: string
}

const items = computed<Item[]>(() => {
  void lang.value
  const q = query.value.trim().toLowerCase()
  const out: Item[] = []
  const seen = new Set<string>()
  for (const e of isa.catalog) {
    if (group.value === DIRECTIVES || (group.value !== 'all' && e.group !== group.value) || seen.has(e.mnemonic)) continue
    if (q && !e.mnemonic.includes(q) && !e.description.zh.includes(q) && !e.description.en.toLowerCase().includes(q) && !referenceText.get(e.mnemonic)?.includes(q)) continue
    seen.add(e.mnemonic)
    out.push({ key: e.key, name: e.mnemonic, tip: plainDesc(e.description), line: e.example })
  }
  if (group.value === 'all' || group.value === DIRECTIVES) {
    for (const [d, row] of directiveRows) {
      const words = [row.title, ...(row.text ? [row.text] : [])].flatMap((x) => [x.zh, x.en.toLowerCase()])
      if (q && !d.includes(q) && !words.some((w) => w.includes(q))) continue
      const tip = row.text ? t(`${tx(row.title)}：${tx(row.text)}`, `${tx(row.title)}: ${tx(row.text)}`) : tx(row.title)
      out.push({ key: `dir${d}`, name: d, tip, line: directiveLine(d) })
    }
  }
  return out
})

/** ISAs with thousands of mnemonics render the list a page at a time. */
const PAGE = 400
const shown = ref(PAGE)
watch([group, query], () => (shown.value = PAGE))
const visible = computed(() => items.value.slice(0, shown.value))

const current = computed(() => directive.value ?? analysis.value.mnemonic)
const directiveRow = computed(() => (directive.value ? (directiveRows.get(directive.value) ?? null) : null))

const forms = computed(() => isa.catalog.filter((e) => e.mnemonic === analysis.value.mnemonic))

const references = computed(() => {
  const m = directive.value ?? analysis.value.entry?.mnemonic
  return m ? (isa.references ?? []).filter((r) => r.mnemonics.includes(m)) : []
})

const groupTitle = (id: string) => {
  const g = isa.catalogGroups.find((x) => x.id === id)
  return g ? tx(g.title) : id
}

function pick(example: string) {
  line.value = example
}

function setOperand(i: number, text: string) {
  const a = analysis.value
  if (!a.entry) return
  const texts = a.operands.map((o) => o.text)
  texts[i] = text.trim()
  line.value = isa.buildLine(a.entry.key, texts)
}

function setLabel(name: string, text: string) {
  const v = parseAddress(text, addrBits, 1)
  if (v != null) labelAddrs[name] = v
}

const totalWords = computed(() => analysis.value.instructions.map((i) => hex8(i.word)).join(' '))
</script>

<template>
  <div class="calc">
    <aside class="picker card">
      <div class="chips groups" role="radiogroup" :aria-label="t('指令分类', 'Instruction groups')">
        <button class="chip" :aria-pressed="group === 'all'" @click="group = 'all'">{{ t('全部', 'All') }}</button>
        <button v-for="g in isa.catalogGroups" :key="g.id" class="chip" :aria-pressed="group === g.id" @click="group = g.id">{{ tx(g.title) }}</button>
        <button v-if="directiveRows.size" class="chip" :aria-pressed="group === DIRECTIVES" @click="group = DIRECTIVES">{{ t('伪操作', 'Directives') }}</button>
      </div>
      <input v-model="query" class="inp search" type="search" :placeholder="t('搜索指令、伪操作或说明，如 sll、乘法、.word', 'Search instructions, directives or descriptions, e.g. sll, multiply, .word')"
        spellcheck="false"
        :aria-label="t('搜索指令', 'Search instructions')"
      />
      <div class="list" role="listbox" :aria-label="t('指令', 'Instructions')">
        <button
          v-for="e in visible"
          :key="e.key"
          class="chip mn"
          role="option"
          :aria-selected="current === e.name"
          :aria-pressed="current === e.name"
          :title="e.tip"
          @click="pick(e.line)"
        >
          {{ e.name }}
        </button>
        <p v-if="!items.length" class="small muted">{{ t('没有匹配的指令或伪操作。', 'No matching instructions or directives.') }}</p>
        <button v-if="items.length > visible.length" class="btn" @click="shown += PAGE * 2">
          {{ t(`再显示一些（还有 ${items.length - visible.length} 项）`, `Show more (${items.length - visible.length} left)`) }}
        </button>
      </div>
      <p class="small muted count">{{ t(`${items.length} 项`, `${items.length} items`) }}</p>
    </aside>

    <section class="main">
      <div class="card box">
        <label class="lbl small muted" for="calc-line">{{ t('一行汇编（可以直接改）', 'One line of assembly (edit it directly)') }}</label>
        <input id="calc-line" v-model="line" class="inp line" spellcheck="false" autocomplete="off" />
        <p v-if="analysis.error && !directive" class="err small">{{ analysis.error }}</p>

        <template v-if="directive">
          <div class="title">
            <b class="mono">{{ directive }}</b>
            <span class="badge">{{ t('伪操作', 'Directive') }}</span>
            <span v-if="directiveRow" class="desc">{{ tx(directiveRow.title) }}</span>
          </div>
          <p v-if="directiveRow?.text" class="dir-text">{{ tx(directiveRow.text) }}</p>
          <p v-if="directiveRow?.note" class="dir-text muted">{{ tx(directiveRow.note) }}</p>
          <p class="small muted">{{
            t('伪操作不会变成机器码，所以这里没有位域和演示。所有伪操作都在下面的表里，这一个已标出。', 'A directive produces no machine code, so there are no bit fields or demo. Every directive is in the table below, with this one highlighted.')
          }}</p>
        </template>

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
            <button v-for="f in forms" :key="f.key" class="chip" :aria-pressed="f.key === analysis.entry.key" :title="plainDesc(f.description)" @click="pick(f.example)">
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
              <input class="inp" :value="hexA(l.addr)" spellcheck="false" @change="setLabel(l.name, ($event.target as HTMLInputElement).value)" />
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
            <span class="small muted mono">{{ hexA(ins.addr) }}</span>
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

      <ReferenceTable v-for="r in references" :key="r.id" :table="r" :current="directive ?? undefined" />
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
.dir-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
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
