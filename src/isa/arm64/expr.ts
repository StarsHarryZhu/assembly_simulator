/**
 * Integer expressions as GNU as (and LLVM in its GNU mode) evaluates them: 64-bit two's-complement values,
 * symbols, `.` for the current address, and operators with GNU precedence (`|` `&` `^` and binary `!`, "or
 * not", bind tighter than `+` and `-`). Values are bigints wrapped to 64 bits.
 */
import { L } from '../../core/i18n'
import type { Tok } from './lexer'

/**
 * What a value moves with when sections are placed: each base (a section, or an outside symbol) with its
 * coefficient. Empty for a constant; a label is its section with 1; a difference of two labels in one
 * section cancels out. A base starting with `?` is a symbol nobody defines, which may be added but never
 * subtracted.
 */
export type Rel = ReadonlyMap<string, number>

export interface ExprContext {
  /** A symbol's value, or undefined while it is not (yet) defined. */
  symbol(name: string): bigint | undefined
  /** The address of the statement (`.`). */
  dot: bigint
  /**
   * Given, the evaluation also tracks what the value is relative to (as LLVM does) and refuses what no
   * relocation could express, such as a label masked with &: a symbol's base (called once its value is known).
   */
  relOf?(name: string): Rel
  /** The base of `.` (its section), when tracking. */
  dotRel?: string
}

/** Why an expression could not be evaluated. `undefinedSymbol` is set when only a missing symbol stopped it. */
export class ExprError extends Error {
  constructor(
    message: string,
    readonly col: number,
    readonly length: number,
    readonly undefinedSymbol: string | null = null,
  ) {
    super(message)
  }
}

const NONE: Rel = new Map()

const M64 = (1n << 64n) - 1n
const wrap = (v: bigint) => BigInt.asIntN(64, v)

const BINARY: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<>': 3,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '+': 4,
  '-': 4,
  '|': 5,
  '!': 5,
  '&': 5,
  '^': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '<<': 6,
  '>>': 6,
}

/** Whether a token can start an expression. */
export function startsExpr(t: Tok | undefined): boolean {
  if (!t) return false
  if (t.kind === 'num' || t.kind === 'ident' || t.kind === 'local') return true
  return t.kind === 'punct' && (t.text === '(' || t.text === '-' || t.text === '+' || t.text === '~' || t.text === '!')
}

/**
 * Parse an expression starting at `pos`; returns its value (signed 64-bit), the index after it and, when
 * tracking, what the value is relative to.
 * Stops at the first token that cannot continue an expression (`,`, `]`, `}`, …).
 */
export function parseExpr(toks: Tok[], pos: number, ctx: ExprContext): { value: bigint; end: number; rel: Rel } {
  let i = pos
  const track = !!ctx.relOf
  const fail = (message: string, t: Tok | undefined = toks[i]): never => {
    const last = toks[toks.length - 1]
    throw new ExprError(message, t?.col ?? (last ? last.col + last.text.length : 1), t?.text.length ?? 1)
  }
  const notRelocatable = (t: Tok): never =>
    fail(L('标签的地址不能这样计算：只能加减常数，或者减去同一段里的另一个标签', "A label's address cannot be used this way: only add or subtract constants, or subtract another label of the same section"), t)
  /** Relative values allow + and -, and unary - of a difference; everything else needs constants. */
  const constant = (t: Tok, ...rels: Rel[]) => {
    if (rels.some((r) => r.size)) notRelocatable(t)
  }
  /** a + k·b, refused when it is no longer one symbol minus another (what a relocation can hold). */
  const combine = (t: Tok, a: Rel, b: Rel, k: number): Rel => {
    if (!b.size) return a
    if (k < 0) for (const base of b.keys()) if (base.startsWith('?')) fail(L(`不能减去没有定义的符号 ${base.slice(1)}`, `Cannot subtract the undefined symbol ${base.slice(1)}`), t)
    const out = new Map(a)
    for (const [base, c] of b) {
      const n = (out.get(base) ?? 0) + k * c
      if (n) out.set(base, n)
      else out.delete(base)
    }
    let plus = 0
    let minus = 0
    for (const c of out.values()) {
      if (c === 1) plus++
      else if (c === -1) minus++
      else notRelocatable(t)
    }
    if (plus > 1 || minus > 1) notRelocatable(t)
    return out
  }

  let rel: Rel = NONE
  const primary = (): bigint => {
    const t = toks[i]
    rel = NONE
    if (!t) return fail(L('这里缺少表达式', 'Expected an expression'))
    if (t.kind === 'num') {
      // Literals wider than 64 bits are refused, as LLVM does (only .octa takes them).
      if (t.value! >= 1n << 64n) fail(L(`数 ${t.text} 超过了 64 位`, `The number ${t.text} does not fit in 64 bits`))
      i++
      return wrap(t.value!)
    }
    if (t.kind === 'ident') {
      i++
      if (t.text === '.') {
        if (track && ctx.dotRel) rel = new Map([[ctx.dotRel, 1]])
        return wrap(ctx.dot)
      }
      const v = ctx.symbol(t.text)
      if (v === undefined) throw new ExprError(L(`符号 "${t.text}" 没有定义`, `Undefined symbol "${t.text}"`), t.col, t.text.length, t.text)
      if (track) rel = ctx.relOf!(t.text)
      return wrap(v)
    }
    if (t.kind === 'punct') {
      if (t.text === '(') {
        i++
        const v = binary(1)
        if (toks[i]?.text !== ')') fail(L('缺少右括号 )', 'Missing closing parenthesis )'))
        i++
        return v
      }
      if (t.text === '-' || t.text === '+') {
        i++
        const v = primary()
        // -(a - b) is b - a, but a lone label cannot be negated.
        if (t.text === '-' && rel.size) {
          if ([...rel.values()].reduce((x, y) => x + y, 0) !== 0) notRelocatable(t)
          rel = new Map([...rel].map(([b, c]) => [b, -c]))
        }
        return t.text === '-' ? wrap(-v) : v
      }
      if (t.text === '~') {
        i++
        const v = primary()
        constant(t, rel)
        return wrap(~v)
      }
      if (t.text === '!') {
        i++
        const v = primary()
        constant(t, rel)
        return v === 0n ? 1n : 0n
      }
    }
    if (t.kind === 'local') fail(L(`局部标签 ${t.text} 找不到对应的定义`, `Local label ${t.text} has no matching definition`))
    if (t.kind === 'bad') fail(t.error!)
    return fail(L(`这里应该是数字或符号，而不是 "${t.text}"`, `Expected a number or symbol, not "${t.text}"`))
  }

  const binary = (minPrec: number): bigint => {
    let left = primary()
    let leftRel = rel
    for (;;) {
      const t = toks[i]
      if (!t || t.kind !== 'punct') break
      const prec = BINARY[t.text]
      if (prec === undefined || prec < minPrec) break
      i++
      const right = binary(prec + 1)
      if (track) {
        if (t.text === '+' || t.text === '-') leftRel = combine(t, leftRel, rel, t.text === '+' ? 1 : -1)
        else constant(t, leftRel, rel)
      }
      left = apply(t, left, right)
    }
    rel = leftRel
    return left
  }

  const apply = (t: Tok, a: bigint, b: bigint): bigint => {
    switch (t.text) {
      case '+':
        return wrap(a + b)
      case '-':
        return wrap(a - b)
      case '*':
        return wrap(a * b)
      case '/':
        if (b === 0n) return fail(L('除数是 0', 'Division by zero'), t)
        return wrap(a / b)
      case '%':
        if (b === 0n) return fail(L('除数是 0', 'Division by zero'), t)
        return wrap(a % b)
      // LLVM shifts the 64-bit value by the count modulo 64 (what the host's shift instruction does).
      case '<<':
        return wrap(a << (b & 63n))
      case '>>':
        // A logical shift, of the unsigned value.
        return wrap((a & M64) >> (b & 63n))
      case '|':
        return wrap(a | b)
      case '!':
        // Binary ! is "or not".
        return wrap(a | ~b)
      case '&':
        return wrap(a & b)
      case '^':
        return wrap(a ^ b)
      case '&&':
        return a !== 0n && b !== 0n ? 1n : 0n
      case '||':
        return a !== 0n || b !== 0n ? 1n : 0n
      // Comparisons give -1 (all ones) for true, as in GNU as.
      case '==':
        return a === b ? -1n : 0n
      case '!=':
      case '<>':
        return a !== b ? -1n : 0n
      case '<':
        return a < b ? -1n : 0n
      case '<=':
        return a <= b ? -1n : 0n
      case '>':
        return a > b ? -1n : 0n
      case '>=':
        return a >= b ? -1n : 0n
    }
    return fail(L(`不认识的运算符 "${t.text}"`, `Unknown operator "${t.text}"`), t)
  }

  const value = binary(1)
  return { value, end: i, rel }
}
