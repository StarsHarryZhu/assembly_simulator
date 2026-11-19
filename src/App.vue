<script setup lang="ts">
import { LOCALES, T, type Text } from './core/i18n'
import { lang, t, tx } from './ui/i18n'
import { ref, watch } from 'vue'
import { isas, defaultIsa } from './isa'
import { load, save } from './ui/storage'
import IdeView from './ui/ide/IdeView.vue'
import EncoderTab from './ui/calc/EncoderTab.vue'
import DecoderTab from './ui/calc/DecoderTab.vue'

type Tab = 'ide' | 'enc' | 'dec'
const TABS: { id: Tab; label: Text }[] = [
  { id: 'ide', label: T('编辑运行', 'Edit & run') },
  { id: 'enc', label: T('指令集', 'Instruction set') },
  { id: 'dec', label: T('反汇编', 'Disassembler') },
]

const tab = ref<Tab>(load<Tab>('tab', 'ide'))
if (!TABS.some((t) => t.id === tab.value)) tab.value = 'ide'
watch(tab, (t) => save('tab', t))

const isa = defaultIsa

type Theme = 'auto' | 'light' | 'dark'
const theme = ref<Theme>(load<Theme>('theme', 'auto'))
const THEME_LABEL: Record<Theme, Text> = { auto: T('跟随系统', 'System'), light: T('浅色', 'Light'), dark: T('深色', 'Dark') }

watch(
  lang,
  () => {
    document.title = t('汇编模拟器 · MIPS32', 'Assembly Simulator · MIPS32')
  },
  { immediate: true },
)
function applyTheme(t: Theme) {
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  save('theme', t)
}
applyTheme(theme.value)
function cycleTheme() {
  theme.value = theme.value === 'auto' ? 'light' : theme.value === 'light' ? 'dark' : 'auto'
  applyTheme(theme.value)
}

/** Lets the IDE's text-segment view open one word in the decoder tab. */
const decodeRequest = ref<string | null>(null)
function openInDecoder(word: string) {
  decodeRequest.value = word
  tab.value = 'dec'
}

/** Lets a modifier-click in the editor open that statement in the instruction set tab. */
const instructionRequest = ref<{ line: string; n: number } | null>(null)
let instructionSerial = 0
function openInInstructionSet(line: string) {
  instructionRequest.value = { line, n: ++instructionSerial }
  tab.value = 'enc'
}
/** One request is used once: the tab is re-created on every visit and must keep later edits. */
function instructionRequestUsed(n: number) {
  if (instructionRequest.value?.n === n) instructionRequest.value = null
}
</script>

<template>
  <div class="shell">
    <header class="top">
      <div class="brand">
        <span class="title">{{ t('汇编模拟器', 'Assembly Simulator') }}</span>
        <label class="arch">
          <span class="sr">{{ t('架构', 'Architecture') }}</span>
          <select class="inp" :value="isa.id" :aria-label="t('架构', 'Architecture')">
            <option v-for="p in isas" :key="p.id" :value="p.id" :disabled="!p.available">
              {{ p.displayName }}{{ p.available ? '' : t('（未实现）', ' (not yet)') }}
            </option>
          </select>
        </label>
      </div>
      <nav class="tabs" role="tablist" :aria-label="t('栏目', 'Sections')">
        <button
          v-for="tb in TABS"
          :key="tb.id"
          class="tab"
          role="tab"
          :aria-selected="tab === tb.id"
          @click="tab = tb.id"
        >
          {{ tx(tb.label) }}
        </button>
      </nav>
      <select v-model="lang" class="inp lang" :aria-label="t('界面语言', 'Language')">
        <option v-for="l in LOCALES" :key="l.id" :value="l.id">{{ l.label }}</option>
      </select>
      <button class="btn theme" :title="t('主题：', 'Theme: ') + tx(THEME_LABEL[theme])" @click="cycleTheme">
        {{ tx(THEME_LABEL[theme]) }}
      </button>
    </header>
    <main class="body">
      <IdeView v-show="tab === 'ide'" :isa="isa" @open-in-decoder="openInDecoder" @open-instruction="openInInstructionSet" />
      <EncoderTab v-if="tab === 'enc'" :isa="isa" :request="instructionRequest" @consumed="instructionRequestUsed" />
      <DecoderTab v-if="tab === 'dec'" :isa="isa" :request="decodeRequest" />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
}
.top {
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 14px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.title {
  font-weight: 600;
  font-size: 15px;
}
.arch select,
.lang {
  font-size: 12px;
}
.lang {
  font-family: var(--font-sans);
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.tabs {
  display: flex;
  gap: 3px;
  padding: 3px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  margin-right: auto;
}
.tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  padding: 4px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}
.tab[aria-selected='true'] {
  background: var(--surface-1);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: 0 0 0 1px var(--border);
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
@media (max-width: 640px) {
  .top {
    padding: 6px 10px;
    gap: 8px;
  }
  .tabs {
    order: 3;
    width: 100%;
    margin-right: 0;
  }
  .tab {
    flex: 1;
    padding: 4px 6px;
  }
  .brand {
    margin-right: auto;
  }
}
</style>
