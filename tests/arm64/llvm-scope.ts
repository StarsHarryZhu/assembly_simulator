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
  // FEAT_TCHANGE and FEAT_TLBID's permission lookaside invalidation (2024–25 extensions).
  'tchangef', 'tchangeb', 'plbi',
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
const SIMD_OTHER = /^(f1cvtl2?|f2cvtl2?|bf1cvtl2?|bf2cvtl2?|fcvtn2?|fscale|fdot|fmlal[bt]|fmlall[bt][bt]|luti[24]|famax|famin|ld(b)?f(add|max|min|maxnm|minnm)(a|l|al)?|st(b)?f(add|max|min|maxnm|minnm)l?|swp(b)?f|ldapur|stlur|ldap1|stl1|setg(p|m|e)t?n?)$/
/**
 * Outside the plan among the scalar FP and Neon forms: FEAT_FPRCVT (Armv9.6: FCVT*, SCVTF and UCVTF between
 * SIMD&FP registers of different sizes, such as fcvtms s0, h1) and the FP8 matrix multiplies (Neon FMMLA,
 * which only exists with byte sources), and FEAT_LRCPC3's post-index LDAPR.
 */
function fpOther(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const cvt = /^(fcvt[amnpz][su]|[su]cvtf) ([hsd])\d+, ([hsd])\d+$/.exec(t)
  return (!!cvt && cvt[2] !== cvt[3]) || /^fmmla v/.test(t) || /^ldapr [wx]\d+, \[\w+\], #/.test(t)
}

/**
 * MOPS with XZR as the size register: like overlapping registers this is CONSTRAINED UNPREDICTABLE (UNDEF or
 * NOP); we choose UNDEFINED for all of them and so decode no instruction, where LLVM decodes this one.
 */
export function mopsSizeZr(text: string): boolean {
  return /^(cpy|set)\w*\s.*\bxzr!/i.test(text.trim())
}

/**
 * Two spellings of one instruction: our BFC (the architecture's preferred alias, as GNU objdump prints it)
 * is LLVM's BFI from XZR/WZR, LLVM prints bitmask MOV immediates signed where we print them unsigned, and
 * LLVM prints BTI without targets as "bti r".
 */
export function sameAlias(ours: string, llvm: string): boolean {
  const o = normalizeAsm(ours)
  const l = normalizeAsm(llvm)
  if (o === 'bti' && l === 'bti r') return true
  const bfc = /^bfc ([wx])(\w+), (#\d+, #\d+)$/.exec(o)
  if (bfc && l === `bfi ${bfc[1]}${bfc[2]}, ${bfc[1]}zr, ${bfc[3]}`) return true
  const mo = /^mov (w|x|wsp|sp)(\w*), #(-?\d+)$/.exec(o)
  const ml = /^mov (w|x|wsp|sp)(\w*), #(-?\d+)$/.exec(l)
  if (!mo || !ml || mo[1] !== ml[1] || mo[2] !== ml[2]) return false
  const bits = mo[1] === 'w' || mo[1] === 'wsp' ? 32 : 64
  return BigInt.asUintN(bits, BigInt(mo[3]!)) === BigInt.asUintN(bits, BigInt(ml[3]!))
}

/** Operations of the SYS family from features outside the plan: MTE tags, PoPS, OCCMO, MEC, RME, ATS1A, TLBIW. */
const SYS_OTHER = /^(dc (i?gd?(vac|sw)|c(i)?gd?(vac|sw|vap|vadp)|gva|gzva|z?gbva|civaps|cigdvaps|c(i)?(gd)?vaoc|ci(gd)?pae|ci(gd)?papa)|at s1e[123]a|tlbi (vmallws2e1|paall|rpal?os))/

/**
 * Implemented forms whose mnemonics SIMD_OTHER also matches: FCVTN to half or single, LDAPUR/STLUR of general
 * registers, and SVE's FSCALE, FDOT and FMLALB/FMLALT on halfwords.
 */
const IN_SCOPE_FORMS = (text: string) =>
  /^fcvtn2?\s+v\d+\.(4h|8h|2s|4s),\s*v\d+\.(4s|2d)/i.test(text.trim()) ||
  /^(ldapur|stlur)\s+[wx]/i.test(text.trim()) ||
  /^fscale\s+z\d+\.[hsd],\s*p\d+\/m/i.test(text.trim()) ||
  /^(fdot|fmlal[bt])\s+z\d+\.s,\s*z\d+\.h,/i.test(text.trim()) ||
  // SME2: FDOT into ZA from halfwords, LUTI2/LUTI4 with one index register, FCVTN from single precision.
  (/^fdot\s+za/i.test(text.trim()) && !/\.b\b/i.test(text)) ||
  /^luti[24]\s+.*zt0,\s*z/i.test(text.trim()) ||
  /^fcvtn\s+z\d+\.h,\s*\{/i.test(text.trim())

/**
 * Outside the plan in the SVE space: SVE2.2 and SVE2.3 (zeroing forms of the unary operations, FIRSTP, LASTP,
 * EXPAND, COMPACT of bytes and halfwords, FRINT32X…FRINT64Z, ADDQP, ADDSUBP, SABAL, UABAL, the widening
 * SCVTF/UCVTF and SCVTFLT/UCVTFLT, the narrowing FCVTZSN/FCVTZUN), FP8 conversions, LUTI6, FEAT_SVE_AES2
 * (multi-vector AES and PMULL/PMLAL), CPA (MADPT, MLAPT), the mixed-width FMMLA (F16F32MM, F8F16MM, F8F32MM)
 * and BFSCALE.
 */
function sveOther(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const m = t.split(' ')[0]!
  if (/^(firstp|lastp|expand|addqp|addsubp|sabal|uabal|madpt|mlapt|bfscale|fcvtzsn|fcvtzun|[su]cvtflt|b?f[12]cvt(lt)?|luti6|pmlal)$/.test(m)) return true
  if (/^frint(32|64)[xz] z/.test(t) || /^(bf|f)cvtn[bt]? z\d+\.b,/.test(t)) return true
  if (m !== 'movprfx' && /^\S+ z\d+\.[bhsdq], p\d+\/z, z\d+\.[bhsdq]$/.test(t)) return true
  if (m === 'compact' && /^compact z\d+\.[bh],/.test(t)) return true
  if (/^[su]cvtf z\d+\.\w, z\d+\.\w$/.test(t)) return true
  if (/^(aese|aesd|aesemc|aesdimc|pmull) \{/.test(t)) return true
  const mm = /^fmmla z\d+\.(\w), z\d+\.(\w),/.exec(t)
  return !!mm && mm[1] !== mm[2]
}

/**
 * Outside the plan in the SME space: SME2.2 (FTMOPA and the other sparse outer products, the 4-way
 * FMOP4A/SMOP4A family, multi-vector FMUL/BFMUL), FEAT_SME_LUTv2 (MOVT to ZT0 from a vector, LUTI4 with two
 * index registers), LUTI6, and FP8 (any of the floating-point forms with byte elements, FMLALL, FVDOTB/T).
 */
function smeOther(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const m = t.split(' ')[0]!
  if (/^(b?ftmopa|stmopa|utmopa|sutmopa|ustmopa|\w*mop4[as]|luti6|fmlall|fvdot[bt])$/.test(m)) return true
  if (/^(fmul|bfmul|famax|famin|fscale|bfscale) \{/.test(t)) return true
  if (/^movt zt0(\[|, z)/.test(t) || /^luti4 .*zt0, \{/.test(t)) return true
  return /^(fdot|fvdot|fmlal|fmopa|fmops|fcvt|fcvtn|bfcvt|bfcvtn) /.test(t) && /\bz\d+\.b\b/.test(t)
}

export function outOfScope(text: string): boolean {
  const m = text.trim().split(/\s+/)[0]!.toLowerCase()
  return OUT_OF_SCOPE.has(m) || LSUI.test(m) || OTHER.test(m) || (SIMD_OTHER.test(m) && !IN_SCOPE_FORMS(text)) || SYS_OTHER.test(text.trim().toLowerCase().replace(/\s+/g, ' ')) || sveOther(text) || smeOther(text) || fpOther(text)
}

/** A system register LLVM names but we print generically (we name only the registers we implement). */
export function unnamedSysreg(ours: string, llvm: string): boolean {
  return /\bs[0-3]_[0-7]_c\d+_c\d+_[0-7]\b/.test(ours) && !/\bs[0-3]_[0-7]_c\d+_c\d+_[0-7]\b/i.test(llvm) && /^(mrs|msr)\b/i.test(llvm.trim())
}

/**
 * SVE element immediates: LLVM prints them unsigned in the element's width (mov z0.b, #0xa7), we print
 * them signed as GNU objdump does (#-89). Equal when our negative values, taken in that width, match.
 */
export function sameSveImm(ours: string, llvm: string): boolean {
  const m = /\bz\d+\.([bhsd])\b/.exec(ours)
  if (!m || !/#-/.test(ours)) return false
  const bits = BigInt(8 << 'bhsd'.indexOf(m[1]!))
  const fixed = ours.replace(/#-(0x[0-9a-f]+|\d+)/g, (_, v: string) => '#' + ((1n << bits) - BigInt(v)).toString())
  return normalizeAsm(fixed) === normalizeAsm(llvm)
}
