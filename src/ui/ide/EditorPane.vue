<script setup lang="ts">
/** The code editor. Keeps CodeMirror and the session in sync: text, breakpoints, diagnostics, current line. */
import { t } from '../i18n'
import { setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AssembleResult } from '../../core/isa'
import type { SessionHandle } from './useSession'
import { breakpointLines, breakpointsChanged, editorExtensions, setBreakpointLines, setMark, type Mark } from './editor'

const props = defineProps<{ handle: SessionHandle }>()
const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let lastResult: AssembleResult | null = null
let lastMark = ''
const s = props.handle.session

function diagnosticsFor(state: EditorState, result: AssembleResult): CmDiagnostic[] {
  const doc = state.doc
  const out: CmDiagnostic[] = []
  for (const d of result.diagnostics) {
    if (d.file !== s.file.name || d.line < 1 || d.line > doc.lines) continue
    const line = doc.line(d.line)
    let from = d.col > 0 ? Math.min(line.to, line.from + d.col - 1) : line.from
    let to = d.length ? Math.min(line.to, from + d.length) : line.to
    if (to <= from) {
      from = line.from
      to = line.to
    }
    out.push({ from, to, severity: d.severity, message: d.message })
  }
  return out
}

function currentMark(): Mark | null {
  const h = s.halted
  if (h?.kind === 'error' && h.line != null) return { line: h.line, kind: 'error' }
  const line = s.currentLine
  return line != null ? { line, kind: 'exec' } : null
}

function sync() {
  if (!view) return
  const effects = []
  // Text replaced from outside (example, opened file).
  const text = view.state.doc.toString()
  if (text !== s.file.text) {
    const lines = [...s.breakpoints]
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s.file.text } })
    view.dispatch({ effects: setBreakpointLines.of(lines) })
  }
  if (s.result !== lastResult) {
    lastResult = s.result
    view.dispatch(setDiagnostics(view.state, s.result ? diagnosticsFor(view.state, s.result) : []))
  }
  const mark = currentMark()
  const key = mark ? `${mark.kind}:${mark.line}` : ''
  if (key !== lastMark) {
    lastMark = key
    effects.push(setMark.of(mark))
    const scroll = mark && s.mode !== 'running' && mark.line <= view.state.doc.lines
    view.dispatch({
      effects: scroll ? [...effects, EditorView.scrollIntoView(view.state.doc.line(mark.line).from, { y: 'nearest', yMargin: 60 })] : effects,
    })
  }
}

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: s.file.text,
      extensions: editorExtensions(s.isa, [
        EditorView.updateListener.of((u) => {
          if (u.docChanged) s.setSource(u.state.doc.toString())
          if (breakpointsChanged(u.startState, u.state)) s.setBreakpoints(breakpointLines(u.state))
        }),
        EditorView.contentAttributes.of({ 'aria-label': t('汇编代码', 'Assembly code') }),
      ]),
    }),
  })
  view.dispatch({ effects: setBreakpointLines.of([...s.breakpoints]) })
  sync()
})

watch(props.handle.version, sync)

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

/** Move the cursor to a line and focus the editor (from the messages list). */
function goto(line: number, col = 0) {
  if (!view) return
  const doc = view.state.doc
  const l = doc.line(Math.max(1, Math.min(line, doc.lines)))
  const pos = Math.min(l.to, l.from + Math.max(0, col - 1))
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  view.focus()
}

defineExpose({ goto })
</script>

<template>
  <div ref="host" class="editor" />
</template>

<style scoped>
.editor {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.editor :deep(.cm-editor) {
  height: 100%;
}
</style>
