/** Editor helpers that work on EditorState alone: label scan, section directives, suggestions. */
import { CompletionContext, insertBracket, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { mips } from '../../src/isa/mips'
import { getIndentUnit } from '@codemirror/language'
import { completer, editorExtensions, flushSectionsOnInput, labelsField, navigationTarget, scanLine } from '../../src/ui/ide/editor'

const sections = new Set(mips.language.sections)

describe('scanLine', () => {
  it('finds definitions, operand identifiers and section directives', () => {
    expect(scanLine('loop: beq $t0, $zero, done   # done later', '#', sections)).toEqual({
      defs: ['loop'],
      refs: [{ from: 22, to: 26, name: 'done' }],
      section: false,
    })
    expect(scanLine('msg: .asciiz "a: b, c"', '#', sections).refs).toEqual([])
    expect(scanLine('  .text 0x00400000', '#', sections).section).toBe(true)
    expect(scanLine('        la $a0, msg+4', '#', sections).refs.map((r) => r.name)).toEqual(['msg'])
  })
})

describe('indentation', () => {
  it('uses 4 spaces for a tab and for one indent level', () => {
    const state = EditorState.create({ extensions: editorExtensions(mips) })
    expect(state.tabSize).toBe(4)
    expect(getIndentUnit(state)).toBe(4)
  })

  it('indents every example by 4 spaces', () => {
    for (const ex of mips.examples) for (const line of ex.text.en.split('\n')) expect(/^ {5,}\S/.test(line), `${ex.id}: ${line}`).toBe(false)
  })
})

describe('quotes and brackets', () => {
  const type = (doc: string, ch: string, at = doc.length) => {
    const state = EditorState.create({ doc, selection: { anchor: at }, extensions: editorExtensions(mips) })
    const tr = insertBracket(state, ch)
    return tr ? tr.state.doc.toString() + ' @' + tr.state.selection.main.head : null
  }

  it('closes ( [ { \' " when one is typed', () => {
    expect(type('    lw $t0, 0', '(')).toBe('    lw $t0, 0() @14')
    expect(type('msg: .asciiz ', '"')).toBe('msg: .asciiz "" @14')
    expect(type('    li $a0, ', "'")).toBe("    li $a0, '' @13")
    expect(type('x ', '[')).toBe('x [] @3')
    expect(type('x ', '{')).toBe('x {} @3')
  })

  it('steps over the partner it inserted and leaves an apostrophe after a word alone', () => {
    const state = EditorState.create({ doc: '    lw $t0, 0', selection: { anchor: 13 }, extensions: editorExtensions(mips) })
    const opened = insertBracket(state, '(')!.state
    const closed = insertBracket(opened, ')')!.state
    expect(closed.doc.toString()).toBe('    lw $t0, 0()')
    expect(closed.selection.main.head).toBe(15)
    expect(type('# don', "'")).toBeNull()
  })
})

describe('section directives', () => {
  const state = EditorState.create({ doc: '        x', extensions: [flushSectionsOnInput(mips.language.sections)] })

  it('move to the first column when typed on an indented line', () => {
    const tr = state.update({ changes: { from: 8, to: 9, insert: '.data' }, userEvent: 'input.type' })
    expect(tr.state.doc.toString()).toBe('.data')
  })

  it('leave other directives and programmatic changes alone', () => {
    expect(state.update({ changes: { from: 8, to: 9, insert: '.word' }, userEvent: 'input.type' }).state.doc.toString()).toBe('        .word')
    expect(state.update({ changes: { from: 8, to: 9, insert: '.data' } }).state.doc.toString()).toBe('        .data')
  })
})

describe('suggestions', () => {
  const labels = labelsField('#', sections)
  const complete = completer(mips, labels)
  const at = (doc: string) => {
    const state = EditorState.create({ doc, extensions: [labels] })
    return complete(new CompletionContext(state, doc.length, false)) as CompletionResult | null
  }

  it('offers instructions at the start of a statement and labels as operands', () => {
    expect(at('main: ad')!.options.some((o) => o.label === 'addi' && o.type === 'instruction')).toBe(true)
    const r = at('main:\nloop:\n        beq $t0, $t1, l')!
    expect(r.options.map((o) => o.label)).toEqual(['main', 'loop'])
    expect(r.options[0]!.type).toBe('label')
  })

  it('offers registers after $ and nothing inside comments', () => {
    expect(at('        add $t')!.options.some((o) => o.label === '$t0')).toBe(true)
    expect(at('        # ad')).toBeNull()
  })
})

describe('modifier-click navigation', () => {
  const nav = (doc: string, needle: string, last = false) => {
    const state = EditorState.create({ doc, extensions: editorExtensions(mips) })
    return navigationTarget(state, (last ? doc.lastIndexOf(needle) : doc.indexOf(needle)) + 1, mips)
  }

  const source = ['.text', 'loop: beq $t0, $zero, done', '    add $t1, $t1, $t2', 'done: jr $ra', ''].join('\n')

  it('opens the whole statement of a clicked mnemonic, without its label or indentation', () => {
    expect(nav(source, 'beq')).toMatchObject({ kind: 'instruction', line: 'beq $t0, $zero, done' })
    expect(nav(source, 'add ')).toMatchObject({ kind: 'instruction', line: 'add $t1, $t1, $t2' })
    expect(nav('.text\n  add $t0,$t1,$t2  # note\n', 'add')).toMatchObject({ line: 'add $t0,$t1,$t2  # note' })
  })

  it('jumps from a label operand to its definition, and ignores definitions and registers', () => {
    expect(nav(source, 'done')).toMatchObject({ kind: 'definition', what: 'label', line: 4, col: 0 })
    expect(nav('.data\nmsg: .asciiz "x"\n.word msg\n', 'msg', true)).toMatchObject({ kind: 'definition', what: 'label', line: 2 })
    expect(nav(source, 'loop')).toBeNull()
    expect(nav(source, '$t0')).toBeNull()
    expect(nav(source, 'jr')).toMatchObject({ kind: 'instruction', line: 'jr $ra' })
  })

  it('does not treat text inside comments or strings as labels', () => {
    const doc = '.data\nmsg: .asciiz "loop: add"\n    add $t0, $t1, $t2 # add loop\n'
    expect(nav(doc, 'loop')).toBeNull()
    expect(nav(doc, 'add', true)).toBeNull()
  })

  it('jumps from a macro call to the .macro line', () => {
    const doc = '.macro twice\n    add $t0, $t0, $t0\n.end_macro\n.text\n    twice $t1\n'
    expect(nav(doc, 'twice', true)).toMatchObject({ kind: 'definition', what: 'macro', line: 1, col: 7 })
    expect(nav(doc, 'twice')).toBeNull()
  })

  it('has no target for an unknown mnemonic, a directive or a lone label', () => {
    expect(nav('    thrice\n', 'thrice')).toBeNull()
    expect(nav('.data\n.word 1\n', '.word')).toBeNull()
    expect(nav('start:\n', 'start')).toBeNull()
  })
})
