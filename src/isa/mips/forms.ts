/**
 * Every source-level instruction form (basic and pseudo) with its operand pattern, plus the matching rules
 * that pick a form for a line. The rules mirror MARS so the same line expands the same way.
 */
import { L } from '../../core/i18n'
import { BASIC } from './instructions'
import type { InstrDef, Op } from './instructions/types'
import { tokenize, type IntClass, type Token } from './lexer'
import { PSEUDO, type PseudoForm } from './pseudo'

export type Spec =
  | { k: 'reg' }
  | { k: 'freg' }
  | { k: 'c0' }
  | { k: 'ident' }
  | { k: 'lparen' }
  | { k: 'rparen' }
  | { k: 'plus' }
  | { k: 'int'; c: IntClass }

export interface Form {
  /** Unique key: "add", "add#2" for the second form of add, and so on. */
  key: string
  name: string
  /** Display syntax, e.g. "lw $t1, -100($t2)". */
  example: string
  spec: Spec[]
  basic: InstrDef | null
  pseudo: PseudoForm | null
}

const DOUBLE = /\.d$|^(ldc1|sdc1)$/

/** Example syntax for a basic instruction, in the same style MARS uses. */
export function exampleOf(d: InstrDef): string {
  let g = 0
  let f = 0
  const gpr = () => ['$t1', '$t2', '$t3'][g++] ?? '$t3'
  const fpr = () => (DOUBLE.test(d.name) ? ['$f2', '$f4', '$f6'] : ['$f0', '$f1', '$f3'])[f++] ?? '$f3'
  const parts = d.ops.map((op: Op) => {
    switch (op) {
      case 'rd':
      case 'rs':
      case 'rt':
        return gpr()
      case 'fd':
      case 'fs':
      case 'ft':
        return fpr()
      case 'c0':
        return '$8'
      case 'sa':
        return '10'
      case 'cc':
        return '1'
      case 'imm':
        return '-100'
      case 'immu':
      case 'code':
        return '100'
      case 'off':
        return 'label'
      case 'tgt':
        return 'target'
      case 'mem': {
        const base = ['$t2', '$t3'][g - 1 < 0 ? 0 : g - 1] ?? '$t2'
        g++
        return `-100(${base})`
      }
    }
  })
  return parts.length ? `${d.name} ${parts.join(', ')}` : d.name
}

export function specOfOps(ops: Op[]): Spec[] {
  const out: Spec[] = []
  for (const op of ops) {
    switch (op) {
      case 'rd':
      case 'rs':
      case 'rt':
        out.push({ k: 'reg' })
        break
      case 'fd':
      case 'fs':
      case 'ft':
        out.push({ k: 'freg' })
        break
      case 'c0':
        out.push({ k: 'c0' })
        break
      case 'sa':
      case 'cc':
        out.push({ k: 'int', c: 'i5' })
        break
      case 'imm':
        out.push({ k: 'int', c: 'i16' })
        break
      case 'immu':
      case 'code':
        out.push({ k: 'int', c: 'i16u' })
        break
      case 'off':
      case 'tgt':
        out.push({ k: 'ident' })
        break
      case 'mem':
        out.push({ k: 'int', c: 'i16' }, { k: 'lparen' }, { k: 'reg' }, { k: 'rparen' })
        break
    }
  }
  return out
}

/** Pattern of a pseudo-instruction example: its operand tokens, classified the way user tokens are. */
export function specOfExample(example: string): Spec[] {
  const toks = tokenize(example).slice(1)
  return toks.map((t): Spec => {
    switch (t.kind) {
      case 'reg':
        return { k: 'reg' }
      case 'freg':
        return { k: 'freg' }
      case 'int':
        return { k: 'int', c: t.intClass! }
      case 'lparen':
        return { k: 'lparen' }
      case 'rparen':
        return { k: 'rparen' }
      case 'plus':
        return { k: 'plus' }
      default:
        return { k: 'ident' }
    }
  })
}

function prettyExample(example: string): string {
  return example.replace(/,(?=\S)/g, ', ')
}

export const FORMS_BY_NAME = new Map<string, Form[]>()
export const ALL_FORMS: Form[] = []

function add(form: Omit<Form, 'key'>): void {
  const list = FORMS_BY_NAME.get(form.name) ?? []
  const key = list.length === 0 ? form.name : `${form.name}#${list.length + 1}`
  const full = { ...form, key }
  list.push(full)
  FORMS_BY_NAME.set(form.name, list)
  ALL_FORMS.push(full)
}

for (const d of BASIC) add({ name: d.name, example: exampleOf(d), spec: specOfOps(d.ops), basic: d, pseudo: null })
for (const p of PSEUDO) add({ name: p.name, example: prettyExample(p.example), spec: specOfExample(p.example), basic: null, pseudo: p })

export type MatchError = { code: 'too-few' | 'too-many'; token: null } | { code: 'bad-type' | 'out-of-range'; token: Token; want: Spec }

function intFits(want: IntClass, t: Token): boolean | 'range' {
  const have = t.intClass!
  const v = t.value!
  if (have === want) return true
  if (want === 'i16' && have === 'i5') return true
  if (want === 'i16u' && have === 'i5') return true
  if (want === 'i32') return true
  if (want === 'i16' && have === 'i16u' && v >= -32768 && v <= 32767) return true
  if (want === 'i16u' && have === 'i16' && v >= 0 && v <= 65535) return true
  return 'range'
}

/** Check operand tokens against a form. Returns null when they match. */
export function check(form: Form, toks: Token[]): MatchError | null {
  const spec = form.spec
  if (toks.length < spec.length) return { code: 'too-few', token: null }
  if (toks.length > spec.length) return { code: 'too-many', token: null }
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i]!
    const t = toks[i]!
    let ok: boolean | 'range' = false
    switch (s.k) {
      case 'reg':
      case 'c0':
        ok = t.kind === 'reg'
        break
      case 'freg':
        ok = t.kind === 'freg'
        break
      case 'ident':
        ok = t.kind === 'ident'
        break
      case 'lparen':
        ok = t.kind === 'lparen'
        break
      case 'rparen':
        ok = t.kind === 'rparen'
        break
      case 'plus':
        ok = t.kind === 'plus'
        break
      case 'int':
        ok = t.kind === 'int' ? intFits(s.c, t) : false
        break
    }
    if (ok === 'range') return { code: 'out-of-range', token: t, want: s }
    if (!ok) return { code: 'bad-type', token: t, want: s }
  }
  return null
}

/**
 * Pick the form for a line: the only candidate, else the first that matches, else the first candidate
 * (whose mismatch becomes the error). Same order as MARS: basic forms, then pseudo forms.
 */
export function choose(name: string, toks: Token[]): { form: Form; error: MatchError | null } | null {
  const list = FORMS_BY_NAME.get(name)
  if (!list || list.length === 0) return null
  if (list.length > 1) {
    for (const f of list) if (check(f, toks) === null) return { form: f, error: null }
  }
  const first = list[0]!
  return { form: first, error: check(first, toks) }
}

export function describeSpec(s: Spec): string {
  switch (s.k) {
    case 'reg':
      return L('通用寄存器（如 $t0）', 'a general register (e.g. $t0)')
    case 'freg':
      return L('浮点寄存器（如 $f0）', 'a float register (e.g. $f0)')
    case 'c0':
      return L('协处理器 0 寄存器编号（如 $12）', 'a coprocessor 0 register number (e.g. $12)')
    case 'ident':
      return L('标签', 'a label')
    case 'lparen':
      return '“(”'
    case 'rparen':
      return '“)”'
    case 'plus':
      return '“+”'
    case 'int':
      return {
        i5: L('0 到 31 的整数', 'an integer from 0 to 31'),
        i16: L('-32768 到 32767 的整数', 'an integer from -32768 to 32767'),
        i16u: L('0 到 65535 的整数', 'an integer from 0 to 65535'),
        i32: L('32 位整数', 'a 32-bit integer'),
      }[s.c]
  }
}
