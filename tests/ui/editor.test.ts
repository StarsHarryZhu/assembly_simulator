/** Editor helpers that work on EditorState alone: line scan, source index, section directives, suggestions, navigation. */
import { CompletionContext, insertBracket, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { mips } from '../../src/isa/mips'
import { getIndentUnit } from '@codemirror/language'
import { completer, editorExtensions, flushSectionsOnInput, navigationTarget, scanLine, sourceIndex } from '../../src/ui/ide/editor'

const sections = new Set(mips.language.sections)

describe('scanLine', () => {
  const words = (text: string, role: string) => scanLine(text, '#', sections).pieces.filter((p) => p.role === role).map((p) => p.text)

  it('finds definitions, the head, operand identifiers and section directives', () => {
    expect(scanLine('loop: beq $t0, $zero, done   # done later', '#', sections)).toEqual({
      pieces: [
        { text: 'loop', from: 0, to: 4, role: 'label' },
        { text: 'beq', from: 6, to: 9, role: 'head' },
        { text: '$t0', from: 10, to: 13, role: 'ref' },
        { text: '$zero', from: 15, to: 20, role: 'ref' },
        { text: 'done', from: 22, to: 26, role: 'ref' },
      ],
      section: false,
    })
    expect(words('msg: .asciiz "a: b, c"', 'ref')).toEqual([])
    expect(scanLine('  .text 0x00400000', '#', sections).section).toBe(true)
    expect(words('        la $a0, msg+4', 'ref')).toEqual(['$a0', 'msg'])
  })

  it('reads label names the way the assembler does', () => {
    expect(words('.L1: j .L1', 'label')).toEqual(['.L1'])
    expect(words('.L1: j .L1', 'ref')).toEqual(['.L1'])
    expect(words('a$b: b a$b', 'ref')).toEqual(['a$b'])
    expect(scanLine('.L1: nop', '#', sections).section).toBe(false)
  })
})

describe('sourceIndex', () => {
  const index = (doc: string) => sourceIndex(EditorState.create({ doc, extensions: editorExtensions(mips) }))

  it('keeps the first label of a line, as the assembler does, and macros', () => {
    const i = index('a: b: nop\n.macro twice(%r)\n    add %r, %r, %r\n.end_macro\n.L1:\n')
    expect([...i.labels]).toEqual([
      ['a', { line: 1, col: 0 }],
      ['.L1', { line: 5, col: 0 }],
    ])
    expect([...i.macros]).toEqual([['twice', { line: 2, col: 7 }]])
  })

  it('is built once per document change, not per lookup', () => {
    const state = EditorState.create({ doc: 'x: nop\n', extensions: editorExtensions(mips) })
    expect(sourceIndex(state)).toBe(sourceIndex(state))
    const next = state.update({ selection: { anchor: 1 } }).state
    expect(sourceIndex(next)).toBe(sourceIndex(state))
    const edited = state.update({ changes: { from: 0, insert: 'y: nop\n' } }).state
    expect([...sourceIndex(edited).labels.keys()]).toEqual(['y', 'x'])
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
  const complete = completer(mips)
  const at = (doc: string) => {
    const state = EditorState.create({ doc, extensions: editorExtensions(mips) })
    return complete(new CompletionContext(state, doc.length, false)) as CompletionResult | null
  }

  it('offers instructions at the start of a statement and labels as operands', () => {
    expect(at('main: ad')!.options.some((o) => o.label === 'addi' && o.type === 'instruction')).toBe(true)
    const r = at('main:\nloop:\n        beq $t0, $t1, l')!
    expect(r.options.map((o) => o.label)).toEqual(['main', 'loop'])
    expect(r.options[0]!.type).toBe('label')
    expect(at('.L1: nop\n    j .L')!.options.map((o) => o.label)).toEqual(['.L1'])
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
