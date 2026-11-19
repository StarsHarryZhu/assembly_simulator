<script setup lang="ts">
/** The simulated console (program output and keyboard input), assembler/runtime messages, and the file list. */
import { t } from '../i18n'
import { computed, nextTick, ref, watch } from 'vue'
import FilesPanel from './FilesPanel.vue'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const emit = defineEmits<{ goto: [line: number, col: number] }>()
const s = props.handle.session
const v = props.handle.version

type Tab = 'out' | 'msg' | 'files'
const tab = ref<Tab>('out')
const out = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const draft = ref('')

const view = computed(() => {
  void v.value
  const p = s.pending
  let prompt = ''
  if (p?.kind === 'line') {
    const max = Math.max(0, (p.maxLength ?? 0) - 1)
    prompt = {
      int: t('程序在等你输入一个整数', 'The program is waiting for an integer'),
      float: t('程序在等你输入一个浮点数', 'The program is waiting for a floating-point number'),
      double: t('程序在等你输入一个浮点数（双精度）', 'The program is waiting for a floating-point number (double)'),
      string: t(
        `程序在等你输入一行文字${p.maxLength ? `（最多 ${max} 个字符）` : ''}`,
        `The program is waiting for a line of text${p.maxLength ? ` (at most ${max} characters)` : ''}`,
      ),
    }[p.purpose]
  } else if (p?.kind === 'char') prompt = t('程序在等你按一个键', 'The program is waiting for a key')
  const errors = s.messages.filter((m) => m.severity === 'error').length
  const warnings = s.messages.filter((m) => m.severity === 'warning').length
  return {
    chunks: s.console.slice(),
    messages: s.messages.slice(),
    prompt,
    char: p?.kind === 'char',
    errors,
    warnings,
    files: s.files.list().length,
  }
})

// Show messages when assembly fails; follow the output and focus the input when the program asks.
let lastResult = s.result
watch(v, async () => {
  if (s.result !== lastResult) {
    lastResult = s.result
    if (s.result && !s.result.ok) tab.value = 'msg'
    else if (tab.value === 'msg' && s.result?.ok) tab.value = 'out'
  }
  if (view.value.prompt && tab.value !== 'out') tab.value = 'out'
  const el = out.value
  const stick = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
  await nextTick()
  if (stick && out.value) out.value.scrollTop = out.value.scrollHeight
  if (view.value.prompt) input.value?.focus({ preventScroll: true })
})

function submit() {
  s.submit(draft.value)
  draft.value = ''
}

function onKey(e: KeyboardEvent) {
  if (!view.value.char) return
  if (e.key.length === 1 || e.key === 'Enter') {
    e.preventDefault()
    s.submit(e.key === 'Enter' ? '\n' : e.key)
  }
}
</script>

<template>
  <section class="term card">
    <div class="bar" role="tablist" :aria-label="t('终端', 'Terminal')">
      <button class="t" role="tab" :aria-selected="tab === 'out'" @click="tab = 'out'">{{ t('运行输出', 'Output') }}</button>
      <button class="t" role="tab" :aria-selected="tab === 'msg'" @click="tab = 'msg'">
        {{ t('消息', 'Messages') }}
        <span v-if="view.errors" class="badge err">{{ view.errors }}</span>
        <span v-else-if="view.warnings" class="badge warn">{{ view.warnings }}</span>
      </button>
      <button class="t" role="tab" :aria-selected="tab === 'files'" @click="tab = 'files'">
        {{ t('文件', 'Files') }} <span v-if="view.files" class="badge">{{ view.files }}</span>
      </button>
      <button v-if="tab === 'out'" class="btn clear" :title="t('清空输出', 'Clear the output')" @click="s.clearConsole()">{{ t('清空', 'Clear') }}</button>
    </div>

    <div v-show="tab === 'out'" class="body">
      <pre ref="out" class="out mono" aria-live="polite"><span v-for="(c, i) in view.chunks" :key="i" :class="'k-' + c.kind">{{ c.text }}</span><span v-if="!view.chunks.length && !view.prompt" class="muted">{{ t('程序的输出会显示在这里。', 'Program output appears here.') }}</span></pre>
      <form v-if="view.prompt" class="ask" @submit.prevent="submit">
        <span class="small">{{ view.prompt }}</span>
        <input
          ref="input"
          v-model="draft"
          class="inp"
          :placeholder="view.char ? t('按任意键', 'Press any key') : t('输入后按回车', 'Type, then press Enter')"
          spellcheck="false"
          autocomplete="off"
          :aria-label="t('程序输入', 'Program input')"
          @keydown="onKey"
        />
        <button v-if="!view.char" class="btn primary" type="submit">{{ t('发送', 'Send') }}</button>
      </form>
    </div>

    <div v-show="tab === 'msg'" class="body list">
      <p v-if="!view.messages.length" class="muted small pad">{{ t('还没有消息。点“汇编”或直接运行。', 'No messages yet. Assemble or just run.') }}</p>
      <button
        v-for="(m, i) in view.messages"
        :key="i"
        class="msg"
        :class="m.severity"
        :disabled="m.line == null"
        @click="m.line != null && emit('goto', m.line, m.col ?? 0)"
      >
        <span class="badge" :class="{ err: m.severity === 'error', warn: m.severity === 'warning' }">{{
          m.severity === 'error' ? t('错误', 'Error') : m.severity === 'warning' ? t('警告', 'Warning') : t('信息', 'Info')
        }}</span>
        <span>{{ m.text }}</span>
      </button>
    </div>

    <div v-show="tab === 'files'" class="body list">
      <FilesPanel :handle="handle" />
    </div>
  </section>
</template>

<style scoped>
.term {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.t {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  gap: 5px;
  align-items: center;
}
.t[aria-selected='true'] {
  background: var(--surface-1);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: 0 0 0 1px var(--border);
}
.clear {
  margin-left: auto;
  padding: 1px 8px;
  font-size: 11.5px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.out {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12.5px;
  line-height: 1.5;
}
.k-in {
  color: var(--accent);
  font-weight: 600;
}
.k-note {
  color: var(--text-muted);
}
.k-error {
  color: var(--danger);
  font-weight: 600;
}
.ask {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-top: 1px solid var(--border);
  background: var(--bg-warning);
}
.ask .inp {
  flex: 1;
  min-width: 120px;
  font-size: 13px;
  padding: 4px 8px;
  background: var(--surface-1);
}
.list {
  overflow: auto;
  padding: 4px;
  gap: 2px;
}
.pad {
  padding: 6px 8px;
  margin: 0;
}
.msg {
  appearance: none;
  border: 0;
  background: transparent;
  text-align: left;
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--text-primary);
  cursor: pointer;
}
.msg:hover:not(:disabled) {
  background: var(--surface-2);
}
.msg:disabled {
  cursor: default;
  opacity: 1;
}
.msg.info .badge {
  flex: none;
}
.msg .badge {
  flex: none;
}
</style>
