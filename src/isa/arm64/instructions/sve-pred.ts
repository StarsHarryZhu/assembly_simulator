/**
 * SVE predicate instructions: integer comparisons (vectors, wide elements, immediates), predicate logic,
 * the break instructions, PTEST, PFIRST, PNEXT, PTRUE, PFALSE, the first-fault register, predicate counts
 * and the increments by them, WHILE loops, CTERM, and the SVE2.1 predicate-as-counter instructions (PTRUE,
 * PEXT, CNTP, WHILE with pn registers, PSEL, PMOV).
 *
 * A predicate-as-counter (pn) keeps, in its low 16 bits, the element size (the lowest set bit of bits 3:0),
 * a count of elements, and an invert bit (15): the first `count` elements are active, or with the invert
 * bit the first `count` are inactive and the rest active.
 */
import { T, type Text } from '../../../core/i18n'
import type { AliasSpec, InstrSpec } from '../encoding/table'
import type { Cpu, Fields } from './types'
import { ESIZE, sat, sx, ux } from './vec'
import { bin, patternCount, sizes } from './sve-int'
import { highBit, lowBit } from '../encoding/sve'
import { count, flagsAt, pget, predTest, pset, zget, zset } from './zvec'

export const INSTRS: InstrSpec[] = []
export const ALIASES: AliasSpec[] = []
const G = 'svepred'

/* ------------------------------------------------------------------ comparisons */

type Cond = (a: bigint, b: bigint) => boolean
const CONDS: Record<string, Cond> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  ge: (a, b) => a >= b,
  gt: (a, b) => a > b,
  le: (a, b) => a <= b,
  lt: (a, b) => a < b,
  hs: (a, b) => a >= b,
  hi: (a, b) => a > b,
  ls: (a, b) => a <= b,
  lo: (a, b) => a < b,
}
const SIGNED = new Set(['ge', 'gt', 'le', 'lt'])
const COND_TEXT: Record<string, Text> = {
  eq: T('等于', 'equal'),
  ne: T('不等于', 'not equal'),
  ge: T('有符号大于等于', 'signed greater than or equal'),
  gt: T('有符号大于', 'signed greater than'),
  le: T('有符号小于等于', 'signed less than or equal'),
  lt: T('有符号小于', 'signed less than'),
  hs: T('无符号大于等于', 'unsigned higher or same'),
  hi: T('无符号大于', 'unsigned higher'),
  ls: T('无符号小于等于', 'unsigned lower or same'),
  lo: T('无符号小于', 'unsigned lower'),
}

/** Write a comparison's result to Pd (inactive elements false) and set NZCV as PTEST would. */
function compare(c: Cpu, f: Fields, es: number, test: (i: number) => boolean): void {
  const pg = pget(c, f.Pg!, es)
  const res = pg.map((on, i) => on && test(i))
  pset(c, f.Pd!, res, es)
  c.setFlags(predTest(pg, res))
}

const cmpDesc = (cc: string, what: Text) => T(`比较活跃元素是否${COND_TEXT[cc]!.zh}${what.zh}，结果放进谓词 Pd（不活跃的元素为假），并按结果设置 NZCV`, `Compare whether the active elements are ${COND_TEXT[cc]!.en} ${what.en}; the result goes to Pd (false in inactive elements) and sets NZCV`)

// Vectors: [cond, op (bit 15), o2 (bit 13), ne (bit 4)].
for (const [cc, bits15, ne] of [
  ['hs', '000', 0],
  ['hi', '000', 1],
  ['ge', '100', 0],
  ['gt', '100', 1],
  ['eq', '101', 0],
  ['ne', '101', 1],
] as const) {
  const cond = CONDS[cc]!
  INSTRS.push({
    id: `sve-cmp${cc}`,
    mnemonic: `cmp${cc}`,
    group: G,
    feature: 'sve',
    bits: `00100100 size:2 0 Zm:5 ${bits15} Pg:3 Zn:5 ${ne} Pd:4`,
    syntax: '<Pd.size>, <Pg/z>, <Zn.size>, <Zm.size>',
    desc: cmpDesc(cc, T(' Zm 的对应元素', ' the matching element of Zm')),
    exec(c, f) {
      const es = f.size!
      const a = zget(c, f.Zn!, es)
      const b = zget(c, f.Zm!, es)
      const signed = SIGNED.has(cc)
      compare(c, f, es, (i) => cond(signed ? sx(a[i]!, es) : a[i]!, signed ? sx(b[i]!, es) : b[i]!))
    },
  })
}
// Assembly-only spellings with the operands swapped.
for (const [cc, of] of [
  ['le', 'ge'],
  ['lt', 'gt'],
  ['ls', 'hs'],
  ['lo', 'hi'],
] as const) {
  ALIASES.push({ id: `sve-cmp${cc}-swap`, of: `sve-cmp${of}`, mnemonic: `cmp${cc}`, syntax: '<Pd.size>, <Pg/z>, <Zm.size>, <Zn.size>', prefer: false, desc: cmpDesc(cc, T(' Zm 的对应元素', ' the matching element of Zm')) })
}

// Wide elements: the second operand is a 64-bit element covering each element. [cond, bits 15:13, ne].
for (const [cc, b, ne] of [
  ['eq', '001', 0],
  ['ne', '001', 1],
  ['ge', '010', 0],
  ['gt', '010', 1],
  ['lt', '011', 0],
  ['le', '011', 1],
  ['hs', '110', 0],
  ['hi', '110', 1],
  ['lo', '111', 0],
  ['ls', '111', 1],
] as const) {
  const cond = CONDS[cc]!
  INSTRS.push({
    id: `sve-cmp${cc}-wide`,
    mnemonic: `cmp${cc}`,
    group: G,
    feature: 'sve',
    bits: `00100100 size:2 0 Zm:5 ${b} Pg:3 Zn:5 ${ne} Pd:4`,
    syntax: '<Pd.size>, <Pg/z>, <Zn.size>, <Zm.d>',
    valid: sizes('bhs'),
    desc: cmpDesc(cc, T(' Zm 中覆盖它的 64 位元素', ' the 64-bit Zm element that covers it')),
    exec(c, f) {
      const es = f.size!
      const a = zget(c, f.Zn!, es)
      const w = zget(c, f.Zm!, 3)
      const signed = cc === 'eq' || cc === 'ne' || SIGNED.has(cc)
      compare(c, f, es, (i) => {
        const wide = w[Math.floor((i * ESIZE[es]!) / 64)]!
        return cond(signed ? sx(a[i]!, es) : a[i]!, signed ? sx(wide, 3) : wide)
      })
    },
  })
}

// Unsigned immediates 0–127: [cond, lt, ne].
for (const [cc, lt, ne] of [
  ['hs', 0, 0],
  ['hi', 0, 1],
  ['lo', 1, 0],
  ['ls', 1, 1],
] as const) {
  const cond = CONDS[cc]!
  INSTRS.push({
    id: `sve-cmp${cc}-imm`,
    mnemonic: `cmp${cc}`,
    group: G,
    feature: 'sve',
    bits: `00100100 size:2 1 imm7:7 ${lt} Pg:3 Zn:5 ${ne} Pd:4`,
    syntax: '<Pd.size>, <Pg/z>, <Zn.size>, #<u:imm7>',
    desc: cmpDesc(cc, T('立即数', ' an immediate')),
    exec(c, f) {
      const es = f.size!
      const a = zget(c, f.Zn!, es)
      compare(c, f, es, (i) => cond(a[i]!, BigInt(f.imm7!)))
    },
  })
}
// Signed immediates −16–15: [cond, bits 15:13, ne].
for (const [cc, b, ne] of [
  ['ge', '000', 0],
  ['gt', '000', 1],
  ['lt', '001', 0],
  ['le', '001', 1],
  ['eq', '100', 0],
  ['ne', '100', 1],
] as const) {
  const cond = CONDS[cc]!
  INSTRS.push({
    id: `sve-cmp${cc}-imm`,
    mnemonic: `cmp${cc}`,
    group: G,
    feature: 'sve',
    bits: `00100101 size:2 0 imm5:5 ${b} Pg:3 Zn:5 ${ne} Pd:4`,
    syntax: '<Pd.size>, <Pg/z>, <Zn.size>, #<s:imm5>',
    desc: cmpDesc(cc, T('立即数', ' an immediate')),
    exec(c, f) {
      const es = f.size!
      const a = zget(c, f.Zn!, es)
      const imm = BigInt.asIntN(5, BigInt(f.imm5!))
      compare(c, f, es, (i) => cond(sx(a[i]!, es), imm))
    },
  })
}

/* ------------------------------------------------------------------ predicate logic */

const LOGIC: [string, number, number, number, Text, (n: number, m: number) => number][] = [
  ['and', 0, 0, 0, T('与', 'AND'), (n, m) => n & m],
  ['bic', 0, 0, 1, T('与非（Pn AND NOT Pm）', 'bit clear (Pn AND NOT Pm)'), (n, m) => n & ~m & 1],
  ['eor', 0, 1, 0, T('异或', 'exclusive OR'), (n, m) => n ^ m],
  ['orr', 1, 0, 0, T('或', 'OR'), (n, m) => n | m],
  ['orn', 1, 0, 1, T('或非（Pn OR NOT Pm）', 'OR NOT (Pn OR NOT Pm)'), (n, m) => (n | ~m) & 1],
  ['nor', 1, 1, 0, T('或后取反', 'NOR'), (n, m) => ~(n | m) & 1],
  ['nand', 1, 1, 1, T('与后取反', 'NAND'), (n, m) => ~(n & m) & 1],
]
for (const [m, op, o2, o3, what, fn] of LOGIC) {
  for (const S of [0, 1]) {
    INSTRS.push({
      id: `sve-${m}${S ? 's' : ''}-p`,
      mnemonic: `${m}${S ? 's' : ''}`,
      group: G,
      feature: 'sve',
      bits: `00100101 ${op}${S} 00 Pm:4 01 Pg:4 ${o2} Pn:4 ${o3} Pd:4`,
      syntax: '<Pd.b>, <Pg/z>, <Pn.b>, <Pm.b>',
      desc: T(`谓词按位${what.zh}，不活跃的位清零${S ? '，并按结果设置 NZCV' : ''}`, `Predicate bitwise ${what.en}, zero where Pg is false${S ? ', setting NZCV from the result' : ''}`),
      exec(c, f) {
        const g = c.pread(f.Pg!)
        const n = c.pread(f.Pn!)
        const p = c.pread(f.Pm!)
        const out = g.map((on, i) => (on ? fn(n[i]!, p[i]!) : 0))
        c.pwrite(f.Pd!, out)
        if (S) c.setFlags(predTest(flagsAt(g, 0), flagsAt(out, 0)))
      },
    })
  }
}
INSTRS.push({
  id: 'sve-sel-p',
  mnemonic: 'sel',
  group: G,
  feature: 'sve',
  bits: '00100101 00 00 Pm:4 01 Pg:4 1 Pn:4 1 Pd:4',
  syntax: '<Pd.b>, <Pg>, <Pn.b>, <Pm.b>',
  desc: T('按谓词选择：Pg 为真的位取 Pn，其余取 Pm', 'Select by predicate: Pn where Pg is true, Pm elsewhere'),
  exec(c, f) {
    const g = c.pread(f.Pg!)
    const n = c.pread(f.Pn!)
    const p = c.pread(f.Pm!)
    c.pwrite(f.Pd!, g.map((on, i) => (on ? n[i]! : p[i]!)))
  },
})
ALIASES.push(
  { id: 'sve-mov-p', of: 'sve-orr-p', mnemonic: 'mov', syntax: '<Pd.b>, <Pn.b>', encode: (f) => void ((f.Pg = f.Pn), (f.Pm = f.Pn)), prefer: (f) => f.Pg === f.Pn && f.Pm === f.Pn },
  { id: 'sve-movs-p', of: 'sve-orrs-p', mnemonic: 'movs', syntax: '<Pd.b>, <Pn.b>', encode: (f) => void ((f.Pg = f.Pn), (f.Pm = f.Pn)), prefer: (f) => f.Pg === f.Pn && f.Pm === f.Pn },
  { id: 'sve-mov-and-p', of: 'sve-and-p', mnemonic: 'mov', syntax: '<Pd.b>, <Pg/z>, <Pn.b>', encode: (f) => void (f.Pm = f.Pn), prefer: (f) => f.Pm === f.Pn },
  { id: 'sve-movs-ands-p', of: 'sve-ands-p', mnemonic: 'movs', syntax: '<Pd.b>, <Pg/z>, <Pn.b>', encode: (f) => void (f.Pm = f.Pn), prefer: (f) => f.Pm === f.Pn },
  { id: 'sve-mov-sel-p', of: 'sve-sel-p', mnemonic: 'mov', syntax: '<Pd.b>, <Pg/m>, <Pn.b>', encode: (f) => void (f.Pm = f.Pd), prefer: (f) => f.Pm === f.Pd },
  { id: 'sve-not-p', of: 'sve-eor-p', mnemonic: 'not', syntax: '<Pd.b>, <Pg/z>, <Pn.b>', encode: (f) => void (f.Pm = f.Pg), prefer: (f) => f.Pm === f.Pg },
  { id: 'sve-nots-p', of: 'sve-eors-p', mnemonic: 'nots', syntax: '<Pd.b>, <Pg/z>, <Pn.b>', encode: (f) => void (f.Pm = f.Pg), prefer: (f) => f.Pm === f.Pg },
)

/* ------------------------------------------------------------------ breaks */

/** The value of x at the last element mask has (false when mask has none). */
function lastActive(mask: boolean[], x: boolean[]): boolean {
  const i = mask.lastIndexOf(true)
  return i >= 0 && x[i]!
}

for (const S of [0, 1]) {
  for (const B of [0, 1]) {
    const m = `brkp${B ? 'b' : 'a'}${S ? 's' : ''}`
    INSTRS.push({
      id: `sve-${m}`,
      mnemonic: m,
      group: G,
      feature: 'sve',
      bits: `00100101 0 ${S} 00 Pm:4 11 Pg:4 0 Pn:4 ${B} Pd:4`,
      syntax: '<Pd.b>, <Pg/z>, <Pn.b>, <Pm.b>',
      desc: T(`传递断点：Pn 的最后一个活跃元素为真时，Pd 从头为真，直到 Pm 第一个为真的活跃元素${B ? '之前' : '（含）'}；否则全假${S ? '；设置 NZCV' : ''}`, `Propagate break: when the last active element of Pn is true, Pd is true up to ${B ? 'before' : 'and including'} the first true active element of Pm; otherwise all false${S ? '; sets NZCV' : ''}`),
      exec(c, f) {
        const g = pget(c, f.Pg!, 0)
        const n = pget(c, f.Pn!, 0)
        const p = pget(c, f.Pm!, 0)
        let last = lastActive(g, n)
        const res = g.map((on, i) => {
          if (!on) return false
          if (B) last = last && !p[i]
          const r = last
          if (!B) last = last && !p[i]
          return r
        })
        pset(c, f.Pd!, res, 0)
        if (S) c.setFlags(predTest(g, res))
      },
    })
  }
}

for (const [B, S, M] of [
  [0, 0, 'M'],
  [0, 1, 0],
  [1, 0, 'M'],
  [1, 1, 0],
] as const) {
  const m = `brk${B ? 'b' : 'a'}${S ? 's' : ''}`
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: G,
    feature: 'sve',
    bits: `00100101 ${B}${S} 010000 01 Pg:4 0 Pn:4 ${M === 'M' ? 'M' : '0'} Pd:4`,
    syntax: S ? '<Pd.b>, <Pg/z>, <Pn.b>' : '<Pd.b>, <Pg/M>, <Pn.b>',
    desc: T(`断点：Pd 从第一个活跃元素起为真，直到 Pn 第一个为真的活跃元素${B ? '之前' : '（含）'}${S ? '；设置 NZCV' : ''}`, `Break ${B ? 'before' : 'after'}: Pd is true from the first active element up to ${B ? 'before' : 'and including'} the first true active element of Pn${S ? '; sets NZCV' : ''}`),
    exec(c, f) {
      const g = pget(c, f.Pg!, 0)
      const n = pget(c, f.Pn!, 0)
      const old = pget(c, f.Pd!, 0)
      let brk = false
      const res = g.map((on, i) => {
        if (!on) return f.M === 1 ? old[i]! : false
        if (B) brk = brk || n[i]!
        const r = !brk
        if (!B) brk = brk || n[i]!
        return r
      })
      pset(c, f.Pd!, res, 0)
      if (S) c.setFlags(predTest(g, res))
    },
  })
}
for (const S of [0, 1]) {
  INSTRS.push({
    id: `sve-brkn${S ? 's' : ''}`,
    mnemonic: `brkn${S ? 's' : ''}`,
    group: G,
    feature: 'sve',
    bits: `00100101 0${S} 011000 01 Pg:4 0 Pn:4 0 Pdm:4`,
    syntax: '<Pdm.b>, <Pg/z>, <Pn.b>, <Pdm.b>',
    desc: T(`传递到下一段：Pn 的最后一个活跃元素为真时 Pdm 不变，否则全部清零${S ? '；设置 NZCV' : ''}`, `Propagate to the next partition: Pdm stays when the last active element of Pn is true, else becomes all false${S ? '; sets NZCV' : ''}`),
    exec(c, f) {
      const g = pget(c, f.Pg!, 0)
      const keep = lastActive(g, pget(c, f.Pn!, 0))
      const res = keep ? pget(c, f.Pdm!, 0) : g.map(() => false)
      pset(c, f.Pdm!, res, 0)
      if (S) c.setFlags(predTest(res.map(() => true), res))
    },
  })
}

/* ------------------------------------------------------------------ PTEST, PFIRST, PNEXT, PTRUE, FFR */

INSTRS.push(
  {
    id: 'sve-ptest',
    mnemonic: 'ptest',
    group: G,
    feature: 'sve',
    bits: '00100101 01 010000 11 Pg:4 0 Pn:4 0 0000',
    syntax: '<Pg>, <Pn.b>',
    desc: T('按 Pg 检查 Pn，设置 NZCV：N = 第一个活跃元素为真，Z = 没有为真的活跃元素，C = 最后一个活跃元素不为真', 'Test Pn under Pg and set NZCV: N = the first active element is true, Z = no active element is true, C = the last active element is not true'),
    exec: (c, f) => c.setFlags(predTest(pget(c, f.Pg!, 0), pget(c, f.Pn!, 0))),
  },
  {
    id: 'sve-pfirst',
    mnemonic: 'pfirst',
    group: G,
    feature: 'sve',
    bits: '00100101 01 011000 110000 0 Pg:4 0 Pdn:4',
    syntax: '<Pdn.b>, <Pg>, <Pdn.b>',
    desc: T('把 Pg 的第一个活跃元素在 Pdn 里设为真，设置 NZCV', 'Set the first active element of Pg in Pdn; sets NZCV'),
    exec(c, f) {
      const g = pget(c, f.Pg!, 0)
      const res = pget(c, f.Pdn!, 0)
      const first = g.indexOf(true)
      if (first >= 0) res[first] = true
      pset(c, f.Pdn!, res, 0)
      c.setFlags(predTest(g, res))
    },
  },
  {
    id: 'sve-pnext',
    mnemonic: 'pnext',
    group: G,
    feature: 'sve',
    bits: '00100101 size:2 011001 110001 0 Pv:4 0 Pdn:4',
    syntax: '<Pdn.size>, <Pv>, <Pdn.size>',
    desc: T('只留下 Pv 中排在 Pdn 最后一个真元素之后的第一个活跃元素：用来逐个遍历活跃元素；设置 NZCV', 'Keep only the first active element of Pv after the last true element of Pdn, to visit active elements one by one; sets NZCV'),
    exec(c, f) {
      const es = f.size!
      const mask = pget(c, f.Pv!, es)
      const op = pget(c, f.Pdn!, es)
      let next = op.lastIndexOf(true) + 1
      while (next < mask.length && !mask[next]) next++
      const res = mask.map((_, i) => i === next)
      pset(c, f.Pdn!, res, es)
      c.setFlags(predTest(mask, res))
    },
  },
)
for (const S of [0, 1]) {
  INSTRS.push({
    id: `sve-ptrue${S ? 's' : ''}`,
    mnemonic: `ptrue${S ? 's' : ''}`,
    group: G,
    feature: 'sve',
    bits: `00100101 size:2 01100 ${S} 111000 pattern:5 0 Pd:4`,
    syntax: '<Pd.size>{, <pattern>}',
    desc: T(`按模式把前面若干个元素设为真（默认 all：全部）${S ? '，设置 NZCV' : ''}`, `Set the first elements a pattern selects to true (all by default)${S ? ', setting NZCV' : ''}`),
    exec(c, f) {
      const es = f.size!
      const k = patternCount(c, f.pattern!, es)
      const res = Array.from({ length: count(c, es) }, (_, i) => i < k)
      pset(c, f.Pd!, res, es)
      // PTRUES tests the result against itself.
      if (S) c.setFlags(predTest(res, res))
    },
  })
}
INSTRS.push(
  {
    id: 'sve-pfalse',
    mnemonic: 'pfalse',
    group: G,
    feature: 'sve',
    bits: '00100101 00 011000 111001 000000 Pd:4',
    syntax: '<Pd.b>',
    desc: T('把谓词全部清零', 'Set a predicate to all false'),
    exec: (c, f) => c.pwrite(f.Pd!, new Uint8Array(c.vl)),
  },
  {
    id: 'sve-rdffr',
    mnemonic: 'rdffr',
    group: G,
    feature: 'sve',
    bits: '00100101 00 011001 111100 000000 Pd:4',
    syntax: '<Pd.b>',
    desc: T('读出首次故障寄存器 FFR', 'Read the first-fault register FFR'),
    exec: (c, f) => c.pwrite(f.Pd!, c.pread(16)),
  },
  ...[0, 1].map(
    (S): InstrSpec => ({
      id: `sve-rdffr${S ? 's' : ''}-z`,
      mnemonic: `rdffr${S ? 's' : ''}`,
      group: G,
      feature: 'sve',
      bits: `00100101 0${S} 011000 111100 0 Pg:4 0 Pd:4`,
      syntax: '<Pd.b>, <Pg/z>',
      desc: T(`读出 FFR 中 Pg 为真的位${S ? '，设置 NZCV' : ''}`, `Read the bits of FFR where Pg is true${S ? ', setting NZCV' : ''}`),
      exec(c, f) {
        const g = c.pread(f.Pg!)
        const ffr = c.pread(16)
        const out = g.map((on, i) => on & ffr[i]!)
        c.pwrite(f.Pd!, out)
        if (S) c.setFlags(predTest(flagsAt(g, 0), flagsAt(out, 0)))
      },
    }),
  ),
  {
    id: 'sve-setffr',
    mnemonic: 'setffr',
    group: G,
    feature: 'sve',
    bits: '00100101 00 101100 100100 0000000000',
    syntax: '',
    desc: T('把首次故障寄存器 FFR 全部设为真：首次故障加载之前先做', 'Set every bit of the first-fault register FFR: do this before first-fault loads'),
    exec: (c) => c.pwrite(16, new Uint8Array(c.vl).fill(1)),
  },
  {
    id: 'sve-wrffr',
    mnemonic: 'wrffr',
    group: G,
    feature: 'sve',
    bits: '00100101 00 101000 100100 0 Pn:4 00000',
    syntax: '<Pn.b>',
    desc: T('把谓词写进首次故障寄存器 FFR', 'Write a predicate to the first-fault register FFR'),
    exec: (c, f) => c.pwrite(16, c.pread(f.Pn!)),
  },
)

/* ------------------------------------------------------------------ predicate counts */

const activeCount = (c: Cpu, f: Fields, pm: number, es: number) => pget(c, pm, es).filter(Boolean).length
const M64 = 0xffff_ffff_ffff_ffffn

INSTRS.push({
  id: 'sve-cntp',
  mnemonic: 'cntp',
  group: G,
  feature: 'sve',
  bits: '00100101 size:2 100 000 10 Pg:4 0 Pn:4 Rd:5',
  syntax: '<Xd>, <Pg>, <Pn.size>',
  desc: T('Xd = Pg 和 Pn 都为真的元素个数', 'Xd = the number of elements true in both Pg and Pn'),
  exec(c, f) {
    const es = f.size!
    const g = pget(c, f.Pg!, es)
    c.setX(f.Rd!, BigInt(pget(c, f.Pn!, es).filter((b, i) => b && g[i]).length))
  },
})
for (const D of [0, 1]) {
  const op = D ? 'dec' : 'inc'
  INSTRS.push(
    {
      id: `sve-${op}p`,
      mnemonic: `${op}p`,
      group: G,
      feature: 'sve',
      bits: `00100101 size:2 1011 0 ${D} 10001 00 Pm:4 Rd:5`,
      syntax: '<Xd>, <Pm.size>',
      desc: T(`Xd ${D ? '减去' : '加上'} Pm 中为真的元素个数`, `Xd ${D ? 'minus' : 'plus'} the number of true elements of Pm`),
      exec(c, f) {
        const k = BigInt(activeCount(c, f, f.Pm!, f.size!))
        c.setX(f.Rd!, (D ? c.x(f.Rd!) - k : c.x(f.Rd!) + k) & M64)
      },
    },
    {
      id: `sve-${op}p-vec`,
      mnemonic: `${op}p`,
      group: G,
      feature: 'sve',
      bits: `00100101 size:2 1011 0 ${D} 10000 00 Pm:4 Zdn:5`,
      syntax: '<Zdn.size>, <Pm.size>',
      valid: sizes('hsd'),
      desc: T(`每个元素${D ? '减去' : '加上'} Pm 中为真的元素个数`, `Each element ${D ? 'minus' : 'plus'} the number of true elements of Pm`),
      exec(c, f) {
        const es = f.size!
        const k = BigInt(activeCount(c, f, f.Pm!, es))
        zset(c, f.Zdn!, zget(c, f.Zdn!, es).map((a) => ux(D ? a - k : a + k, es)), es)
      },
    },
  )
  for (const U of [0, 1]) {
    const m = `${U ? 'u' : 's'}q${op}p`
    const delta = (c: Cpu, f: Fields, es: number) => BigInt(activeCount(c, f, f.Pm!, es)) * (D ? -1n : 1n)
    INSTRS.push(
      {
        id: `sve-${m}-w`,
        mnemonic: m,
        group: G,
        feature: 'sve',
        bits: `00100101 size:2 1010 ${D}${U} 10001 0 0 Pm:4 Rd:5`,
        syntax: U ? '<Wd>, <Pm.size>' : '<Xd>, <Pm.size>, <Wd>',
        desc: T(`32 位${U ? '无' : '有'}符号饱和地${D ? '减去' : '加上'} Pm 中为真的元素个数`, `${U ? 'Unsigned' : 'Signed'} saturating 32-bit ${D ? 'decrement' : 'increment'} by the number of true elements of Pm`),
        exec(c, f) {
          const v = U ? c.r(0, f.Rd!) : BigInt.asIntN(32, c.r(0, f.Rd!))
          const r = sat(v + delta(c, f, f.size!), 2, U === 1)[0]
          c.setX(f.Rd!, U ? r : BigInt.asUintN(64, BigInt.asIntN(32, r)))
        },
      },
      {
        id: `sve-${m}-x`,
        mnemonic: m,
        group: G,
        feature: 'sve',
        bits: `00100101 size:2 1010 ${D}${U} 10001 1 0 Pm:4 Rd:5`,
        syntax: '<Xd>, <Pm.size>',
        desc: T(`64 位${U ? '无' : '有'}符号饱和地${D ? '减去' : '加上'} Pm 中为真的元素个数`, `${U ? 'Unsigned' : 'Signed'} saturating 64-bit ${D ? 'decrement' : 'increment'} by the number of true elements of Pm`),
        exec(c, f) {
          const v = U ? c.x(f.Rd!) : BigInt.asIntN(64, c.x(f.Rd!))
          c.setX(f.Rd!, sat(v + delta(c, f, f.size!), 3, U === 1)[0])
        },
      },
      {
        id: `sve-${m}-vec`,
        mnemonic: m,
        group: G,
        feature: 'sve',
        bits: `00100101 size:2 1010 ${D}${U} 10000 0 0 Pm:4 Zdn:5`,
        syntax: '<Zdn.size>, <Pm.size>',
        valid: sizes('hsd'),
        desc: T(`每个元素${U ? '无' : '有'}符号饱和地${D ? '减去' : '加上'} Pm 中为真的元素个数`, `${U ? 'Unsigned' : 'Signed'} saturating ${D ? 'decrement' : 'increment'} of each element by the number of true elements of Pm`),
        exec(c, f) {
          const es = f.size!
          const k = delta(c, f, es)
          zset(c, f.Zdn!, zget(c, f.Zdn!, es).map((a) => sat((U ? a : sx(a, es)) + k, es, U === 1)[0]), es)
        },
      },
    )
  }
}

/* ------------------------------------------------------------------ WHILE and CTERM */

interface WhileOp {
  m: string
  U: number
  lt: number
  eq: number
  /** Decrementing (SVE2): elements fill from the top, the first operand counting down. */
  down: boolean
  cond: Cond
}
const WHILES: WhileOp[] = [
  { m: 'whilege', U: 0, lt: 0, eq: 0, down: true, cond: CONDS.ge! },
  { m: 'whilegt', U: 0, lt: 0, eq: 1, down: true, cond: CONDS.gt! },
  { m: 'whilelt', U: 0, lt: 1, eq: 0, down: false, cond: CONDS.lt! },
  { m: 'whilele', U: 0, lt: 1, eq: 1, down: false, cond: CONDS.le! },
  { m: 'whilehs', U: 1, lt: 0, eq: 0, down: true, cond: CONDS.hs! },
  { m: 'whilehi', U: 1, lt: 0, eq: 1, down: true, cond: CONDS.hi! },
  { m: 'whilelo', U: 1, lt: 1, eq: 0, down: false, cond: CONDS.lo! },
  { m: 'whilels', U: 1, lt: 1, eq: 1, down: false, cond: CONDS.ls! },
]

/** How many elements a WHILE makes true, counting from the start (or, for the decrementing ones, from the end). */
function whileCount(op: WhileOp, a0: bigint, b0: bigint, bits: number, elements: number): number {
  const wrap = (v: bigint) => (op.U ? BigInt.asUintN(bits, v) : BigInt.asIntN(bits, v))
  let a = wrap(a0)
  const b = wrap(b0)
  let n = 0
  while (n < elements && op.cond(a, b)) {
    n++
    a = wrap(op.down ? a - 1n : a + 1n)
  }
  return n
}
const whileOps = (c: Cpu, f: Fields, sf: number) => [sf ? c.x(f.Rn!) : c.r(0, f.Rn!), sf ? c.x(f.Rm!) : c.r(0, f.Rm!)] as const

for (const op of WHILES) {
  const feature = op.down ? 'sve2' : 'sve'
  const desc = T(`循环谓词：${op.down ? '从最后一个元素往前' : '从元素 0 起'}，只要 Xn ${op.down ? '−' : '+'} i ${COND_TEXT[op.m.slice(5)]!.zh} Xm 就为真，第一次不成立后全为假；设置 NZCV`, `Loop predicate: ${op.down ? 'from the last element down' : 'from element 0'}, true while Xn ${op.down ? '−' : '+'} i is ${COND_TEXT[op.m.slice(5)]!.en} Xm, then false from the first failure; sets NZCV`)
  INSTRS.push({
    id: `sve-${op.m}`,
    mnemonic: op.m,
    group: G,
    feature,
    bits: `00100101 size:2 1 Rm:5 000 sf ${op.U} ${op.lt} Rn:5 ${op.eq} Pd:4`,
    syntax: '<Pd.size>, <Rn>, <Rm>',
    desc,
    exec(c, f) {
      const es = f.size!
      const n = count(c, es)
      const [a, b] = whileOps(c, f, f.sf!)
      const k = whileCount(op, a, b, f.sf ? 64 : 32, n)
      const res = Array.from({ length: n }, (_, i) => (op.down ? i >= n - k : i < k))
      pset(c, f.Pd!, res, es)
      c.setFlags(predTest(res.map(() => true), res))
    },
  })
  // SVE2.1: a pair of predicates, the second one continuing where the first ends.
  INSTRS.push({
    id: `sve-${op.m}-pair`,
    mnemonic: op.m,
    group: 'sve2',
    feature: 'sve2p1',
    bits: `00100101 size:2 1 Rm:5 0101 ${op.U} ${op.lt} Rn:5 1 Pd:3 ${op.eq}`,
    syntax: '<PL:Pd:size>, <Xn>, <Xm>',
    desc: T(`${desc.zh}；覆盖两个向量，结果放进一对谓词`, `${desc.en}; covers two vectors, with the result in a pair of predicates`),
    exec(c, f) {
      const es = f.size!
      const n = count(c, es)
      const k = whileCount(op, c.x(f.Rn!), c.x(f.Rm!), 64, 2 * n)
      const res = Array.from({ length: 2 * n }, (_, i) => (op.down ? i >= 2 * n - k : i < k))
      pset(c, 2 * f.Pd!, res.slice(0, n), es)
      pset(c, 2 * f.Pd! + 1, res.slice(n), es)
      c.setFlags(predTest(res.map(() => true), res))
    },
  })
  INSTRS.push({
    id: `sve-${op.m}-pn`,
    mnemonic: op.m,
    group: 'sve2',
    feature: 'sve2p1',
    bits: `00100101 size:2 1 Rm:5 01 vl 0 ${op.U} ${op.lt} Rn:5 1 ${op.eq} PNd:3`,
    syntax: '<PNd.size>, <Xn>, <Xm>, <vlx>',
    desc: T(`${desc.zh}；覆盖 2 或 4 个向量，结果是计数谓词`, `${desc.en}; covers 2 or 4 vectors, with the result as a predicate-as-counter`),
    exec(c, f) {
      const es = f.size!
      const n = count(c, es) * (f.vl ? 4 : 2)
      const k = whileCount(op, c.x(f.Rn!), c.x(f.Rm!), 64, n)
      const pn = encodeCounter(c, es, n, k, op.down)
      c.pwrite(8 + f.PNd!, pn)
      const res = flagsAt(counterBits(c, pn, f.vl ? 4 : 2), es)
      c.setFlags(predTest(res.map(() => true), res))
    },
  })
}

for (const rw of [0, 1]) {
  const m = rw ? 'whilerw' : 'whilewr'
  INSTRS.push({
    id: `sve-${m}`,
    mnemonic: m,
    group: 'sve2',
    feature: 'sve2',
    bits: `00100101 size:2 1 Rm:5 001100 Rn:5 ${rw} Pd:4`,
    syntax: '<Pd.size>, <Xn>, <Xm>',
    desc: rw
      ? T('读后读冲突检查：两个指针相距多少个元素，前面这么多元素为真（不冲突时全为真）', 'Read-after-read conflict check: the first elements, as many as the pointers are apart, are true (all when they do not overlap)')
      : T('写后读冲突检查：从 Xn 写、从 Xm 读时不会互相覆盖的前若干个元素为真', 'Write-after-read conflict check: true for the first elements that writing at Xn and reading at Xm cannot overlap'),
    exec(c, f) {
      const es = f.size!
      const n = count(c, es)
      const bytes = BigInt(ESIZE[es]! / 8)
      const diff0 = BigInt.asIntN(64, c.x(f.Rm!)) - BigInt.asIntN(64, c.x(f.Rn!))
      const diff = (rw ? (diff0 < 0n ? -diff0 : diff0) : diff0) / bytes
      const res = Array.from({ length: n }, (_, i) => (rw ? diff === 0n : diff <= 0n) || BigInt(i) < diff)
      pset(c, f.Pd!, res, es)
      c.setFlags(predTest(res.map(() => true), res))
    },
  })
}

for (const ne of [0, 1]) {
  INSTRS.push({
    id: `sve-cterm${ne ? 'ne' : 'eq'}`,
    mnemonic: `cterm${ne ? 'ne' : 'eq'}`,
    group: G,
    feature: 'sve',
    bits: `00100101 1 sf 1 Rm:5 001000 Rn:5 ${ne} 0000`,
    syntax: '<Rn>, <Rm>',
    desc: T(`比较后决定是否结束循环：${ne ? '不相等' : '相等'}时 N = 1、V = 0，否则 N = 0、V = 非 C；Z 和 C 不变`, `Compare to end a loop: when ${ne ? 'not equal' : 'equal'}, N = 1 and V = 0, else N = 0 and V = NOT C; Z and C stay`),
    exec(c, f) {
      const a = f.sf ? c.x(f.Rn!) : c.r(0, f.Rn!)
      const b = f.sf ? c.x(f.Rm!) : c.r(0, f.Rm!)
      const term = ne ? a !== b : a === b
      const nzcv = c.flags()
      const C = (nzcv >> 1) & 1
      c.setFlags(term ? (1 << 3) | (nzcv & 0b0110) : (nzcv & 0b0110) | (C ? 0 : 1))
    },
  })
}

/* ------------------------------------------------------------------ predicate-as-counter (SVE2.1) */

/**
 * The predicate-as-counter value for `k` active elements of size es out of `elements` (EncodePredCount):
 * the low bits mark the element size, the count sits above them, and bit 15 inverts. `fromEnd` makes the
 * last k elements active instead of the first.
 */
export function encodeCounter(c: Cpu, es: number, elements: number, k: number, fromEnd: boolean): Uint8Array {
  const bits = new Uint8Array(c.vl)
  if (k === 0) return bits
  let n = k
  let invert = fromEnd
  if (fromEnd) n = elements - k
  else if (k === elements) {
    n = 0
    invert = true
  }
  const v = (invert ? 1 << 15 : 0) | (n << (es + 1)) | (1 << es)
  for (let i = 0; i < 16; i++) bits[i] = (v >> i) & 1
  return bits
}

/**
 * The predicate bits (one per byte of `vectors` vectors) a predicate-as-counter stands for, in the counter's
 * own element size (CounterToPredicate). Count bits above what four vectors need are ignored.
 */
export function counterBits(c: Cpu, pn: Uint8Array, vectors: number): Uint8Array {
  let v = 0
  for (let i = 0; i < 16; i++) v |= pn[i]! << i
  const out = new Uint8Array(vectors * c.vl)
  if (!(v & 15)) return out
  const es = lowBit(v & 15)
  const maxbit = highBit(4 * c.vl)
  const k = (v >> (es + 1)) & ((1 << (maxbit - es)) - 1)
  const invert = (v & 0x8000) !== 0
  const step = 1 << es
  for (let e = 0; e * step < out.length; e++) out[e * step] = (e < k) !== invert ? 1 : 0
  return out
}

/** Part `part` of a predicate-as-counter's mask (a vector's worth of elements of size es), one bit per element. */
function pextPart(c: Cpu, all: Uint8Array, es: number, part: number): Uint8Array {
  const step = 1 << es
  const elements = c.vl / step
  const out = new Uint8Array(c.vl)
  for (let e = 0; e < elements; e++) out[e * step] = all[(part * elements + e) * step]!
  return out
}

// PSEL: [element size, bits 23:16 (index and size in i1:tszh:tszl) and Rv, index placeholder].
const PSEL: [number, string, string][] = [
  [0, 'i1 tszh 1 t2:2 1 Rv:2', '<split:i1+tszh+t2>'],
  [1, 'i1 tszh 1 t1 10 Rv:2', '<split:i1+tszh+t1>'],
  [2, 'i1 tszh 1 100 Rv:2', '<split:i1+tszh>'],
  [3, 'i1 1 1 000 Rv:2', '<u:i1>'],
]

INSTRS.push(
  {
    id: 'sve-ptrue-pn',
    mnemonic: 'ptrue',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '00100101 size:2 100000 011110 000001 0 PNd:3',
    syntax: '<PNd.size>',
    desc: T('计数谓词：全部元素活跃', 'Predicate-as-counter with every element active'),
    exec: (c, f) => c.pwrite(8 + f.PNd!, encodeCounter(c, f.size!, count(c, f.size!) * 4, count(c, f.size!) * 4, false)),
  },
  {
    id: 'sve-pext',
    mnemonic: 'pext',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '00100101 size:2 100000 0111 00 imm2:2 PNn:3 1 Pd:4',
    syntax: '<Pd.size>, <PNn[imm2]>',
    desc: T('把计数谓词（覆盖 4 个向量）的第 imm 部分展开成普通谓词', 'Expand part imm of a predicate-as-counter (covering 4 vectors) into a predicate'),
    exec(c, f) {
      c.pwrite(f.Pd!, pextPart(c, counterBits(c, c.pread(8 + f.PNn!), 4), f.size!, f.imm2!))
    },
  },
  {
    id: 'sve-pext-pair',
    mnemonic: 'pext',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '00100101 size:2 100000 011101 0 i1 PNn:3 1 Pd:4',
    syntax: '<PLA:Pd:size>, <PNn[i1]>',
    desc: T('把计数谓词（覆盖 4 个向量）的一半展开成一对谓词', 'Expand half of a predicate-as-counter (covering 4 vectors) into a pair of predicates'),
    exec(c, f) {
      const all = counterBits(c, c.pread(8 + f.PNn!), 4)
      c.pwrite(f.Pd!, pextPart(c, all, f.size!, 2 * f.i1!))
      c.pwrite((f.Pd! + 1) % 16, pextPart(c, all, f.size!, 2 * f.i1! + 1))
    },
  },
  {
    id: 'sve-cntp-pn',
    mnemonic: 'cntp',
    group: 'sve2',
    feature: 'sve2p1',
    bits: '00100101 size:2 100000 10000 vl 1 PNn:4 Rd:5',
    syntax: '<Xd>, <PNn.size>, <vlx>',
    desc: T('Xd = 计数谓词在 2 或 4 个向量里的活跃元素个数', 'Xd = the number of active elements of a predicate-as-counter over 2 or 4 vectors'),
    exec(c, f) {
      const bits = counterBits(c, c.pread(f.PNn!), f.vl ? 4 : 2)
      c.setX(f.Rd!, BigInt(flagsAt(bits, f.size!).filter(Boolean).length))
    },
  },
  ...PSEL.map(
    ([es, bits, idx]): InstrSpec => ({
      id: `sve-psel-${'bhsd'[es]}`,
      mnemonic: 'psel',
      group: 'sve2',
      feature: 'sve2p1',
      bits: `00100101 ${bits} 01 Pn:4 0 Pm:4 0 Pd:4`,
      syntax: `<Pd>, <Pn>, <Pm.${'bhsd'[es]}>[<Wv>, ${idx}]`,
      desc: T('谓词选择：Pm 的第 (Wv + imm) 个元素为真时 Pd = Pn，否则 Pd 全假', 'Predicate select: Pd = Pn when element (Wv + imm) of Pm is true, else all false'),
      exec(c, f) {
        const m = pget(c, f.Pm!, es)
        const e = Number((c.r(0, 12 + f.Rv!) + BigInt(pselIndex(f, es))) % BigInt(m.length))
        c.pwrite(f.Pd!, m[e] ? c.pread(f.Pn!) : new Uint8Array(c.vl))
      },
    }),
  ),
)

/** PSEL's immediate: the bits of i1:tszh:tszl above the element-size marker. */
const pselIndex = (f: Fields, es: number) => [(f.i1! << 3) | (f.tszh! << 2) | f.t2!, (f.i1! << 2) | (f.tszh! << 1) | f.t1!, (f.i1! << 1) | f.tszh!, f.i1!][es]!

// PMOV: [element size, tsz bits (23:22 then 18:17), index placeholder].
const PMOV: [number, string, string][] = [
  [0, '00 1 01 01', ''],
  [1, '00 1 01 1 i1', '[<u:i1>]'],
  [2, '01 1 01 i2:2', '[<u:i2>]'],
  [3, '1 i3h 1 01 i3l:2', '[<split:i3h+i3l>]'],
]
const pmovIndex = (f: Fields, es: number) => [0, f.i1!, f.i2!, (f.i3h! << 2) | f.i3l!][es]!
for (const [es, bits, idx] of PMOV) {
  const t = 'bhsd'[es]
  INSTRS.push(
    {
      id: `sve-pmov-to-p-${t}`,
      mnemonic: 'pmov',
      group: 'sve2',
      feature: 'sve2p1',
      bits: `00000101 ${bits} 0 001110 Zn:5 0 Pd:4`,
      syntax: `<Pd.${t}>, <Zn>${idx}`,
      desc: T('把向量里的一段位当作谓词：Pd 的元素 e 取 Zn 的第 (imm × 元素个数 + e) 位', 'Read a run of vector bits as a predicate: element e of Pd is bit (imm × elements + e) of Zn'),
      exec(c, f) {
        const n = count(c, es)
        const base = pmovIndex(f, es) * n
        const z = c.vread(f.Zn!, c.vl)
        pset(c, f.Pd!, Array.from({ length: n }, (_, e) => ((z[(base + e) >> 3]! >> ((base + e) & 7)) & 1) === 1), es)
      },
    },
    {
      id: `sve-pmov-to-z-${t}`,
      mnemonic: 'pmov',
      group: 'sve2',
      feature: 'sve2p1',
      bits: `00000101 ${bits} 1 001110 0 Pn:4 Zd:5`,
      syntax: `<Zd>${idx}, <Pn.${t}>`,
      desc: T('把谓词写进向量的一段位：Zd 的第 (imm × 元素个数 + e) 位取 Pn 的元素 e；imm 为 0 时其余位清零，否则不变', 'Write a predicate into a run of vector bits: bit (imm × elements + e) of Zd is element e of Pn; the other bits become zero when imm is 0 and stay otherwise'),
      exec(c, f) {
        const n = count(c, es)
        const base = pmovIndex(f, es) * n
        const p = pget(c, f.Pn!, es)
        const z = base === 0 ? new Uint8Array(c.vl) : c.vread(f.Zd!, c.vl)
        p.forEach((b, e) => {
          const bit = base + e
          z[bit >> 3] = b ? z[bit >> 3]! | (1 << (bit & 7)) : z[bit >> 3]! & ~(1 << (bit & 7))
        })
        c.vwrite(f.Zd!, z)
      },
    },
  )
}
