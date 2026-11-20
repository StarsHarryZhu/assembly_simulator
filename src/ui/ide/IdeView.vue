<script setup lang="ts">
/**
 * The 编辑运行 tab: toolbar, editor (or machine-code view) and terminal on the left; registers, stack and
 * memory on the right. Below 1100 px the two columns stack.
 */
import { flushSections, translateComments } from '../../core/source'
import ConfirmDialog, { type Choice } from './ConfirmDialog.vue'
import { lang, t, tx } from '../i18n'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { IsaPlugin } from '../../core/isa'
import { load, save } from '../storage'
import DialogHost from './DialogHost.vue'
import EditorPane from './EditorPane.vue'
import { formatShortcut } from './editor'
import { downloadBytes } from './files'
import MemoryPanel from './MemoryPanel.vue'
import RegisterPanel from './RegisterPanel.vue'
import StackPanel from './StackPanel.vue'
import TerminalPane from './TerminalPane.vue'
import TextSegmentView from './TextSegmentView.vue'
import Toolbar from './Toolbar.vue'
import { useSession } from './useSession'

const props = defineProps<{ isa: IsaPlugin }>()
const emit = defineEmits<{ 'open-in-decoder': [word: string]; 'open-instruction': [line: string] }>()

const handle = useSession(props.isa)
const s = handle.session
const root = ref<HTMLElement | null>(null)
const editor = ref<InstanceType<typeof EditorPane> | null>(null)
const picker = ref<HTMLInputElement | null>(null)
type View = 'source' | 'text'
const view = ref<View>(load<View>('ideView', 'source'))
const fileName = ref(s.file.name)
const formatKey = formatShortcut()

function setView(v: View) {
  view.value = v
  save('ideView', v)
}

function replaceSource(name: string, text: string) {
  s.pause()
  s.setBreakpoints([])
  s.setName(name)
  fileName.value = name
  s.setSource(flushSections(text.replace(/\r\n?/g, '\n'), s.isa.language.sections))
  s.assemble()
  markClean()
  setView('source')
}

/*
 * Unsaved changes. The code counts as saved right after New, Open, an example or Download; the
 * fingerprint of that text is kept (per viewer) so a reload still knows. An example is always saved.
 */
const cleanKey = `ide.${props.isa.id}.clean`
const clean = ref<string>(load(cleanKey, ''))
function fingerprint(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return `${(h >>> 0).toString(16)}:${text.length}`
}
function markClean() {
  clean.value = fingerprint(s.file.text)
  save(cleanKey, clean.value)
}
function isUnchanged(): boolean {
  const text = s.file.text.trim()
  return !text || fingerprint(s.file.text) === clean.value || s.isa.examples.some((e) => e.text.zh.trim() === text || e.text.en.trim() === text)
}

/** An in-page question: native confirm() blocks the page and some embedded browsers drop it silently. */
const question = ref<{ message: string; choices: Choice[]; answer: (value: string | null) => void } | null>(null)
function ask(message: string, choices: Choice[]): Promise<string | null> {
  return new Promise((resolve) => {
    question.value = {
      message,
      choices,
      answer: (value) => {
        question.value = null
        resolve(value)
      },
    }
  })
}

/** Before the editor's code is replaced: offer to save unsaved changes. False means cancel. */
async function readyToReplace(action: string): Promise<boolean> {
  if (isUnchanged()) return true
  const choice = await ask(
    t(
      `${action}之前，要保存当前的代码吗？\n“保存”会把它下载成 ${downloadName()}；选“不保存”，当前代码会被替换，找不回来。`,
      `Save the current code before you ${action}?\n"Save" downloads it as ${downloadName()}. With "Don't save" it is replaced and cannot be recovered.`,
    ),
    [
      { value: 'cancel', label: t('取消', 'Cancel') },
      { value: 'discard', label: t('不保存', "Don't save") },
      { value: 'save', label: t('保存', 'Save'), primary: true },
    ],
  )
  if (choice === 'save') download()
  return choice === 'save' || choice === 'discard'
}

async function newFile() {
  if (!(await readyToReplace(t('新建文件', 'create a new file')))) return
  replaceSource('untitled.asm', '')
  editor.value?.goto(1, 0)
}

async function loadExample(id: string) {
  const ex = s.isa.examples.find((e) => e.id === id)
  if (!ex) return
  if (!(await readyToReplace(t(`打开示例“${tx(ex.title)}”`, `open the example "${tx(ex.title)}"`)))) return
  await handle.busyWhile(() => replaceSource(`${ex.id}.asm`, tx(ex.text)))
}

async function openFile(file: File | undefined) {
  if (!file) return
  const text = await file.text()
  if (!(await readyToReplace(t(`打开 ${file.name}`, `open ${file.name}`)))) return
  await handle.busyWhile(() => replaceSource(file.name, text))
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  void openFile(input.files?.[0])
  input.value = ''
}

function onDrop(e: DragEvent) {
  void openFile(e.dataTransfer?.files?.[0])
}

function downloadName(): string {
  return /\.(asm|s)$/i.test(s.file.name) ? s.file.name : `${s.file.name || 'program'}.asm`
}

function download() {
  // Clean first: should a browser treat the download link as leaving the page, there is nothing to warn about.
  markClean()
  downloadBytes(downloadName(), s.file.text, 'text/plain;charset=utf-8')
}

/*
 * Closing or reloading the tab with code that was never downloaded: the browser asks first, with its own
 * wording and buttons (pages cannot draw while they are being closed, and any text they give is ignored).
 * Browsers skip the question on a page the person never clicked or typed in.
 */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (isUnchanged()) return
  e.preventDefault()
  e.returnValue = true // older browsers ask only when this is set
}

function rename() {
  const name = fileName.value.trim() || 'program.asm'
  fileName.value = name
  s.setName(name)
}

function goto(line: number, col: number) {
  setView('source')
  editor.value?.goto(line, col)
}

function format() {
  setView('source')
  editor.value?.format()
}

function onKey(e: KeyboardEvent) {
  if (!root.value || root.value.offsetParent === null || s.dialog || question.value) return
  const actions: Record<string, () => void> = {
    F5: () => handle.control(() => s.run()),
    F6: () => (s.mode === 'auto' ? s.pause() : handle.control(() => s.auto())),
    F7: () => handle.control(() => s.step()),
    F8: () => handle.control(() => s.back()),
    F9: () => s.pause(),
    F10: () => handle.control(() => s.reset()),
  }
  // Format, as in VS Code. Read the physical key: on macOS ⌥ turns e.key into "Ï". Text fields keep the keys.
  if (e.code === 'KeyF' && e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey && s.isa.format) {
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return
    e.preventDefault()
    format()
    return
  }
  const act = actions[e.key]
  if (!act || e.ctrlKey || e.metaKey || e.altKey) return
  e.preventDefault()
  act()
}

/**
 * On a language switch, lines that come from an example get that example's comments in the new language
 * (the code and line numbers stay, so a running program keeps running), and a program that has not
 * started is reassembled so its messages follow.
 */
watch(lang, (l) => {
  s.replaceComments(translateComments(s.file.text, s.isa.examples, l, s.isa.language.commentChar))
  if (s.mode === 'idle' && !s.stale && (!s.machine || s.machine.steps === 0)) s.assemble()
})

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('beforeunload', onBeforeUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <div ref="root" class="ide" @dragover.prevent @drop.prevent="onDrop">
    <Toolbar class="tb" :handle="handle" @new="newFile" @open="picker?.click()" @download="download" @example="loadExample" @format="format" />
    <input ref="picker" type="file" accept=".asm,.s,.txt,text/plain" hidden @change="onPick" />
    <div class="cols">
      <section class="left">
        <div class="lhead">
          <div class="switch" role="tablist" :aria-label="t('代码视图', 'Code view')">
            <button class="sw" role="tab" :aria-selected="view === 'source'" @click="setView('source')">{{ t('源码', 'Source') }}</button>
            <button class="sw" role="tab" :aria-selected="view === 'text'" @click="setView('text')">{{ t('机器码', 'Machine code') }}</button>
          </div>
          <input v-model="fileName" class="inp name" :aria-label="t('文件名', 'File name')" spellcheck="false" @change="rename" @keydown.enter="rename" />
          <span class="small muted hint">{{
            t(`点行号设断点 · F5 运行 · F7 单步 · F8 上一步 · ${formatKey} 格式化`, `Click a line number for a breakpoint · F5 run · F7 step · F8 back · ${formatKey} format`)
          }}</span>
        </div>
        <div class="code card">
          <EditorPane v-show="view === 'source'" ref="editor" :handle="handle" @open-instruction="(line) => emit('open-instruction', line)" />
          <TextSegmentView v-if="view === 'text'" :handle="handle" @decode="(w) => emit('open-in-decoder', w)" />
        </div>
        <TerminalPane class="terminal" :handle="handle" @goto="goto" />
      </section>
      <aside class="right">
        <RegisterPanel :handle="handle" />
        <StackPanel :handle="handle" />
        <MemoryPanel :handle="handle" />
      </aside>
    </div>
    <DialogHost :handle="handle" />
    <ConfirmDialog v-if="question" :message="question.message" :choices="question.choices" @answer="question.answer" />
  </div>
</template>

<style scoped>
.ide {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.cols {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(400px, 34%);
}
.left {
  display: grid;
  grid-template-rows: auto minmax(160px, 1fr) minmax(170px, 32%);
  gap: 8px;
  padding: 10px 6px 10px 12px;
  min-height: 0;
  min-width: 0;
}
.lhead {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.switch {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.sw {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  cursor: pointer;
}
.sw[aria-selected='true'] {
  background: var(--surface-1);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: 0 0 0 1px var(--border);
}
.name {
  width: 180px;
  font-size: 12.5px;
}
.hint {
  margin-left: auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.code {
  min-height: 0;
  overflow: hidden;
}
.right {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 10px 6px;
  overflow: auto;
  min-height: 0;
}
@media (max-width: 1099px) {
  .ide {
    height: auto;
  }
  .tb {
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .cols {
    display: flex;
    flex-direction: column;
  }
  .left {
    grid-template-rows: auto 58vh 280px;
    padding: 10px 12px 0;
  }
  .right {
    overflow: visible;
    padding: 8px 12px 16px;
  }
  .hint {
    display: none;
  }
}
@media (max-width: 520px) {
  .left {
    padding: 8px 8px 0;
    grid-template-rows: auto 52vh 260px;
  }
  .right {
    padding: 8px 8px 16px;
  }
  .name {
    flex: 1;
    width: auto;
  }
}
</style>
