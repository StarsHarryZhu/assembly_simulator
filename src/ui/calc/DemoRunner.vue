<script setup lang="ts">
/**
 * 执行演示: run the calculator's line (or its whole expansion) one basic instruction at a time on a real
 * machine. Starting values of the registers it reads are editable; each step shows what it read (green),
 * what it wrote (red), memory writes, output, and where the PC went.
 */
import { lang, t } from '../i18n'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { binGroups, floatFromBits, hex8, javaFloat } from '../../core/format'
import type { Environment, HaltReason, IsaPlugin, LineAnalysis, RegisterSpec, StepInfo } from '../../core/isa'
import { parseWord } from './values'

const props = defineProps<{ isa: IsaPlugin; analysis: LineAnalysis }>()
const isa = props.isa
const specs = new Map<number, RegisterSpec>()
for (const b of isa.registers) for (const r of b.registers) specs.set(r.id, r)
const nameOf = (id: number) => specs.get(id)?.name ?? `#${id}`

const texts = reactive(new Map<number, string>())
const cursor = ref(0)
const playing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const inputIds = computed(() => new Set(props.analysis.inputs.map((i) => i.id)))
const isPairHalf = (id: number) => specs.get(id)?.kind === 'float' && inputIds.value.has(id ^ 1)

function defaultText(id: number, value: number): string {
  const spec = specs.get(id)
  if (spec?.kind === 'float' && !isPairHalf(id)) return javaFloat(floatFromBits(value))
  if (spec?.kind === 'int' && Math.abs(value | 0) < 65536) return String(value | 0)
  return hex8(value)
}

function valueOf(id: number, fallback: number): number {
  const t = texts.get(id)
  if (t == null) return fallback
  return parseWord(t, specs.get(id)?.kind === 'float' && !isPairHalf(id)) ?? fallback
}

watch(
  () => `${props.analysis.entry?.key}|${props.analysis.inputs.map((i) => i.id).join(',')}`,
  () => {
    texts.clear()
    cursor.value = 0
    stop()
  },
)

interface Step {
  basic: string
  info: StepInfo
  mem: { addr: number; before: number; after: number }[]
  out: string
}

const trace = computed(() => {
  void lang.value
  const a = props.analysis
  if (!a.program || !a.instructions.length) return null
  let output = ''
  const env: Environment = {
    print: (t) => {
      output += t
    },
    readLine: () => null,
    readChar: () => null,
    dialog: () => null,
    files: { read: () => null, write: () => {}, list: () => [] },
    now: () => Date.now(),
  }
  const m = isa.createMachine(a.program, env)
  for (const inp of a.inputs) m.setRegister(inp.id, valueOf(inp.id, inp.value))
  const first = a.instructions[0]!.addr
  const end = first + 4 * a.instructions.length
  const all = () => Array.from({ length: isa.registerCount }, (_, id) => Number(m.readRegister(id)))
  const regs = [all()]
  const steps: Step[] = []
  const ids = new Set<number>(a.inputs.map((i) => i.id))
  let note = ''
  for (let i = 0; i < a.instructions.length * 2 + 2; i++) {
    const pc = m.programCounter
    if (m.halted || pc < first || pc >= end) break
    const ins = a.instructions.find((x) => x.addr === pc)
    const before = output.length
    let info = m.step()
    if (m.pending) {
      note = t('这条 syscall 要等键盘输入或对话框，演示里不支持；去“编辑运行”里试试。', 'This syscall waits for keyboard input or a dialog, which the demo cannot do; try it under Edit & run.')
      break
    }
    const mem: Step['mem'] = []
    if (info.memory.length && !info.output) {
      const words = [...new Set(info.memory.flatMap((c) => [(c.addr & ~3) >>> 0, ((c.addr + c.size - 1) & ~3) >>> 0]))]
      const after = words.map((w) => m.readWord(w))
      m.undo()
      const prior = words.map((w) => m.readWord(w))
      info = m.step()
      words.forEach((w, j) => mem.push({ addr: w >>> 0, before: prior[j]!, after: after[j]! }))
    }
    steps.push({ basic: ins?.basic ?? '?', info, mem, out: output.slice(before) })
    regs.push(all())
    for (const r of info.reads) ids.add(r)
    for (const w of info.writes) ids.add(w.id)
    // m.step() changes this; read it fresh rather than trusting the narrowing from the loop head
    const h = m.halted as HaltReason | null
    if (h?.kind === 'error' && h.code !== 'bad-pc') {
      note = t(`运行出错：${h.message}`, `Runtime error: ${h.message}`)
      break
    }
    if (h?.kind === 'exit') {
      note = t('程序结束（退出系统调用）。', 'Program finished (exit syscall).')
      break
    }
  }
  ids.delete(0)
  ids.delete(isa.pcRegister)
  return { steps, regs, ids: [...ids].sort((x, y) => x - y), note, first, end, output }
})

const labelAt = computed(() => new Map(props.analysis.labels.map((l) => [l.addr >>> 0, l.name])))

const view = computed(() => {
  const tr = trace.value
  if (!tr) return null
  const k = Math.min(cursor.value, tr.steps.length)
  const step = k > 0 ? tr.steps[k - 1]! : null
  const written = new Map((step?.info.writes ?? []).map((w) => [w.id, Number(w.before)]))
  const read = new Set(step?.info.reads ?? [])
  const regs = tr.ids.map((id) => {
    const value = tr.regs[k]![id]!
    const spec = specs.get(id)
    return {
      id,
      name: nameOf(id),
      hex: spec?.kind === 'flag' ? String(value & 1) : hex8(value),
      groups: binGroups(value),
      dec: spec?.kind === 'float' && !isPairHalf(id) ? javaFloat(floatFromBits(value)) : String(value | 0),
      before: written.has(id) ? hex8(written.get(id)!) : null,
      cls: written.has(id) ? 'w' : read.has(id) ? 'r' : '',
    }
  })
  let pcNote = ''
  if (step) {
    const from = step.info.pc >>> 0
    const to = step.info.nextPc >>> 0
    const name = labelAt.value.get(to)
    if (to === ((from + 4) >>> 0)) pcNote = t(`PC ${hex8(from)} → ${hex8(to)}：顺序执行下一条`, `PC ${hex8(from)} → ${hex8(to)}: falls through to the next instruction`)
    else pcNote = t(`PC ${hex8(from)} → ${hex8(to)}：跳转${name ? `到 ${name}` : ''}`, `PC ${hex8(from)} → ${hex8(to)}: jumps${name ? ` to ${name}` : ''}`)
  }
  return {
    k,
    n: tr.steps.length,
    step,
    regs,
    pcNote,
    output: tr.steps.slice(0, k).map((s) => s.out).join(''),
    done: k >= tr.steps.length,
  }
})

function go(k: number) {
  const n = trace.value?.steps.length ?? 0
  cursor.value = Math.max(0, Math.min(n, k))
}

function stop() {
  playing.value = false
  if (timer) clearInterval(timer)
  timer = null
}

function play() {
  if (playing.value) return stop()
  if (view.value?.done) go(0)
  playing.value = true
  timer = setInterval(() => {
    if (!view.value || view.value.done) return stop()
    go(cursor.value + 1)
  }, 800)
}

function commit(id: number, text: string) {
  texts.set(id, text)
}

onBeforeUnmount(stop)

function summary(s: Step): string {
  const parts = s.info.writes.map((w) => `${nameOf(w.id)} ← ${specs.get(w.id)?.kind === 'flag' ? Number(w.after) & 1 : hex8(Number(w.after))}`)
  for (const m of s.mem) parts.push(`[${hex8(m.addr)}] ← ${hex8(m.after)}`)
  return parts.join(t('，', ', ')) || t('没有改寄存器', 'no register changed')
}
</script>

<template>
  <div v-if="trace && view" class="card demo">
    <div class="dh">
      <b>{{ t('执行演示', 'Step-by-step demo') }}</b>
      <span class="small muted">{{
        analysis.instructions.length > 1
          ? t('在真正的模拟器里一步步执行整个展开', 'Runs the whole expansion on the real simulator, one step at a time')
          : t('在真正的模拟器里一步步执行这条指令', 'Runs this instruction on the real simulator')
      }}</span>
    </div>

    <div v-if="analysis.inputs.length" class="init">
      <span class="small muted">{{ t('初值', 'Start values') }}</span>
      <label v-for="inp in analysis.inputs" :key="inp.id" class="iv">
        <span class="mono small">{{ nameOf(inp.id) }}</span>
        <input
          class="inp"
          :value="texts.get(inp.id) ?? defaultText(inp.id, inp.value)"
          spellcheck="false"
          :aria-label="t(`${nameOf(inp.id)} 的初值`, `start value of ${nameOf(inp.id)}`)"
          @change="commit(inp.id, ($event.target as HTMLInputElement).value)"
        />
      </label>
      <button v-if="texts.size" class="btn" @click="texts.clear()">{{ t('恢复默认', 'Restore defaults') }}</button>
    </div>
    <p v-else class="small muted">{{ t('这条指令不读任何寄存器。', 'This instruction reads no registers.') }}</p>

    <div class="ctrl">
      <button class="btn" :disabled="view.k === 0" @click="go(0)">{{ t('重置', 'Reset') }}</button>
      <button class="btn" :disabled="view.k === 0" @click="go(view.k - 1)">{{ t('上一步', 'Back') }}</button>
      <button class="btn primary" :disabled="view.done" @click="go(view.k + 1)">{{ t('下一步', 'Next') }}</button>
      <button class="btn" :class="{ on: playing }" :disabled="!view.n" @click="play">{{ playing ? t('停止', 'Stop') : t('自动', 'Auto') }}</button>
      <div class="bar" aria-hidden="true"><i :style="{ width: view.n ? (view.k / view.n) * 100 + '%' : '0' }" /></div>
      <span class="small muted">{{ view.k }}/{{ view.n }}</span>
    </div>

    <div class="rows">
      <button class="drow" :class="{ on: view.k === 0 }" @click="go(0)">
        <span class="dn">0</span><span class="dasm muted">{{ t('还没执行', 'not started') }}</span>
      </button>
      <button v-for="(s, i) in trace.steps" :key="i" class="drow" :class="{ on: view.k === i + 1, fut: i + 1 > view.k }" @click="go(i + 1)">
        <span class="dn">{{ i + 1 }}</span>
        <span class="dasm mono">{{ s.basic }}</span>
        <span class="dd mono">{{ summary(s) }}</span>
      </button>
    </div>

    <p v-if="view.pcNote" class="small pc mono">{{ view.pcNote }}</p>
    <div v-if="view.step?.mem.length" class="mem">
      <span v-for="m in view.step.mem" :key="m.addr" class="mono small memchg">{{ t('内存', 'memory') }} [{{ hex8(m.addr) }}] {{ hex8(m.before) }} → <b>{{ hex8(m.after) }}</b></span>
    </div>
    <p v-if="view.output" class="small out">{{ t('输出：', 'Output: ') }}<span class="mono">{{ view.output }}</span></p>
    <p v-if="view.done && trace.note" class="small note">{{ trace.note }}</p>

    <div class="regs">
      <div v-for="r in view.regs" :key="r.id" class="reg" :class="r.cls">
        <span class="n mono">{{ r.name }}</span>
        <span class="h mono">{{ r.hex }}</span>
        <span class="b mono"><i v-for="(g, j) in r.groups" :key="j">{{ g }}</i></span>
        <span class="d mono">{{ r.dec }}</span>
        <span v-if="r.before" class="was mono small">{{ t('原来', 'was') }} {{ r.before }}</span>
      </div>
    </div>
    <p class="small muted legend"><i class="dot r" />{{ t('本步读了', 'read this step') }} <i class="dot w" />{{ t('本步改了', 'written this step') }}</p>
  </div>
</template>

<style scoped>
.demo {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dh {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.init {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
}
.iv {
  display: flex;
  align-items: center;
  gap: 4px;
}
.iv .inp {
  width: 110px;
  font-size: 12px;
}
.ctrl {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.bar {
  flex: 1;
  min-width: 60px;
  height: 4px;
  background: var(--surface-2);
  border-radius: 3px;
  overflow: hidden;
}
.bar > i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.15s;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.drow {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 6px;
  border-radius: 5px;
  cursor: pointer;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.drow:hover {
  background: var(--surface-2);
}
.drow.on {
  background: var(--bg-accent);
}
.drow.fut {
  opacity: 0.55;
}
.dn {
  color: var(--text-muted);
  min-width: 14px;
  font-size: 11px;
}
.dd {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 11.5px;
}
.pc,
.out,
.note {
  margin: 0;
}
.note {
  color: var(--warning);
}
.mem {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.memchg {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-danger);
}
.regs {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.reg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--surface-2);
  border: 1px solid transparent;
  font-size: 12px;
}
.reg.r {
  background: var(--bg-success);
  border-color: color-mix(in srgb, var(--success) 50%, transparent);
}
.reg.w {
  background: var(--bg-danger);
  border-color: color-mix(in srgb, var(--danger) 50%, transparent);
}
.reg.w .h {
  font-weight: 700;
}
.n {
  min-width: 52px;
  color: var(--text-secondary);
}
.h {
  min-width: 88px;
}
.b {
  display: flex;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 11px;
}
.b i {
  font-style: normal;
}
.d {
  color: var(--text-muted);
}
.was {
  color: var(--danger);
}
.legend {
  margin: 0;
  display: flex;
  gap: 4px;
  align-items: center;
}
.dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 3px;
  margin-left: 4px;
}
.dot.r {
  background: var(--bg-success);
  border: 1px solid var(--success);
}
.dot.w {
  background: var(--bg-danger);
  border: 1px solid var(--danger);
}
@media (max-width: 520px) {
  .b {
    flex-basis: 100%;
    font-size: 10px;
  }
}
</style>
