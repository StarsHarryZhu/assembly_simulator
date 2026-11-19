/**
 * CodeMirror 6 setup for any IsaPlugin: highlighting and completion from plugin.language and the catalog,
 * labels (references to a defined label are pink like the definition), section directives (their own
 * colour, a band across the line, always in the first column), a breakpoint gutter, the current-line /
 * error-line highlight, a VS Code-style suggestion list, and a theme built from the CSS tokens.
 */
import { getLocale, L, tx, type Text } from '../../core/i18n'

/** A description in the current language with its {operand} placeholders shown as plain names. */
export function plainDesc(text: Text | undefined): string {
  return text ? tx(text).replace(/\{(\w+)\}/g, '$1') : ''
}
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { lintGutter } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { IsaPlugin } from '../../core/isa'
import { sectionIndent } from '../../core/source'

/* ---------------------------------------------------------------- language */

function asmLanguage(isa: IsaPlugin) {
  const mnemonics = new Set(isa.language.mnemonics)
  const sections = new Set(isa.language.sections)
  const comment = isa.language.commentChar
  return StreamLanguage.define<object>({
    name: 'asm',
    startState: () => ({}),
    token(stream) {
      if (stream.eatSpace()) return null
      const ch = stream.peek()!
      if (ch === comment) {
        stream.skipToEnd()
        return 'comment'
      }
      if (ch === '"' || ch === "'") {
        stream.next()
        let escaped = false
        while (!stream.eol()) {
          const c = stream.next()
          if (escaped) escaped = false
          else if (c === '\\') escaped = true
          else if (c === ch) break
        }
        return 'string'
      }
      if (stream.match(/^\$[A-Za-z0-9]+/)) return 'variableName.special'
      if (stream.match(/^\.[A-Za-z_]\w*/)) return sections.has(stream.current().toLowerCase()) ? 'namespace' : 'meta'
      if (stream.match(/^[-+]?(0x[0-9a-fA-F]+|0b[01]+|\d+(\.\d+)?([eE][-+]?\d+)?)\b/)) return 'number'
      if (stream.match(/^%\w+/)) return 'atom'
      if (stream.match(/^[A-Za-z_][\w.]*/)) {
        if (stream.peek() === ':') return 'labelName'
        return mnemonics.has(stream.current().toLowerCase()) ? 'keyword' : 'variableName'
      }
      stream.next()
      return null
    },
    // Typing one of these inserts its partner, as in VS Code; typing the partner then steps over it.
    languageData: { commentTokens: { line: comment }, closeBrackets: { brackets: ['(', '[', '{', "'", '"'] } },
  })
}

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--series-1)', fontWeight: '600' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.string, color: 'var(--series-3)' },
  { tag: t.number, color: 'var(--series-5)' },
  { tag: t.meta, color: 'var(--series-4)' },
  { tag: t.special(t.variableName), color: 'var(--series-2)' },
  { tag: t.labelName, color: 'var(--series-6)', fontWeight: '600' },
  { tag: t.namespace, color: 'var(--syn-section)', fontWeight: '700' },
  { tag: t.atom, color: 'var(--series-4)' },
])

/* ---------------------------------------------------------------- labels and sections */

interface LineScan {
  /** Labels defined at the start of the line (`name:`). */
  defs: string[]
  /** Identifiers in operand position, as offsets into the line. */
  refs: { from: number; to: number; name: string }[]
  /** The statement is a section directive. */
  section: boolean
}

const TOKEN = /\$\w+|\.[A-Za-z_]\w*|[A-Za-z_][\w.]*|[-+]?\d[\w.]*|%\w+|./y

/** A light scan of one line: label definitions, operand identifiers and section directives. */
export function scanLine(text: string, comment: string, sections: Set<string>): LineScan {
  const out: LineScan = { defs: [], refs: [], section: false }
  let seenOp = false
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (text.startsWith(comment, i)) break
    if (c === '"' || c === "'") {
      i++
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    TOKEN.lastIndex = i
    const tok = TOKEN.exec(text)![0]
    const end = i + tok.length
    if (/^[A-Za-z_]/.test(tok)) {
      let j = end
      while (text[j] === ' ' || text[j] === '\t') j++
      if (!seenOp && text[j] === ':') {
        out.defs.push(tok)
        i = j + 1
        continue
      }
      if (seenOp) out.refs.push({ from: i, to: end, name: tok })
      seenOp = true
    } else if (tok.length > 1 && tok[0] === '.' && !seenOp) {
      seenOp = true
      out.section = sections.has(tok.toLowerCase())
    }
    i = end
  }
  return out
}

/** Every label defined in the document, with the line it is on. */
export function labelsField(comment: string, sections: Set<string>) {
  const collect = (state: EditorState) => {
    const labels = new Map<string, number>()
    let n = 0
    for (const iter = state.doc.iterLines(); !iter.next().done; ) {
      n++
      if (!iter.value.includes(':')) continue
      for (const name of scanLine(iter.value, comment, sections).defs) if (!labels.has(name)) labels.set(name, n)
    }
    return labels
  }
  return StateField.define<Map<string, number>>({
    create: collect,
    update: (labels, tr) => (tr.docChanged ? collect(tr.state) : labels),
  })
}

/** Pink references to defined labels, and a band behind section directive lines (visible lines only). */
function labelAndSectionMarks(labels: StateField<Map<string, number>>, comment: string, sections: Set<string>) {
  const refMark = Decoration.mark({ class: 'cm-label-ref' })
  const sectionLine = Decoration.line({ class: 'cm-section-line' })
  const build = (view: EditorView): DecorationSet => {
    const defined = view.state.field(labels)
    const ranges = []
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; ) {
        const line = view.state.doc.lineAt(pos)
        const scan = scanLine(line.text, comment, sections)
        if (scan.section) ranges.push(sectionLine.range(line.from))
        for (const r of scan.refs) if (defined.has(r.name)) ranges.push(refMark.range(line.from + r.from, line.from + r.to))
        pos = line.to + 1
      }
    }
    return Decoration.set(ranges, true)
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}

/** Typing or pasting a section directive on an indented line moves it to the first column. */
export function flushSectionsOnInput(sections: string[]) {
  if (!sections.length) return []
  const indent = sectionIndent(sections)
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return tr
    const doc = tr.newDoc
    const changes: { from: number; to: number }[] = []
    const seen = new Set<number>()
    tr.changes.iterChangedRanges((_fa, _ta, from, to) => {
      for (let pos = from; pos <= to; ) {
        const line = doc.lineAt(pos)
        if (!seen.has(line.number)) {
          seen.add(line.number)
          const m = indent.exec(line.text)
          if (m) changes.push({ from: line.from, to: line.from + m[0].length })
        }
        pos = line.to + 1
      }
    })
    return changes.length ? [tr, { changes, sequential: true }] : tr
  })
}

/* ---------------------------------------------------------------- modifier-click navigation */

export type NavigationTarget =
  | { kind: 'instruction'; line: string; from: number; to: number }
  | { kind: 'definition'; what: 'label' | 'macro'; name: string; line: number; col: number; from: number; to: number }

interface Piece {
  text: string
  from: number
  to: number
  role: 'label' | 'head' | 'ref'
}

interface Location {
  line: number
  col: number
}

/** Words on one statement line with their role, skipping comments, strings and character literals. */
function linePieces(text: string, comment: string): Piece[] {
  const out: Piece[] = []
  let head = false
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (comment && text.startsWith(comment, i)) break
    if (c === '"' || c === "'") {
      i++
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    TOKEN.lastIndex = i
    const tok = TOKEN.exec(text)![0]
    const end = i + tok.length
    if (/^[A-Za-z_.$][\w.$]*$/.test(tok)) {
      if (!head) {
        let j = end
        while (text[j] === ' ' || text[j] === '\t') j++
        if (text[j] === ':') {
          out.push({ text: tok, from: i, to: end, role: 'label' })
          i = j + 1
          continue
        }
        head = true
        out.push({ text: tok, from: i, to: end, role: 'head' })
      } else out.push({ text: tok, from: i, to: end, role: 'ref' })
    }
    i = end
  }
  return out
}

/** Labels and macros defined in the document, with the line and column of the name. */
function sourceIndex(state: EditorState, comment: string) {
  const labels = new Map<string, Location>()
  const macros = new Map<string, Location>()
  for (let n = 1; n <= state.doc.lines; n++) {
    const pieces = linePieces(state.doc.line(n).text, comment)
    for (const p of pieces) if (p.role === 'label' && !labels.has(p.text)) labels.set(p.text, { line: n, col: p.from })
    const head = pieces[0]
    if (head?.role === 'head' && head.text.toLowerCase() === '.macro' && pieces[1] && !macros.has(pieces[1].text)) {
      macros.set(pieces[1].text, { line: n, col: pieces[1].from })
    }
  }
  return { labels, macros }
}

/** What a modifier-click on `pos` opens, if anything. */
export function navigationTarget(state: EditorState, pos: number, isa: IsaPlugin): NavigationTarget | null {
  if (pos < 0 || pos > state.doc.length) return null
  const line = state.doc.lineAt(pos)
  const off = pos - line.from
  const pieces = linePieces(line.text, isa.language.commentChar)
  const hit = pieces.find((p) => off >= p.from && off < p.to) ?? pieces.find((p) => off === p.to)
  if (!hit || hit.role === 'label') return null
  const at = { from: line.from + hit.from, to: line.from + hit.to }
  const index = sourceIndex(state, isa.language.commentChar)
  if (hit.role === 'head') {
    const macro = index.macros.get(hit.text)
    if (macro) return { kind: 'definition', what: 'macro', name: hit.text, ...macro, ...at }
    if (isa.language.mnemonics.some((m) => m.toLowerCase() === hit.text.toLowerCase())) {
      return { kind: 'instruction', line: line.text.slice(hit.from).trimEnd(), ...at }
    }
    return null
  }
  const label = index.labels.get(hit.text)
  return label ? { kind: 'definition', what: 'label', name: hit.text, ...label, ...at } : null
}

/** "⌘" on a Mac, "Ctrl" everywhere else; used by the click handler and the hover hint. */
export function modifierName(): string {
  if (typeof navigator === 'undefined') return 'Ctrl'
  return /Mac|iPhone|iPad|iPod/.test(`${navigator.platform ?? ''} ${navigator.userAgent}`) ? '⌘' : 'Ctrl'
}

function hintText(target: NavigationTarget): string {
  const mod = modifierName()
  const en = getLocale() === 'en'
  if (target.kind === 'instruction') return en ? `${mod}-click: open in the instruction set` : `${mod} 点击：在指令集中打开`
  if (target.what === 'macro') return en ? `${mod}-click: go to the macro definition` : `${mod} 点击：跳到宏定义`
  return en ? `${mod}-click: go to the label definition` : `${mod} 点击：跳到标签定义`
}

function navHint(isa: IsaPlugin): Extension {
  return hoverTooltip(
    (view, pos) => {
      const target = navigationTarget(view.state, pos, isa)
      if (!target) return null
      return {
        pos: target.from,
        end: target.to,
        above: true,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-nav-tip'
          dom.textContent = hintText(target)
          return { dom }
        },
      }
    },
    { hoverTime: 350 },
  )
}

export interface NavigationHandlers {
  /** A mnemonic was modifier-clicked: open its statement (labels and indentation stripped) in the calculator. */
  onInstruction(line: string): void
  /** A label reference or macro call was modifier-clicked: jump to its definition (1-based line, 0-based column). */
  onDefinition(line: number, col: number): void
}

/** Modifier-click navigation and its hover hint. */
export function editorNavigation(isa: IsaPlugin, handlers: NavigationHandlers): Extension[] {
  return [
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || event.altKey || event.shiftKey) return false
        if (modifierName() === '⌘' ? !event.metaKey : !event.ctrlKey) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false
        const target = navigationTarget(view.state, pos, isa)
        if (!target) return false
        event.preventDefault()
        if (target.kind === 'instruction') handlers.onInstruction(target.line)
        else handlers.onDefinition(target.line, target.col)
        return true
      },
    }),
    navHint(isa),
  ]
}

/* ---------------------------------------------------------------- completion */

type Kind = 'instruction' | 'register' | 'directive' | 'label'

/** Outline icons in the spirit of VS Code's symbol icons, drawn as inline SVG. */
const ICON_PATHS: Record<Kind, string> = {
  instruction: 'M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM2.5 4.8L8 7.8l5.5-3M8 7.8v6.4',
  register: 'M5.5 3.5h-2v9h2M10.5 3.5h2v9h-2M6.5 6.5h3v3h-3z',
  directive: 'M3 4.5h10M3 8h10M3 11.5h6',
  label: 'M2.5 4h7l4 4-4 4h-7zM6 8h.01',
}
const SVG = 'http://www.w3.org/2000/svg'

function icon(kind: string): Node {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('class', `cm-asm-icon cm-asm-icon-${kind}`)
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', ICON_PATHS[kind as Kind] ?? ICON_PATHS.directive)
  svg.appendChild(path)
  return svg
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  e.className = cls
  if (text != null) e.textContent = text
  return e
}

export function completer(isa: IsaPlugin, labels: StateField<Map<string, number>>) {
  const byName = new Map<string, string[]>()
  const descs = new Map<string, Text>()
  for (const e of isa.catalog) {
    const list = byName.get(e.mnemonic) ?? []
    list.push(e.example)
    byName.set(e.mnemonic, list)
    if (!descs.has(e.mnemonic)) descs.set(e.mnemonic, e.description)
  }
  // The details panel: first form, description, every form.
  const docFor = (name: string, examples: string[]) => () => {
    const box = el('div', 'cm-asm-doc')
    box.appendChild(el('div', 'cm-asm-doc-head', examples[0]!))
    box.appendChild(el('div', 'cm-asm-doc-desc', plainDesc(descs.get(name))))
    if (examples.length > 1) {
      box.appendChild(el('div', 'cm-asm-doc-title', L(`${examples.length} 种写法`, `${examples.length} forms`)))
      const list = box.appendChild(el('div', 'cm-asm-doc-forms'))
      for (const ex of examples.slice(0, 14)) list.appendChild(el('div', '', ex))
      if (examples.length > 14) list.appendChild(el('div', '', '…'))
    }
    return box
  }
  // Rebuilt when the language changes: the detail text is localized.
  let cached: { locale: string; options: Completion[] } | null = null
  const mnemonicOptions = (): Completion[] => {
    if (cached?.locale === getLocale()) return cached.options
    const options = [...byName].map(([name, examples]) => ({
      label: name,
      type: 'instruction',
      detail: examples[0]!.slice(name.length).trim() + (examples.length > 1 ? L(`  +${examples.length - 1} 种写法`, `  +${examples.length - 1} forms`) : ''),
      info: docFor(name, examples),
    }))
    cached = { locale: getLocale(), options }
    return options
  }
  const regNotes = new Map<string, () => string>()
  for (const bank of isa.registers) {
    for (const r of bank.registers) {
      regNotes.set(r.name, () => (r.note ? tx(r.note) : ''))
      if (r.kind === 'int' && r.number != null) regNotes.set(`$${r.number}`, () => `= ${r.name}`)
    }
  }
  const registers = (): Completion[] => isa.language.registers.map((r) => ({ label: r, type: 'register', detail: regNotes.get(r)?.() ?? '' }))
  const directives: Completion[] = isa.language.directives.map((d) => ({ label: d, type: 'directive' }))
  const atStatementStart = (before: string) => /^\s*([\w.]+:\s*)*$/.test(before)
  return (ctx: CompletionContext) => {
    const word = ctx.matchBefore(/[$.%]?[\w.]*/)
    if (!word || (word.from === word.to && !ctx.explicit)) return null
    const before = ctx.state.sliceDoc(ctx.state.doc.lineAt(ctx.pos).from, word.from)
    if (before.includes(isa.language.commentChar) || /["']/.test(before)) return null
    if (word.text.startsWith('$')) return { from: word.from, options: registers(), validFor: /^\$\w*$/ }
    if (word.text.startsWith('.') && atStatementStart(before)) return { from: word.from, options: directives, validFor: /^\.\w*$/ }
    if (atStatementStart(before)) return { from: word.from, options: mnemonicOptions(), validFor: /^[\w.]*$/ }
    if (/^[A-Za-z_]?[\w.]*$/.test(word.text)) {
      const own = ctx.state.doc.lineAt(ctx.pos).number
      const options = [...ctx.state.field(labels)]
        .filter(([, line]) => line !== own)
        .map(([name, line]) => ({ label: name, type: 'label', detail: L(`第 ${line} 行`, `line ${line}`) }))
      return options.length ? { from: word.from, options, validFor: /^[\w.]*$/ } : null
    }
    return null
  }
}

/* ---------------------------------------------------------------- breakpoints */

const toggleBreakpoint = StateEffect.define<number>()
export const setBreakpointLines = StateEffect.define<number[]>()

class BreakpointMarker extends GutterMarker {
  override toDOM() {
    const dot = document.createElement('span')
    dot.className = 'cm-bp'
    dot.title = L('断点（再点一次取消）', 'Breakpoint (click again to remove)')
    return dot
  }
}
const marker = new BreakpointMarker()

const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(toggleBreakpoint)) {
        const pos = e.value
        let has = false
        set.between(pos, pos, () => {
          has = true
        })
        set = has ? set.update({ filter: (from) => from !== pos }) : set.update({ add: [marker.range(pos)] })
      } else if (e.is(setBreakpointLines)) {
        const doc = tr.state.doc
        const lines = [...new Set(e.value)].filter((n) => n >= 1 && n <= doc.lines).sort((a, b) => a - b)
        set = RangeSet.of(lines.map((n) => marker.range(doc.line(n).from)))
      }
    }
    return set
  },
})

export function breakpointLines(state: EditorState): number[] {
  const out: number[] = []
  state.field(breakpointField).between(0, state.doc.length, (from) => {
    out.push(state.doc.lineAt(from).number)
  })
  return [...new Set(out)]
}

export function breakpointsChanged(a: EditorState, b: EditorState): boolean {
  return a.field(breakpointField) !== b.field(breakpointField)
}

const toggleAt = (view: EditorView, pos: number) => {
  view.dispatch({ effects: toggleBreakpoint.of(view.state.doc.lineAt(pos).from) })
  return true
}

/* ---------------------------------------------------------------- execution line */

export interface Mark {
  line: number
  kind: 'exec' | 'error'
}
export const setMark = StateEffect.define<Mark | null>()

const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setMark)) continue
      const m = e.value
      if (!m || m.line < 1 || m.line > tr.state.doc.lines) deco = Decoration.none
      else deco = Decoration.set([Decoration.line({ class: m.kind === 'exec' ? 'cm-exec' : 'cm-err-line' }).range(tr.state.doc.line(m.line).from)])
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

/* ---------------------------------------------------------------- theme */

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--surface-1)', color: 'var(--text-primary)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 24%, transparent) !important',
  },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { cursor: 'pointer', padding: '0 6px 0 4px', minWidth: '30px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-3)', color: 'var(--text-primary)' },
  '.cm-exec': { backgroundColor: 'var(--bg-accent)', boxShadow: 'inset 3px 0 var(--accent)' },
  '.cm-err-line': { backgroundColor: 'var(--bg-danger)', boxShadow: 'inset 3px 0 var(--danger)' },
  '.cm-bp-gutter .cm-gutterElement': { width: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  '.cm-bp': { display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', backgroundColor: 'var(--danger)' },
  '.cm-label-ref': { color: 'var(--series-6)' },
  '.cm-section-line': { backgroundColor: 'var(--bg-section)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)' },
  '.cm-nav-tip': { padding: '3px 8px', fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' },
  // Suggestion list in the style of VS Code's suggest widget.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--suggest-bg)',
    border: '1px solid var(--suggest-border)',
    borderRadius: '3px',
    boxShadow: '0 0 8px 2px var(--suggest-shadow)',
    color: 'var(--suggest-fg)',
    padding: '0',
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    maxHeight: '264px',
    minWidth: 'min(360px, calc(100vw - 40px))',
    maxWidth: 'min(520px, calc(100vw - 40px))',
    scrollbarWidth: 'thin',
    scrollbarColor: 'var(--suggest-scroll) transparent',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    height: '22px',
    lineHeight: '22px',
    padding: '0 8px 0 6px',
    cursor: 'pointer',
    color: 'var(--suggest-fg)',
  },
  '.cm-tooltip-autocomplete > ul > li:hover': { backgroundColor: 'var(--suggest-hover)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--suggest-sel-bg)', color: 'var(--suggest-sel-fg)' },
  '.cm-completionLabel': { flex: 'none', whiteSpace: 'pre' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--suggest-match)', fontWeight: '700' },
  '.cm-tooltip-autocomplete li[aria-selected] .cm-completionMatchedText': { color: 'var(--suggest-sel-match)' },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    paddingLeft: '18px',
    color: 'var(--suggest-muted)',
    fontStyle: 'normal',
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-tooltip-autocomplete li[aria-selected] .cm-completionDetail': { color: 'inherit', opacity: '0.8' },
  '.cm-asm-icon': {
    width: '16px',
    height: '16px',
    flex: 'none',
    marginRight: '6px',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.2',
    strokeLinejoin: 'round',
    strokeLinecap: 'round',
  },
  '.cm-asm-icon-instruction': { color: 'var(--suggest-icon-instr)' },
  '.cm-asm-icon-register': { color: 'var(--suggest-icon-reg)' },
  '.cm-asm-icon-directive': { color: 'var(--suggest-icon-dir)' },
  '.cm-asm-icon-label': { color: 'var(--series-6)', strokeWidth: '1.4' },
  '.cm-tooltip-autocomplete li[aria-selected] .cm-asm-icon': { color: 'inherit' },
  '.cm-tooltip.cm-completionInfo': {
    backgroundColor: 'var(--suggest-bg)',
    border: '1px solid var(--suggest-border)',
    borderRadius: '3px',
    boxShadow: '0 0 8px 2px var(--suggest-shadow)',
    color: 'var(--suggest-fg)',
    padding: '6px 10px 8px',
    maxWidth: 'min(420px, calc(100vw - 40px))',
    whiteSpace: 'normal',
  },
  '.cm-asm-doc-head': { fontFamily: 'var(--font-mono)', fontSize: '12.5px', fontWeight: '600', marginBottom: '4px' },
  '.cm-asm-doc-desc': { fontFamily: 'var(--font-sans)', fontSize: '12.5px', lineHeight: '1.5' },
  '.cm-asm-doc-title': { fontFamily: 'var(--font-sans)', fontSize: '11.5px', color: 'var(--suggest-muted)', margin: '8px 0 2px' },
  '.cm-asm-doc-forms': { fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: '1.55', whiteSpace: 'pre' },
  '.cm-diagnostic': { fontFamily: 'var(--font-sans)', fontSize: '12.5px' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text-primary)' },
  '.cm-searchMatch': { backgroundColor: 'var(--bg-warning)' },
  '.cm-textfield': { backgroundColor: 'var(--surface-1)', border: '1px solid var(--border)', color: 'var(--text-primary)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface-1)', border: '1px solid var(--border)', color: 'var(--text-primary)' },
})

export function editorExtensions(isa: IsaPlugin, extra: Extension[] = []): Extension[] {
  const sections = new Set(isa.language.sections)
  const labels = labelsField(isa.language.commentChar, sections)
  return [
    breakpointField,
    gutter({
      class: 'cm-bp-gutter',
      markers: (v) => v.state.field(breakpointField),
      initialSpacer: () => marker,
      domEventHandlers: { mousedown: (view, line) => toggleAt(view, line.from) },
    }),
    lineNumbers({ domEventHandlers: { mousedown: (view, line) => toggleAt(view, line.from) } }),
    lintGutter(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    asmLanguage(isa),
    syntaxHighlighting(highlight),
    labels,
    labelAndSectionMarks(labels, isa.language.commentChar, sections),
    flushSectionsOnInput(isa.language.sections),
    closeBrackets(),
    autocompletion({
      override: [completer(isa, labels)],
      icons: false,
      addToOptions: [{ render: (c) => icon(c.type ?? ''), position: 20 }],
    }),
    highlightActiveLine(),
    highlightSelectionMatches(),
    markField,
    // Tab accepts a suggestion as in VS Code; otherwise it indents.
    keymap.of([{ key: 'Tab', run: acceptCompletion }, ...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    theme,
    ...extra,
  ]
}
