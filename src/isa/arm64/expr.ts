/**
 * Integer expressions as GNU as (and LLVM in its GNU mode) evaluates them: 64-bit two's-complement values,
 * symbols, `.` for the current address, and operators with GNU precedence (`|` `&` `^` bind tighter than
 * `+` and `-`). Values are bigints wrapped to 64 bits.
 */
import { L } from '../../core/i18n'
import type { Tok } from './lexer'

export interface ExprContext {
  /** A symbol's value, or undefined while it is not (yet) defined. */
  symbol(name: string): bigint | undefined
  /** The address of the statement (`.`). */
  dot: bigint
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
 * Parse an expression starting at `pos`; returns its value (signed 64-bit) and the index after it.
 * Stops at the first token that cannot continue an expression (`,`, `]`, `!`, …).
 */
export function parseExpr(toks: Tok[], pos: number, ctx: ExprContext): { value: bigint; end: number } {
  let i = pos
  const fail = (message: string, t: Tok | undefined = toks[i]): never => {
    const last = toks[toks.length - 1]
    throw new ExprError(message, t?.col ?? (last ? last.col + last.text.length : 1), t?.text.length ?? 1)
  }

  const primary = (): bigint => {
    const t = toks[i]
    if (!t) return fail(L('这里缺少表达式', 'Expected an expression'))
    if (t.kind === 'num') {
      i++
      return wrap(t.value!)
    }
    if (t.kind === 'ident') {
      i++
      if (t.text === '.') return wrap(ctx.dot)
      const v = ctx.symbol(t.text)
      if (v === undefined) throw new ExprError(L(`符号 "${t.text}" 没有定义`, `Undefined symbol "${t.text}"`), t.col, t.text.length, t.text)
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
      if (t.text === '-') {
        i++
        return wrap(-primary())
      }
      if (t.text === '+') {
        i++
        return primary()
      }
      if (t.text === '~') {
        i++
        return wrap(~primary())
      }
      if (t.text === '!') {
        i++
        return primary() === 0n ? 1n : 0n
      }
    }
    if (t.kind === 'local') fail(L(`局部标签 ${t.text} 找不到对应的定义`, `Local label ${t.text} has no matching definition`))
    if (t.kind === 'bad') fail(t.error!)
    return fail(L(`这里应该是数字或符号，而不是 "${t.text}"`, `Expected a number or symbol, not "${t.text}"`))
  }

  const binary = (minPrec: number): bigint => {
    let left = primary()
    for (;;) {
      const t = toks[i]
      if (!t || t.kind !== 'punct') return left
      const prec = BINARY[t.text]
      if (prec === undefined || prec < minPrec) return left
      i++
      const right = binary(prec + 1)
      left = apply(t, left, right)
    }
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
      case '<<':
        return b >= 64n || b < 0n ? 0n : wrap(a << b)
      case '>>':
        // GNU as shifts its unsigned value right.
        return b >= 64n || b < 0n ? 0n : wrap((a & M64) >> b)
      case '|':
        return wrap(a | b)
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
  return { value, end: i }
}
