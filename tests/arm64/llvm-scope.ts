/** Helpers for comparing with LLVM: text normalisation and the instructions we leave out on purpose. */

/** Lower case, no comments or symbol annotations, one space after commas, every number in decimal, floats by value. */
export function normalizeAsm(text: string): string {
  let s = text.toLowerCase().replace(/\/\/.*$/, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  s = s.replace(/(-?)0x([0-9a-f]+)/g, (_, sign: string, h: string) => (sign ? '-' : '') + BigInt('0x' + h).toString())
  s = s.replace(/\s*,\s*/g, ', ').replace(/\[\s+/g, '[').replace(/\s+\]/g, ']')
  // Floating-point immediates by value: LLVM prints #2.00000000 where we print #2.0.
  s = s.replace(/#(-?\d+\.\d+)/g, (_, v: string) => '#' + Number(v))
  return s
}

/** Mnemonics of features outside the plan (MTE, TME, LS64, GCS, RCPC3, LSE128, D128, debug, trace, BRBE). */
const OUT_OF_SCOPE = new Set([
  'stg', 'stzg', 'st2g', 'stz2g', 'ldg', 'stgp', 'irg', 'gmi', 'subp', 'subps', 'addg', 'subg', 'ldgm', 'stgm', 'stzgm',
  'tstart', 'tcommit', 'tcancel', 'ttest',
  'ld64b', 'st64b', 'st64bv', 'st64bv0',
  'gcsstr', 'gcssttr', 'gcsss1', 'gcsss2', 'gcspushm', 'gcspopm', 'gcspushx', 'gcspopx', 'gcspopcx', 'gcsb', 'chkfeat',
  'ldiapp', 'stilp', 'ldapp', 'stlp',
  'ldclrp', 'ldclrpa', 'ldclrpal', 'ldclrpl', 'ldsetp', 'ldsetpa', 'ldsetpal', 'ldsetpl', 'swpp', 'swppa', 'swppal', 'swppl',
  'mrrs', 'msrr', 'sysp', 'tlbip',
  'dcps1', 'dcps2', 'dcps3', 'drps', 'trcit', 'brb', 'tsb', 'stshh',
  // Armv8-R; RME.
  'dfb', 'apas',
  // FEAT_CMPBR (compare and branch, Armv9.6).
  'cbgt', 'cbge', 'cbhi', 'cbhs', 'cblo', 'cbls', 'cblt', 'cble', 'cbeq', 'cbne', 'cbbgt', 'cbbge', 'cbbhi', 'cbbhs', 'cbbeq', 'cbbne',
  'cbhgt', 'cbhge', 'cbhhi', 'cbhhs', 'cbheq', 'cbhne', 'cbblt', 'cbble', 'cbblo', 'cbbls', 'cbhlt', 'cbhle', 'cbhlo', 'cbhls',
  // CPA (checked pointer arithmetic, Armv9.5).
  'addpt', 'subpt', 'maddpt', 'msubpt',
  // PAuth_LR (Armv9.5).
  'retaasppc', 'retabsppc', 'retaasppcr', 'retabsppcr', 'autiasppc', 'autibsppc', 'autiasppcr', 'autibsppcr', 'pacm', 'pacnbiasppc', 'pacnbibsppc', 'paciasppc', 'pacibsppc', 'autia171615', 'autib171615', 'pacia171615', 'pacib171615',
])

/** FEAT_LSUI (unprivileged atomics and exclusives, Armv9.6). */
const LSUI = /^(ld(a)?txr|st(l)?txr|ldtn?p|sttn?p|cas(a|l|al)?t|casp(a|l|al)?t|swpt(a|l|al)?|ldt(add|clr|set)(a|l|al)?|stt(add|clr|set)l?)$/
/** FEAT_THE (read-check-write) and FEAT_RPRFM. */
const OTHER = /^(rcw|rprfm)/
/**
 * Outside the plan in the SIMD&FP space: FP8 (FEAT_FP8, FP8DOT2/4, FP8FMA), FEAT_LUT, FEAT_FAMINMAX,
 * FEAT_LSFE (floating-point atomics), FEAT_LRCPC3 for SIMD&FP registers, and MTE's tag-setting SETG*.
 */
const SIMD_OTHER = /^(f1cvtl2?|f2cvtl2?|bf1cvtl2?|bf2cvtl2?|fcvtn2?|fscale|fdot|fmlal[bt]|fmlall[bt][bt]|luti[24]|famax|famin|ld(b)?f(add|max|min|maxnm|minnm)(a|l|al)?|st(b)?f(add|max|min|maxnm|minnm)l?|swp(b)?f|ldapur|stlur|ldap1|stl1|setg(p|m|e)n?t?)$/
/** Operations of the SYS family from features outside the plan: MTE tags, PoPS, OCCMO, MEC, RME, ATS1A, TLBIW. */
const SYS_OTHER = /^(dc (i?gd?(vac|sw)|c(i)?gd?(vac|sw|vap|vadp)|gva|gzva|z?gbva|civaps|cigdvaps|c(i)?(gd)?vaoc|ci(gd)?pae|ci(gd)?papa)|at s1e[123]a|tlbi (vmallws2e1|paall|rpal?os))/

/** Implemented forms whose mnemonics SIMD_OTHER also matches: FCVTN to half or single, LDAPUR/STLUR of general registers. */
const IN_SCOPE_FORMS = (text: string) => /^fcvtn2?\s+v\d+\.(4h|8h|2s|4s),\s*v\d+\.(4s|2d)/i.test(text.trim()) || /^(ldapur|stlur)\s+[wx]/i.test(text.trim())

export function outOfScope(text: string): boolean {
  const m = text.trim().split(/\s+/)[0]!.toLowerCase()
  return OUT_OF_SCOPE.has(m) || LSUI.test(m) || OTHER.test(m) || (SIMD_OTHER.test(m) && !IN_SCOPE_FORMS(text)) || SYS_OTHER.test(text.trim().toLowerCase().replace(/\s+/g, ' '))
}

/** A system register LLVM names but we print generically (we name only the registers we implement). */
export function unnamedSysreg(ours: string, llvm: string): boolean {
  return /\bs[0-3]_[0-7]_c\d+_c\d+_[0-7]\b/.test(ours) && !/\bs[0-3]_[0-7]_c\d+_c\d+_[0-7]\b/i.test(llvm) && /^(mrs|msr)\b/i.test(llvm.trim())
}
