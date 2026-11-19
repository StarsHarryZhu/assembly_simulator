<script setup lang="ts">
/**
 * File actions, the run controls (run / step / back / auto / pause / reset) and the status line. There is no
 * assemble button: every control assembles first when the code changed since the last assembly.
 */
import { t, tx } from '../i18n'
import { computed } from 'vue'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const emit = defineEmits<{ new: []; open: []; download: []; example: [id: string] }>()
const s = props.handle.session
const v = props.handle.version
const busy = props.handle.busy
const go = props.handle.control

const st = computed(() => {
  void v.value
  const m = s.machine
  const halted = s.halted
  const stale = s.stale
  const canGo = stale || !m || (!halted && !s.pending)
  let label = ''
  let tone: '' | 'ok' | 'warn' | 'err' = ''
  if (s.result && !s.result.ok && !stale) {
    label = t('汇编失败', 'Assembly failed')
    tone = 'err'
  } else if (!m) label = t('未汇编', 'Not assembled')
  else if (stale) {
    label = t('代码已修改，运行或单步时自动重新汇编', 'Code changed; it is reassembled when you run or step')
    tone = 'warn'
  } else if (s.dialog) label = t('等待对话框', 'Waiting for the dialog')
  else if (s.pending) {
    label = t('等待输入', 'Waiting for input')
    tone = 'warn'
  } else if (s.mode === 'running') label = t('运行中…', 'Running…')
  else if (s.mode === 'auto') label = t('自动执行中', 'Auto-stepping')
  else if (halted?.kind === 'error') {
    label = t('运行出错', 'Runtime error')
    tone = 'err'
  } else if (halted) {
    label = t('已结束', 'Finished')
    tone = 'ok'
  } else if (m.steps === 0) label = t('已汇编，可以运行', 'Assembled, ready to run')
  else label = t('已暂停', 'Paused')
  const part = s.currentPart
  return {
    steps: m?.steps ?? 0,
    label,
    tone,
    canGo,
    canBack: s.mode === 'idle' && (stale || (!!m && m.canUndo)),
    busy: s.mode !== 'idle',
    auto: s.mode === 'auto',
    running: s.mode === 'running',
    granularity: s.granularity,
    interval: s.interval,
    part: part && part.parts > 1 && s.granularity === 'instruction' ? t(`伪指令第 ${part.part + 1}/${part.parts} 条`, `pseudo-instruction part ${part.part + 1}/${part.parts}`) : '',
  }
})

/** The select only triggers loading; it always shows its placeholder again afterwards. */
function pickExample(e: Event) {
  const sel = e.target as HTMLSelectElement
  const id = sel.value
  sel.value = ''
  if (id) emit('example', id)
}

function toggleAuto() {
  if (s.mode === 'auto') s.pause()
  else go(() => s.auto())
}
</script>

<template>
  <div class="toolbar" role="toolbar" :aria-label="t('编辑运行工具栏', 'Edit and run toolbar')">
    <div class="group">
      <button class="btn" :title="t('新建一个空文件（当前代码没保存时会先问你）', 'Start an empty file (asks first if the current code is not saved)')" @click="emit('new')">{{ t('新建', 'New') }}</button>
      <button class="btn" :title="t('打开 .asm 文件（也可以直接拖进编辑器）', 'Open an .asm file (or drop one on the editor)')" @click="emit('open')">{{ t('打开', 'Open') }}</button>
      <button class="btn" :title="t('把代码下载成 .asm 文件', 'Download the code as an .asm file')" @click="emit('download')">{{ t('下载', 'Download') }}</button>
      <select class="inp examples" value="" :aria-label="t('示例程序', 'Examples')" @change="pickExample">
        <option value="" disabled hidden>{{ t('示例程序…', 'Examples…') }}</option>
        <option v-for="ex in s.isa.examples" :key="ex.id" :value="ex.id">{{ tx(ex.title) }}</option>
      </select>
    </div>
    <div class="group">
      <button class="btn primary" :title="t('运行到结束、断点或需要输入（F5）', 'Run to the end, a breakpoint or an input request (F5)')" :disabled="!st.canGo || st.busy || busy" @click="go(() => s.run())">
        <span v-if="st.running" class="spinner" aria-hidden="true" />{{ t('运行', 'Run') }}
      </button>
      <button class="btn" :title="t('执行一步（F7）', 'Execute one step (F7)')" :disabled="!st.canGo" @click="go(() => s.step())">{{ t('单步', 'Step') }}</button>
      <button class="btn" :title="t('撤销一步（F8），最多 2000 步；代码改过时重新汇编', 'Undo one step (F8), up to 2000 steps; reassembles if the code changed')" :disabled="!st.canBack" @click="go(() => s.back())">
        {{ t('上一步', 'Back') }}
      </button>
      <button class="btn" :class="{ on: st.auto }" :title="t('按间隔自动单步（F6）', 'Step automatically at the interval (F6)')" :disabled="!st.canGo && !st.auto" @click="toggleAuto">
        {{ st.auto ? t('停止自动', 'Stop auto') : t('自动', 'Auto') }}
      </button>
      <button class="btn" :title="t('暂停（F9）', 'Pause (F9)')" :disabled="!st.busy" @click="s.pause()">{{ t('暂停', 'Pause') }}</button>
      <button class="btn" :title="t('回到程序开头（F10）；代码改过时重新汇编', 'Back to the start of the program (F10); reassembles if the code changed')" @click="go(() => s.reset())">{{ t('重置', 'Reset') }}</button>
    </div>
    <div class="group interval">
      <label class="small muted" for="tb-interval">{{ t('间隔', 'Interval') }}</label>
      <input
        id="tb-interval"
        type="range"
        min="0"
        max="2000"
        step="50"
        :value="st.interval"
        :aria-label="t('自动执行间隔（毫秒）', 'Auto-step interval (ms)')"
        @input="s.setInterval(Number(($event.target as HTMLInputElement).value))"
      />
      <span class="small mono ms">{{ st.interval }} ms</span>
    </div>
    <div class="group seg" role="radiogroup" :aria-label="t('单步一次执行多少', 'How much one step runs')">
      <span class="small muted">{{ t('单步按', 'Step by') }}</span>
      <button class="chip" :aria-pressed="st.granularity === 'line'" :title="t('每步执行一行源码：伪指令（如 li、la、blt）展开成的几条真指令一次执行完', 'Each step runs one source line: all the basic instructions a pseudo-instruction (li, la, blt, …) expands to run together')" @click="s.setGranularity('line')">
        {{ t('源码行', 'Source line') }}
      </button>
      <button class="chip" :aria-pressed="st.granularity === 'instruction'" :title="t('每步只执行一条真指令（和 MARS 一样），伪指令要分几步走完', 'Each step runs a single basic instruction (as MARS does), so a pseudo-instruction takes several steps')" @click="s.setGranularity('instruction')">
        {{ t('真指令', 'Basic instruction') }}
      </button>
    </div>
    <div class="status">
      <span v-if="busy" class="spinner" :aria-label="t('处理中', 'Working')" />
      <span class="badge" :class="{ warn: st.tone === 'warn', err: st.tone === 'err', ok: st.tone === 'ok' }">{{ st.label }}</span>
      <span class="small muted">{{ t('已执行', 'Steps') }} <b class="mono">{{ st.steps.toLocaleString() }}</b>{{ t(' 步', '') }}</span>
      <span v-if="st.part" class="small muted">{{ st.part }}</span>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 7px 12px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
}
.group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.examples {
  font-family: var(--font-sans);
  max-width: 190px;
}
.interval input {
  width: 110px;
  accent-color: var(--accent);
}
.ms {
  min-width: 56px;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.badge.ok {
  background: var(--bg-success);
  color: var(--success);
}
@media (max-width: 700px) {
  .toolbar {
    padding: 6px 10px;
    gap: 6px 8px;
  }
  .status {
    margin-left: 0;
    width: 100%;
  }
  .interval input {
    width: 90px;
  }
}
</style>
