/**
 * CodeMirror 6 setup for any IsaPlugin: highlighting and completion from plugin.language and the catalog,
 * labels (references to a defined label are pink like the definition), section directives (their own
 * colour, a band across the line, always in the first column), a breakpoint gutter, the current-line /
 * error-line highlight, a VS Code-style suggestion list, the Format transaction, and a theme built from the
 * CSS tokens.
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
  type CompletionResult,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, invertedEffects, isolateHistory } from '@codemirror/commands'
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting, type StringStream } from '@codemirror/language'
import { lintGutter } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { ChangeSet, EditorState, Facet, RangeSet, StateEffect, StateField, type Extension, type TransactionSpec } from '@codemirror/state'
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
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { IsaPlugin, LabelKind, ReferenceTable, RefRow } from '../../core/isa'
import { sectionIndent, whitespaceChanges } from '../../core/source'

/* ---------------------------------------------------------------- language */

/** The ISA's register test for highlighting: its own, or membership in its register list. */
function registerTest(isa: IsaPlugin): (word: string) => boolean {
  if (isa.language.isRegister) return isa.language.isRegister
  const names = new Set(isa.language.registers.map((r) => r.toLowerCase()))
  return (word) => names.has(word.toLowerCase())
}

function asmLanguage(isa: IsaPlugin) {
  const mnemonics = new Set(isa.language.mnemonics)
  const sections = new Set(isa.language.sections)
  const { commentChar: comment, lineStartComment, blockComment: block } = isa.language
  const isRegister = registerTest(isa)
  /** The rest of a block comment from the stream's position: to its end, or to the end of the line. */
  const blockRest = (stream: StringStream, state: { block: boolean }) => {
    const end = stream.string.indexOf(block![1], stream.pos)
    if (end < 0) stream.skipToEnd()
    else {
      stream.pos = end + block![1].length
      state.block = false
    }
    return 'comment'
  }
  return StreamLanguage.define<{ block: boolean }>({
    name: 'asm',
    startState: () => ({ block: false }),
    copyState: (state) => ({ block: state.block }),
    token(stream, state) {
      if (state.block) return blockRest(stream, state)
      if (stream.eatSpace()) return null
      const ch = stream.peek()!
      if (lineStartComment && !stream.string.slice(0, stream.pos).trim() && stream.match(lineStartComment)) {
        stream.skipToEnd()
        return 'comment'
      }
      if (block && stream.match(block[0])) {
        state.block = true
        return blockRest(stream, state)
      }
      if (comment && stream.match(comment)) {
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
      if (stream.match(/^[-+]?(0x[0-9a-fA-F]+|0b[01]+|\d+(\.\d+)?([eE][-+]?\d+)?)\b/)) return 'number'
      if (stream.match(/^%\w+/)) return 'atom'
      // An immediate's '#' (GNU as on ARM) reads with its number.
      if (ch === '#') {
        stream.next()
        return 'number'
      }
      // Identifiers as the assembler reads them: registers ($t0), directives (.word), labels (.L1, a$b).
      if (stream.match(/^\.?[A-Za-z_$][\w.$]*/)) {
        const word = stream.current()
        if (/^[ \t]*:/.test(stream.string.slice(stream.pos))) return 'labelName'
        if (isRegister(word)) return 'variableName.special'
        if (word[0] === '.') return sections.has(word.toLowerCase()) ? 'namespace' : 'meta'
        return mnemonics.has(word.toLowerCase()) ? 'keyword' : 'variableName'
      }
      stream.next()
      return null
    },
    // Typing one of these inserts its partner, as in VS Code; typing the partner then steps over it.
    languageData: {
      commentTokens: { line: comment, ...(block ? { block: { open: block[0], close: block[1] } } : {}) },
      closeBrackets: { brackets: ['(', '[', '{', "'", '"'] },
    },
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

/* ---------------------------------------------------------------- one scan per line, one index per document */

/** How an ISA writes comments and statements, as far as the line scan needs it. */
export interface LineSyntax {
  /** Starts a comment that runs to the end of the line. */
  comment: string
  /** Starts a comment only as the first text of a line. */
  lineStartComment?: string
  /** Block comment delimiters; such a comment may span lines. */
  block?: [string, string]
  /** Separates statements on one line. */
  separator?: string
}

/** The line syntax of an ISA. */
export function lineSyntax(isa: IsaPlugin): LineSyntax {
  const l = isa.language
  return { comment: l.commentChar, lineStartComment: l.lineStartComment, block: l.blockComment, separator: l.statementSeparator }
}

interface AsmSyntax extends LineSyntax {
  /** Section directives, lower case. */
  sections: Set<string>
  /** The section directives whose labels name data, lower case. */
  dataSections: Set<string>
}

/** The comment character and section directives of the ISA being edited. */
const asmSyntax = Facet.define<AsmSyntax, AsmSyntax>({
  combine: (values) => values[0] ?? { comment: '#', sections: new Set(), dataSections: new Set() },
})

/** A word of a statement: a label definition, the head (mnemonic, directive or macro name), or an operand. */
export interface Piece {
  text: string
  from: number
  to: number
  role: 'label' | 'head' | 'ref'
}

export interface ScannedLine {
  pieces: Piece[]
  /** The head is a section directive (`.text`, `.data`, …). */
  section: boolean
  /** Where a comment starts on this line, or null. A block comment that closes on the line does not count. */
  comment: number | null
  /** The line ends inside a block comment. */
  inBlock: boolean
}

/** Numbers, identifiers as the assembler reads them (`$t0`, `.word`, `.L1`, `a$b`), macro parameters, any other character. */
const TOKEN = /[-+]?\d[\w.]*|\.?[A-Za-z_$][\w.$]*|%\w+|./y
const IDENT = /^\.?[A-Za-z_$]/

/**
 * The one scan behind every editor feature (pink label references, section bands, label suggestions,
 * modifier-click): the words of a line with their roles, skipping comments, strings and character literals.
 * `inBlock` says the line starts inside a block comment; the result says whether it ends inside one.
 * After a statement separator the next word is a head again.
 */
export function scanLine(text: string, syntax: LineSyntax | string, sections: Set<string>, inBlock = false): ScannedLine {
  const { comment, lineStartComment, block, separator } = typeof syntax === 'string' ? { comment: syntax } : syntax
  const pieces: Piece[] = []
  let section = false
  let head = false
  let first = true
  let commentAt: number | null = null
  let i = 0
  while (i < text.length) {
    if (inBlock) {
      const end = text.indexOf(block![1], i)
      if (end < 0) break
      inBlock = false
      i = end + block![1].length
      continue
    }
    const c = text[i]!
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (first && lineStartComment && text.startsWith(lineStartComment, i)) {
      commentAt = i
      break
    }
    first = false
    if (block && text.startsWith(block[0], i)) {
      const end = text.indexOf(block[1], i + block[0].length)
      if (end < 0) {
        commentAt = i
        inBlock = true
        break
      }
      i = end + block[1].length
      continue
    }
    if (comment && text.startsWith(comment, i)) {
      commentAt = i
      break
    }
    if (separator && c === separator) {
      head = false
      i++
      continue
    }
    if (c === '"' || c === "'") {
      i++
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    TOKEN.lastIndex = i
    const tok = TOKEN.exec(text)![0]
    const end = i + tok.length
    if (IDENT.test(tok)) {
      if (!head) {
        let j = end
        while (text[j] === ' ' || text[j] === '\t') j++
        if (text[j] === ':') {
          pieces.push({ text: tok, from: i, to: end, role: 'label' })
          i = j + 1
          continue
        }
        head = true
        section = sections.has(tok.toLowerCase())
        pieces.push({ text: tok, from: i, to: end, role: 'head' })
      } else pieces.push({ text: tok, from: i, to: end, role: 'ref' })
    }
    i = end
  }
  return { pieces, section, comment: commentAt, inBlock }
}

interface Location {
  /** 1-based line. */
  line: number
  /** 0-based column of the name. */
  col: number
}

export interface LabelDef extends Location {
  /** Data when it is defined in a data section (`.data`, `.kdata`), code otherwise. */
  kind: LabelKind
  /** The statement it names, without the comment: its own line's, or the next statement's when alone. */
  decl: string
}

export interface SourceIndex {
  labels: Map<string, LabelDef>
  macros: Map<string, Location>
  /** Lines (1-based) that start inside a block comment. */
  blockLines: Set<number>
}

/** A statement's text from `from` on, without the trailing comment. */
const statementText = (text: string, from: number, scan: ScannedLine) => text.slice(from, scan.comment ?? text.length).trim()

const SECTION_HEAD = /^\s*(\.[A-Za-z]\w*)/

/**
 * Labels (the first on a line, as the assembler takes them) with their kind and statement, and macros.
 * Only lines with a colon, a section directive or `.macro` are scanned, plus the line after a lone label.
 */
function buildIndex(state: EditorState): SourceIndex {
  const syntax = state.facet(asmSyntax)
  const { sections, dataSections, block } = syntax
  const labels = new Map<string, LabelDef>()
  const macros = new Map<string, Location>()
  const blockLines = new Set<number>()
  let inData = false
  let inBlock = false
  let waiting: LabelDef[] = [] // lone labels whose statement is on a later line
  let n = 0
  for (const iter = state.doc.iterLines(); !iter.next().done; ) {
    n++
    const text = iter.value
    const started = inBlock
    if (started) blockLines.add(n)
    // Lines with nothing to index are skipped, unless a block comment could open or close on them.
    if (!waiting.length && !text.includes(':') && !/\.macro/i.test(text) && !SECTION_HEAD.test(text)) {
      if (block && (inBlock || text.includes(block[0]))) inBlock = scanLine(text, syntax, sections, inBlock).inBlock
      continue
    }
    const scan = scanLine(text, syntax, sections, started)
    inBlock = scan.inBlock
    const { pieces } = scan
    const h = pieces.findIndex((p) => p.role === 'head')
    if (h >= 0 && sections.has(pieces[h]!.text.toLowerCase())) inData = dataSections.has(pieces[h]!.text.toLowerCase())
    if (h >= 0 && waiting.length && !sections.has(pieces[h]!.text.toLowerCase())) {
      const decl = statementText(text, pieces[h]!.from, scan)
      for (const d of waiting) d.decl = decl
      waiting = []
    }
    const first = pieces[0]
    if (first?.role === 'label' && !labels.has(first.text)) {
      const def: LabelDef = { line: n, col: first.from, kind: inData ? 'data' : 'code', decl: '' }
      labels.set(first.text, def)
      if (h >= 0) def.decl = statementText(text, pieces[h]!.from, scan)
      else waiting.push(def)
    }
    const name = pieces[h + 1]
    if (h >= 0 && pieces[h]!.text.toLowerCase() === '.macro' && name && !macros.has(name.text)) macros.set(name.text, { line: n, col: name.from })
  }
  return { labels, macros, blockLines }
}

/** Rebuilt once per document change and shared, so hovering and highlighting never rescan the file. */
const sourceIndexField = StateField.define<SourceIndex>({
  create: buildIndex,
  update: (index, tr) => (tr.docChanged ? buildIndex(tr.state) : index),
})

/** The document's labels and macros (computed on the spot when the field is not installed). */
export function sourceIndex(state: EditorState): SourceIndex {
  return state.field(sourceIndexField, false) ?? buildIndex(state)
}

/** Pink references to defined labels, and a band behind section directive lines (visible lines only). */
function labelAndSectionMarks(): Extension {
  const refMark = Decoration.mark({ class: 'cm-label-ref' })
  const sectionLine = Decoration.line({ class: 'cm-section-line' })
  const build = (view: EditorView): DecorationSet => {
    const syntax = view.state.facet(asmSyntax)
    const index = sourceIndex(view.state)
    const defined = index.labels
    const ranges = []
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; ) {
        const line = view.state.doc.lineAt(pos)
        const scan = scanLine(line.text, syntax, syntax.sections, index.blockLines.has(line.number))
        if (scan.section) ranges.push(sectionLine.range(line.from))
        for (const p of scan.pieces) if (p.role === 'ref' && defined.has(p.text)) ranges.push(refMark.range(line.from + p.from, line.from + p.to))
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

const mnemonicSets = new WeakMap<IsaPlugin, Set<string>>()
function isMnemonic(isa: IsaPlugin, word: string): boolean {
  let set = mnemonicSets.get(isa)
  if (!set) mnemonicSets.set(isa, (set = new Set(isa.language.mnemonics.map((m) => m.toLowerCase()))))
  return set.has(word.toLowerCase())
}

/** What a modifier-click on `pos` opens, if anything. */
export function navigationTarget(state: EditorState, pos: number, isa: IsaPlugin): NavigationTarget | null {
  if (pos < 0 || pos > state.doc.length) return null
  const line = state.doc.lineAt(pos)
  const off = pos - line.from
  const syntax = state.facet(asmSyntax)
  const { pieces } = scanLine(line.text, syntax, syntax.sections, sourceIndex(state).blockLines.has(line.number))
  const hit = pieces.find((p) => off >= p.from && off < p.to) ?? pieces.find((p) => off === p.to)
  if (!hit || hit.role === 'label') return null
  const at = { from: line.from + hit.from, to: line.from + hit.to }
  const index = sourceIndex(state)
  if (hit.role === 'head') {
    const macro = index.macros.get(hit.text)
    if (macro) return { kind: 'definition', what: 'macro', name: hit.text, ...macro, ...at }
    // A mnemonic or a directive opens its statement in the instruction set tab.
    if (isMnemonic(isa, hit.text) || isa.language.directives.includes(hit.text.toLowerCase())) return { kind: 'instruction', line: line.text.slice(hit.from).trimEnd(), ...at }
    return null
  }
  const label = index.labels.get(hit.text)
  return label ? { kind: 'definition', what: 'label', name: hit.text, line: label.line, col: label.col, ...at } : null
}

/** macOS or iOS, where shortcuts use ⌘ and ⌥ and are written with symbols. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(`${navigator.platform ?? ''} ${navigator.userAgent}`)
}

/** How the Format shortcut (VS Code's Format Document) is written on this platform. */
export function formatShortcut(): string {
  return isMacPlatform() ? '⇧⌥F' : 'Shift+Alt+F'
}

/** The modifier VS Code uses for Go to Definition on this platform. */
function linkModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey
}

const setNavLink = StateEffect.define<{ from: number; to: number } | null>()

const navLinkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(links, tr) {
    links = links.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setNavLink)) continue
      links = effect.value ? Decoration.set([Decoration.mark({ class: 'cm-nav-link' }).range(effect.value.from, effect.value.to)]) : Decoration.none
    }
    return links
  },
  provide: (field) => EditorView.decorations.from(field),
})

function linkedSpan(view: EditorView): { from: number; to: number } | null {
  let link: { from: number; to: number } | null = null
  view.state.field(navLinkField).between(0, view.state.doc.length, (from, to) => {
    link = { from, to }
    return false
  })
  return link
}

/**
 * VS Code-style link feedback. Holding the Go to Definition modifier underlines the clickable token under the
 * pointer and turns the cursor into a hand; releasing it (or leaving the token) restores the normal text cursor.
 */
function navigationFeedback(isa: IsaPlugin): Extension {
  const mac = isMacPlatform()
  return ViewPlugin.fromClass(
    class {
      private pointer: { x: number; y: number } | null = null
      private active = false
      private readonly win: Window | null
      private readonly onMove = (event: MouseEvent) => {
        if (event.buttons !== 0) return
        this.pointer = { x: event.clientX, y: event.clientY }
        this.active = linkModifier(event)
        this.refresh()
      }
      private readonly onLeave = () => {
        this.active = false
        this.pointer = null
        this.clear()
      }
      private readonly onKey = (event: KeyboardEvent) => {
        if (event.key !== (mac ? 'Meta' : 'Control')) return
        this.active = event.type === 'keydown'
        this.refresh()
      }
      private readonly onBlur = () => {
        this.active = false
        this.refresh()
      }
      private readonly onScroll = () => this.refresh()

      constructor(private readonly view: EditorView) {
        this.win = view.dom.ownerDocument.defaultView
        view.dom.addEventListener('mousemove', this.onMove)
        view.dom.addEventListener('mouseleave', this.onLeave)
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
        this.win?.addEventListener('keydown', this.onKey, true)
        this.win?.addEventListener('keyup', this.onKey, true)
        this.win?.addEventListener('blur', this.onBlur)
      }

      destroy() {
        this.view.dom.removeEventListener('mousemove', this.onMove)
        this.view.dom.removeEventListener('mouseleave', this.onLeave)
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
        this.win?.removeEventListener('keydown', this.onKey, true)
        this.win?.removeEventListener('keyup', this.onKey, true)
        this.win?.removeEventListener('blur', this.onBlur)
      }

      private refresh() {
        if (!this.active || !this.pointer) {
          this.clear()
          return
        }
        const pos = this.view.posAtCoords(this.pointer)
        const target = pos == null ? null : navigationTarget(this.view.state, pos, isa)
        const next = target ? { from: target.from, to: target.to } : null
        const current = linkedSpan(this.view)
        if (next?.from === current?.from && next?.to === current?.to) return
        this.view.dispatch({ effects: setNavLink.of(next) })
      }

      private clear() {
        if (linkedSpan(this.view)) this.view.dispatch({ effects: setNavLink.of(null) })
      }
    },
  )
}

export interface NavigationHandlers {
  /** A mnemonic was modifier-clicked: open its statement (labels and indentation stripped) in the calculator. */
  onInstruction(line: string): void
  /** A label reference or macro call was modifier-clicked: jump to its definition (1-based line, 0-based column). */
  onDefinition(line: number, col: number): void
}

/** Modifier-click navigation with VS Code-style underline and pointer feedback. */
export function editorNavigation(isa: IsaPlugin, handlers: NavigationHandlers): Extension[] {
  return [
    navLinkField,
    navigationFeedback(isa),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || event.altKey || event.shiftKey) return false
        if (!linkModifier(event)) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false
        const target = navigationTarget(view.state, pos, isa)
        if (!target) return false
        event.preventDefault()
        view.dispatch({ effects: setNavLink.of(null) })
        if (target.kind === 'instruction') handlers.onInstruction(target.line)
        else handlers.onDefinition(target.line, target.col)
        return true
      },
    }),
  ]
}

/* ---------------------------------------------------------------- completion */

type Kind = 'instruction' | 'register' | 'directive' | 'label' | 'data'

/** Outline icons in the spirit of VS Code's symbol icons, drawn as inline SVG. */
const ICON_PATHS: Record<Kind, string> = {
  instruction: 'M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM2.5 4.8L8 7.8l5.5-3M8 7.8v6.4',
  register: 'M5.5 3.5h-2v9h2M10.5 3.5h2v9h-2M6.5 6.5h3v3h-3z',
  directive: 'M3 4.5h10M3 8h10M3 11.5h6',
  label: 'M2.5 4h7l4 4-4 4h-7zM6 8h.01',
  // A row of memory cells.
  data: 'M1.5 5.5h13v5h-13zM5.8 5.5v5M10.2 5.5v5',
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

/**
 * Operands split at the commas between them; commas inside `[…]` (an ARM address) or `{…}` (a register list)
 * belong to one operand. Parentheses do not group, so MIPS macro arguments count as before.
 */
export function splitOperands(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '[' || c === '{') depth++
    else if ((c === ']' || c === '}') && depth > 0) depth--
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

export function completer(isa: IsaPlugin) {
  const syntax = lineSyntax(isa)
  const sectionSet = new Set(isa.language.sections.map((d) => d.toLowerCase()))
  const byName = new Map<string, string[]>()
  const descs = new Map<string, Text>()
  for (const e of isa.catalog) {
    const list = byName.get(e.mnemonic) ?? []
    list.push(e.example)
    byName.set(e.mnemonic, list)
    if (!descs.has(e.mnemonic)) descs.set(e.mnemonic, e.description)
  }
  const references = new Map<string, ReferenceTable[]>()
  for (const table of isa.references ?? []) for (const m of table.mnemonics) references.set(m, [...(references.get(m) ?? []), table])
  // The details panel: first form, description, every form, then a short index of each reference table.
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
    const tables = references.get(name)
    if (tables) {
      const index = box.appendChild(el('div', 'cm-asm-doc-refs'))
      for (const table of tables) {
        index.appendChild(el('div', 'cm-asm-doc-title', tx(table.title)))
        for (const g of table.groups) {
          if (g.title) index.appendChild(el('div', 'cm-asm-doc-group', tx(g.title)))
          const grid = index.appendChild(el('div', 'cm-asm-doc-keys'))
          for (const r of g.rows) {
            grid.appendChild(el('span', 'cm-asm-doc-key', r.key.split(/\s+/).join(' ')))
            grid.appendChild(el('span', '', tx(r.title)))
          }
        }
      }
      const mod = isMacPlatform() ? '⌘' : 'Ctrl'
      box.appendChild(
        el('div', 'cm-asm-doc-hint', L(`${mod}+点击代码里的 ${name}，在“指令集”里看完整的表。`, `${mod}-click ${name} in the code for the full table in the Instruction set tab.`)),
      )
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
  // Named registers can be typed without their prefix: "t0" offers $t0 and writes it in full. Numbered ones
  // ($4) still need it, so a plain number never turns into a register. ISAs without a prefix (x0, v0) are
  // offered as they are.
  const bare = isa.language.registers.map((r) => ({ r, name: r.replace(/^[^\w]+/, '') })).filter(({ name }) => /^[A-Za-z]/.test(name))
  const bareRegisters = (boost: number): Completion[] =>
    bare.map(({ r, name }) => ({ label: name, ...(name !== r ? { displayLabel: r } : {}), apply: r, type: 'register', detail: regNotes.get(r)?.() ?? '', boost }))
  // The matched characters are found in the bare name; shift them past the prefix shown before it.
  const getMatch = (c: Completion, matched: readonly number[] = []) => matched.map((n) => n + (c.displayLabel ?? c.label).length - c.label.length)
  // Which operands of each mnemonic take a register, from the instruction forms (in `lw $t1, -100($t2)`
  // both do; in `j target` none does).
  const known = new Set(isa.language.registers)
  const registerSlots = new Map<string, Set<number>>()
  for (const e of isa.catalog) {
    const slots = registerSlots.get(e.mnemonic) ?? new Set<number>()
    splitOperands(e.example.slice(e.mnemonic.length)).forEach((operand, at) => {
      if (operand.match(/[$\w.]+/g)?.some((w) => known.has(w))) slots.add(at)
    })
    registerSlots.set(e.mnemonic, slots)
  }
  // Directives: the title as detail, and the reference row (example, meaning, caveats) as details panel.
  const directiveRows = new Map<string, RefRow>()
  for (const table of isa.references ?? [])
    for (const g of table.groups) for (const row of g.rows) if (isa.language.directives.includes(row.key)) directiveRows.set(row.key, row)
  const directiveDoc = (row: RefRow) => () => {
    const box = el('div', 'cm-asm-doc')
    if (row.example) box.appendChild(el('div', 'cm-asm-doc-head cm-asm-doc-code', row.example))
    box.appendChild(el('div', 'cm-asm-doc-name', tx(row.title)))
    if (row.text) box.appendChild(el('div', 'cm-asm-doc-desc', tx(row.text)))
    if (row.note) box.appendChild(el('div', 'cm-asm-doc-note', tx(row.note)))
    return box
  }
  const directives = (): Completion[] =>
    isa.language.directives.map((d) => {
      const row = directiveRows.get(d)
      return row ? { label: d, type: 'directive', detail: tx(row.title), info: directiveDoc(row) } : { label: d, type: 'directive' }
    })
  const atStatementStart = (before: string) => /^\s*([\w.]+:\s*)*$/.test(before)

  /**
   * The operand being typed: the statement's mnemonic, its position (commas so far) and its text so far.
   * Null at the start of a statement.
   */
  const operandAt = (before: string): { mnemonic: string; at: number; text: string } | null => {
    const m = /^\s*(?:[.\w$]+\s*:\s*)*([.\w]+)\s+(.*)$/.exec(before)
    if (!m) return null
    const parts = splitOperands(m[2]!)
    return { mnemonic: m[1]!.toLowerCase(), at: parts.length - 1, text: parts[parts.length - 1]!.trim() }
  }
  const wantedKind = (op: ReturnType<typeof operandAt>): LabelKind | null => (op && isa.language.labelOperands[op.mnemonic]?.[op.at]) ?? null

  // Labels: data ones show their declaration and get their own icon; code ones show their line. The kind
  // the operand wants comes first.
  const short = (s: string) => (s.length > 32 ? s.slice(0, 31) + '…' : s)
  const labelDoc = (name: string, d: LabelDef) => () => {
    const box = el('div', 'cm-asm-doc')
    box.appendChild(el('div', 'cm-asm-doc-head cm-asm-doc-code', d.decl ? `${name}: ${d.decl}` : `${name}:`))
    box.appendChild(
      el('div', 'cm-asm-doc-desc', d.kind === 'data' ? L(`数据标签，第 ${d.line} 行：这段内存的起始地址`, `Data label, line ${d.line}: the address where this memory starts`) : L(`代码标签，第 ${d.line} 行：可以跳转到这里`, `Code label, line ${d.line}: a place to branch or jump to`)),
    )
    return box
  }
  const labelOptions = (state: EditorState, wants: LabelKind | null): Completion[] =>
    [...sourceIndex(state).labels].map(([name, d]) => ({
      label: name,
      type: d.kind === 'data' ? 'data' : 'label',
      detail: d.kind === 'data' ? short(d.decl) : L(`第 ${d.line} 行`, `line ${d.line}`),
      info: labelDoc(name, d),
      boost: wants && d.kind === wants ? 10 : 0,
    }))
  /**
   * An operand being typed: the labels, and the registers without their prefix where the operand takes one and
   * the text could be a register name. Inside `4(` the operand is a base register, so no label kind is wanted.
   */
  const operands = (state: EditorState, from: number, before: string, text: string): CompletionResult | null => {
    const op = operandAt(before)
    // Inside `4(` (MIPS) or `[` (ARM) the operand is a base register.
    const base = !!op && (/\([^)]*$/.test(op.text) || /\[[^\]]*$/.test(op.text))
    const wants = base ? null : wantedKind(op)
    const options = labelOptions(state, wants)
    const takesRegister = !op || base || (!op.mnemonic.startsWith('.') && (registerSlots.get(op.mnemonic)?.has(op.at) ?? true))
    if (takesRegister && (!text || /^[A-Za-z]/.test(text))) options.push(...bareRegisters(wants ? 0 : 5))
    return options.length ? { from, options, validFor: /^[\w.$]*$/, getMatch } : null
  }

  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[$.%]?[\w.$]*/)
    if (!word) return null
    const line = ctx.state.doc.lineAt(ctx.pos)
    let before = ctx.state.sliceDoc(line.from, word.from)
    const scan = scanLine(before, syntax, sectionSet, sourceIndex(ctx.state).blockLines.has(line.number))
    if (scan.comment != null || scan.inBlock || /["']/.test(before)) return null
    // Only the statement being typed counts.
    if (syntax.separator) before = before.slice(before.lastIndexOf(syntax.separator) + 1)
    if (word.from === word.to && !ctx.explicit) {
      // Nothing typed yet: open the labels only where the operand takes one (after `la $a0, `, `j `).
      const op = operandAt(before)
      const wants = op && !op.text ? wantedKind(op) : null
      const options = wants ? labelOptions(ctx.state, wants) : []
      // No validFor: the next letter asks again, so registers typed without "$" can join in.
      return options.length ? { from: word.from, options } : null
    }
    if (word.text.startsWith('$')) return { from: word.from, options: registers(), validFor: /^\$\w*$/ }
    if (word.text.startsWith('.') && atStatementStart(before)) return { from: word.from, options: directives(), validFor: /^\.\w*$/ }
    if (atStatementStart(before)) return { from: word.from, options: mnemonicOptions(), validFor: /^[\w.]*$/ }
    if (/^[.A-Za-z_]?[\w.$]*$/.test(word.text)) return operands(ctx.state, word.from, before, word.text)
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

/**
 * Format moves breakpoints with their statements (a `setBreakpointLines` effect in the same transaction).
 * Undo and redo carry the opposite move, so a breakpoint is not lost when its line break is taken back.
 */
const breakpointHistory = invertedEffects.of((tr) =>
  tr.effects.some((e) => e.is(setBreakpointLines)) && (tr.isUserEvent('format') || tr.isUserEvent('undo') || tr.isUserEvent('redo'))
    ? [setBreakpointLines.of(breakpointLines(tr.startState))]
    : [],
)

/**
 * The Format command as one undoable transaction. Only the runs of blanks that change are edited, so the
 * cursor, selection and marks stay between the same characters, and each breakpoint follows its statement
 * (found by the line's last visible character) when a label is moved onto a line of its own. Null when the
 * formatted text is the same, or differs in more than whitespace.
 */
export function formatTransaction(state: EditorState, formatted: string): TransactionSpec | null {
  const changes = whitespaceChanges(state.doc.toString(), formatted)
  if (!changes?.length) return null
  const set = ChangeSet.of(changes, state.doc.length)
  const doc = set.apply(state.doc)
  const breakpoints = breakpointLines(state).map((n) => {
    const line = state.doc.line(n)
    const last = line.from + Math.max(0, line.text.trimEnd().length - 1)
    return doc.lineAt(set.mapPos(last, 1)).number
  })
  return { changes: set, effects: setBreakpointLines.of(breakpoints), userEvent: 'format', annotations: isolateHistory.of('full') }
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
  '.cm-content': { caretColor: 'var(--accent)', cursor: 'text' },
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
  // Also on the inner syntax span: a label such as .L1 or $x is otherwise coloured as a directive or register.
  '.cm-label-ref, .cm-label-ref *': { color: 'var(--series-6)' },
  '.cm-section-line': { backgroundColor: 'var(--bg-section)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)' },
  '.cm-nav-link, .cm-nav-link *': {
    color: 'var(--nav-link) !important',
    textDecoration: 'underline',
    textUnderlinePosition: 'under',
    cursor: 'pointer',
  },
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
  '.cm-asm-icon-data': { color: 'var(--series-2)', strokeWidth: '1.3' },
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
  '.cm-asm-doc-refs': { maxHeight: '260px', overflowY: 'auto', marginRight: '-6px', paddingRight: '6px' },
  '.cm-asm-doc-group': { fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: '600', color: 'var(--suggest-muted)', margin: '5px 0 1px' },
  '.cm-asm-doc-keys': {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    columnGap: '8px',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    lineHeight: '1.5',
  },
  '.cm-asm-doc-key': { fontFamily: 'var(--font-mono)', textAlign: 'right', color: 'var(--suggest-match)' },
  '.cm-asm-doc-code': { whiteSpace: 'pre' },
  '.cm-asm-doc-name': { fontFamily: 'var(--font-sans)', fontSize: '12.5px', fontWeight: '600', marginBottom: '2px' },
  '.cm-asm-doc-note': { fontFamily: 'var(--font-sans)', fontSize: '11.5px', lineHeight: '1.5', color: 'var(--suggest-muted)', marginTop: '6px' },
  '.cm-asm-doc-hint': { fontFamily: 'var(--font-sans)', fontSize: '11.5px', color: 'var(--suggest-muted)', marginTop: '8px' },
  '.cm-diagnostic': { fontFamily: 'var(--font-sans)', fontSize: '12.5px' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text-primary)' },
  '.cm-searchMatch': { backgroundColor: 'var(--bg-warning)' },
  '.cm-textfield': { backgroundColor: 'var(--surface-1)', border: '1px solid var(--border)', color: 'var(--text-primary)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface-1)', border: '1px solid var(--border)', color: 'var(--text-primary)' },
})

export function editorExtensions(isa: IsaPlugin, extra: Extension[] = []): Extension[] {
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
    breakpointHistory,
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    asmLanguage(isa),
    syntaxHighlighting(highlight),
    asmSyntax.of({
      ...lineSyntax(isa),
      sections: new Set(isa.language.sections.map((d) => d.toLowerCase())),
      dataSections: new Set(isa.language.dataSections.map((d) => d.toLowerCase())),
    }),
    sourceIndexField,
    labelAndSectionMarks(),
    flushSectionsOnInput(isa.language.sections),
    closeBrackets(),
    autocompletion({
      override: [completer(isa)],
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
