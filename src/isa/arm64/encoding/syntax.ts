/**
 * Operand templates: one string per encoding says how its operands are written, and drives both directions.
 *
 *   '<Rd|SP>, <Rn|SP>, #<u:imm12>{, lsl #<sh12>}'
 *
 * `<…>` is an operand (see operands.ts for the names), `{…}` an optional group, `#` an immediate's prefix
 * (optional when assembling, as in GNU as), and everything else is written as is: `[`, `]`, `!`, `,` and
 * keywords such as `lsl` or `mul vl`. `#0` stands for a literal zero.
 *
 * Assembling matches the tokens against the template and collects field values; disassembling prints the
 * template from field values, leaving out optional groups whose operands are all at their defaults.
 */
import { L } from '../../../core/i18n'
import { vaOf } from '../../../core/format'
import { ExprError, parseExpr } from '../expr'
import type { Tok } from '../lexer'

export type Fields = Record<string, number>

export interface AsmContext {
  /** Internal address of the instruction being assembled. */
  pc: number
  symbol(name: string): bigint | undefined
}

/** Why a template did not match, and where. `hard` marks a real error (a range, an undefined symbol) rather than "not this form". */
export class Mismatch {
  constructor(
    readonly pos: number,
    readonly message: string,
    readonly hard = false,
    readonly col: number | null = null,
    readonly length: number | null = null,
    readonly code = 'bad-operands',
  ) {}
}

export class OperandStream {
  pos = 0
  constructor(
    readonly toks: Tok[],
    readonly ctx: AsmContext,
    readonly widths: Record<string, number>,
  ) {}

  peek(o = 0): Tok | undefined {
    return this.toks[this.pos + o]
  }
  atEnd(): boolean {
    return this.pos >= this.toks.length
  }
  fail(message: string, hard = false, at = this.pos): never {
    throw new Mismatch(at, message, hard)
  }
  isPunct(text: string, o = 0): boolean {
    const t = this.peek(o)
    return !!t && t.kind === 'punct' && t.text === text
  }
  /** Consume a punctuation token if it is there. */
  eat(text: string): boolean {
    if (!this.isPunct(text)) return false
    this.pos++
    return true
  }
  /** The next identifier, lower case, without consuming it. */
  word(o = 0): string | null {
    const t = this.peek(o)
    return t && t.kind === 'ident' ? t.text.toLowerCase() : null
  }
  /** Evaluate an expression here. An undefined symbol or a bad expression is a hard error. */
  expr(): bigint {
    try {
      const r = parseExpr(this.toks, this.pos, { symbol: (n) => this.ctx.symbol(n), dot: vaOf(this.ctx.pc) })
      this.pos = r.end
      return r.value
    } catch (e) {
      if (e instanceof ExprError) {
        const at = this.toks.findIndex((t) => t.col === e.col)
        throw new Mismatch(at >= 0 ? at : this.pos, e.message, true, e.col, e.length, e.undefinedSymbol ? 'undefined-symbol' : 'bad-expression')
      }
      throw e
    }
  }
  /** Whether an expression can start here (so a register or keyword is not mistaken for one). */
  startsValue(): boolean {
    const t = this.peek()
    if (!t) return false
    if (t.kind === 'num' || t.kind === 'local') return true
    if (t.kind === 'punct') return t.text === '(' || t.text === '-' || t.text === '+' || t.text === '~' || t.text === ':'
    return t.kind === 'ident'
  }
  /** Width of a field of the encoding being matched. */
  width(field: string): number {
    const w = this.widths[field]
    if (w === undefined) throw new Error(`field ${field} has no width`)
    return w
  }
}

/** Set a field, or fail when an earlier operand gave it a different value. */
export function unify(s: OperandStream, f: Fields, name: string, value: number, message?: string): void {
  if (name in f && f[name] !== value) s.fail(message ?? L('操作数之间互相矛盾', 'These operands contradict each other'))
  f[name] = value
}

/** How a value prints: decimal when short, hex otherwise. */
export function fmtImm(v: bigint | number): string {
  const b = BigInt(v)
  const a = b < 0n ? -b : b
  if (a < 10000n) return b.toString()
  return (b < 0n ? '-0x' : '0x') + a.toString(16)
}

export function hexAddr(v: bigint): string {
  return '0x' + BigInt.asUintN(64, v).toString(16)
}

export interface PrintContext {
  /** Internal address of the instruction. */
  pc: number
  /** A name for an address, for branch targets (optional). */
  name?: (va: bigint) => string | null
}

export interface OperandType<A = unknown> {
  /** How the calculator presents it. */
  kind: 'reg' | 'imm' | 'label' | 'word' | 'mem'
  parse(s: OperandStream, f: Fields, a: A): void
  print(f: Fields, a: A, ctx: PrintContext): string
  /** The encoding fields it is made from (for the decoder's field meanings). */
  fields(a: A): string[]
  /** True when an optional group holding only this operand can be left out. */
  isDefault?(f: Fields, a: A): boolean
  /** Give the fields their default values when the operand was left out (RET's x30, ISB's sy). */
  fillDefault?(f: Fields, a: A): void
  /** An example value; may set fields (a register's width) so later samples agree. */
  sample(f: Fields, a: A): string
  /** What to write here, for hints. */
  hint(a: A): string
  /** The choices, when there are few (registers, conditions). */
  options?(f: Fields, a: A): string[]
}

export interface OpSpec {
  type: OperandType<any>
  arg: any
  /** The placeholder as written in the template. */
  name: string
}

export type Item = { k: 'lit'; text: string } | { k: 'hash' } | { k: 'num'; value: bigint } | { k: 'op'; spec: OpSpec } | { k: 'opt'; items: Item[] }

export type Resolver = (name: string) => OpSpec

/** Compile a template string. */
export function compileSyntax(syntax: string, resolve: Resolver): Item[] {
  let i = 0
  const seq = (close: string | null): Item[] => {
    const items: Item[] = []
    while (i < syntax.length) {
      const c = syntax[i]!
      if (c === ' ') {
        i++
        continue
      }
      if (close && c === close) {
        i++
        return items
      }
      if (c === '{') {
        i++
        items.push({ k: 'opt', items: seq('}') })
        continue
      }
      if (c === '<') {
        const j = syntax.indexOf('>', i)
        items.push({ k: 'op', spec: resolve(syntax.slice(i + 1, j)) })
        i = j + 1
        continue
      }
      if (c === '#') {
        i++
        const m = /^-?\d+/.exec(syntax.slice(i))
        if (m) {
          items.push({ k: 'num', value: BigInt(m[0]) })
          i += m[0].length
        } else items.push({ k: 'hash' })
        continue
      }
      const w = /^[A-Za-z_.][\w.]*/.exec(syntax.slice(i))
      if (w) {
        items.push({ k: 'lit', text: w[0].toLowerCase() })
        i += w[0].length
        continue
      }
      items.push({ k: 'lit', text: c })
      i++
    }
    if (close) throw new Error(`unclosed { in ${syntax}`)
    return items
  }
  return seq(null)
}

/** Every operand of a template, in order, including those in optional groups. */
export function operandsOf(items: Item[]): OpSpec[] {
  const out: OpSpec[] = []
  for (const it of items) {
    if (it.k === 'op') out.push(it.spec)
    else if (it.k === 'opt') out.push(...operandsOf(it.items))
  }
  return out
}

/** Where each operand's tokens are, by its index in operandsOf. */
export type Spans = Map<number, [number, number]>

function describe(it: Item): string {
  if (it.k === 'lit') return it.text
  if (it.k === 'num') return '#' + it.value
  return ''
}

/**
 * Match tokens against a template, filling `f`. Throws the deepest Mismatch seen (or `best` keeps it) when
 * they do not fit. Optional groups are tried greedily.
 */
export function matchSyntax(items: Item[], s: OperandStream, f: Fields, spans: Spans, best: { m: Mismatch | null }): void {
  let opIndex = 0
  const note = (m: Mismatch) => {
    const b = best.m
    if (!b || m.pos > b.pos || (m.pos === b.pos && m.hard && !b.hard)) best.m = m
  }
  const run = (list: Item[]): void => {
    for (const it of list) {
      if (it.k === 'opt') {
        const savePos = s.pos
        const saveF = { ...f }
        const saveOp = opIndex
        const saveSpans = new Map(spans)
        try {
          run(it.items)
        } catch (e) {
          if (!(e instanceof Mismatch)) throw e
          note(e)
          // A real error inside an optional group (a range, an undefined symbol) is the line's error.
          if (e.hard && e.pos > savePos) throw e
          s.pos = savePos
          for (const k of Object.keys(f)) delete f[k]
          Object.assign(f, saveF)
          spans.clear()
          for (const [k, v] of saveSpans) spans.set(k, v)
          opIndex = saveOp + operandsOf(it.items).length
        }
        continue
      }
      if (it.k === 'hash') {
        s.eat('#')
        continue
      }
      if (it.k === 'num') {
        s.eat('#')
        const at = s.pos
        if (!s.startsValue()) s.fail(L(`这里应该是 #${it.value}`, `Expected #${it.value}`))
        const v = s.expr()
        if (v !== it.value) s.fail(L(`这里只能是 #${it.value}`, `Only #${it.value} is allowed here`), true, at)
        continue
      }
      if (it.k === 'lit') {
        const t = s.peek()
        const ok = t && (it.text.length === 1 && !/\w/.test(it.text) ? t.kind === 'punct' && t.text === it.text : t.kind === 'ident' && t.text.toLowerCase() === it.text)
        if (!ok) {
          if (!t) s.fail(L(`缺少 "${describe(it)}"`, `Missing "${describe(it)}"`))
          s.fail(L(`这里应该是 "${describe(it)}"，而不是 "${t.text}"`, `Expected "${describe(it)}" here, not "${t.text}"`))
        }
        s.pos++
        continue
      }
      const start = s.pos
      const index = opIndex++
      if (s.atEnd()) s.fail(L(`缺少操作数：${it.spec.type.hint(it.spec.arg)}`, `Missing operand: ${it.spec.type.hint(it.spec.arg)}`))
      it.spec.type.parse(s, f, it.spec.arg)
      spans.set(index, [start, s.pos])
    }
  }
  try {
    run(items)
    if (!s.atEnd()) {
      const t = s.peek()!
      s.fail(L(`多余的内容："${t.text}"`, `Unexpected "${t.text}"`))
    }
  } catch (e) {
    if (e instanceof Mismatch) note(e)
    throw e
  }
}

/** Whether every operand in a group is at its default (so the group can be left out). */
function groupIsDefault(items: Item[], f: Fields): boolean {
  for (const it of items) {
    if (it.k === 'op' && !(it.spec.type.isDefault?.(f, it.spec.arg) ?? false)) return false
    if (it.k === 'opt' && !groupIsDefault(it.items, f)) return false
  }
  return true
}

/** Join printed pieces with the spacing assembly is written in: "x0, [x1, #8]!". */
function join(pieces: string[]): string {
  let out = ''
  for (const p of pieces) {
    if (!p) continue
    if (p === ',') out += ', '
    else if (/^[\w#\-]/.test(p) && /[\w.]$/.test(out)) out += ' ' + p
    else out += p
  }
  return out
}

/** Print operands from field values. */
export function printSyntax(items: Item[], f: Fields, ctx: PrintContext): string {
  const pieces: string[] = []
  const run = (list: Item[]) => {
    for (const it of list) {
      if (it.k === 'opt') {
        if (!groupIsDefault(it.items, f)) run(it.items)
      } else if (it.k === 'hash') pieces.push('#')
      else if (it.k === 'num') pieces.push('#' + it.value)
      else if (it.k === 'lit') pieces.push(it.text)
      else {
        const text = it.spec.type.print(f, it.spec.arg, ctx)
        if (pieces[pieces.length - 1] === '#') pieces[pieces.length - 1] = '#' + text
        else pieces.push(text)
      }
    }
  }
  run(items)
  return join(pieces)
}

/** An example of the operands (optional groups left out). */
export function sampleSyntax(items: Item[], f: Fields): string {
  const pieces: string[] = []
  for (const it of items) {
    if (it.k === 'opt') continue
    if (it.k === 'hash') pieces.push('#')
    else if (it.k === 'num') pieces.push('#' + it.value)
    else if (it.k === 'lit') pieces.push(it.text)
    else {
      const text = it.spec.type.sample(f, it.spec.arg)
      if (pieces[pieces.length - 1] === '#') pieces[pieces.length - 1] = '#' + text
      else pieces.push(text)
    }
  }
  return join(pieces)
}

/**
 * Write operands from texts, one per operand of the template (empty texts leave optional groups out).
 * The calculator's inverse of matchSyntax's spans.
 */
export function buildSyntax(items: Item[], texts: string[]): string {
  let index = 0
  const run = (list: Item[], optional: boolean): string[] | null => {
    const pieces: string[] = []
    let any = false
    for (const it of list) {
      if (it.k === 'opt') {
        const inner = run(it.items, true)
        if (inner) pieces.push(...inner)
        continue
      }
      if (it.k === 'hash') pieces.push('#')
      else if (it.k === 'num') pieces.push('#' + it.value)
      else if (it.k === 'lit') pieces.push(it.text)
      else {
        let text = (texts[index++] ?? '').trim()
        if (text) any = true
        if (pieces[pieces.length - 1] === '#') {
          text = text.replace(/^#/, '')
          pieces[pieces.length - 1] = '#' + text
        } else pieces.push(text)
      }
    }
    if (optional && !any) return null
    return pieces
  }
  return join(run(items, false) ?? [])
}

export { vaOf }
