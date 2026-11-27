/**
 * What Streaming SVE mode forbids. Without FEAT_SME_FA64 (the M5 lacks it, and so does this machine) the
 * Advanced SIMD instructions are illegal there, apart from the scalar floating-point ones, the loads and
 * stores of single SIMD&FP registers and pairs, the scalar FMULX, FRECPE, FRECPS, FRECPX, FRSQRTE and
 * FRSQRTS, and UMOV/SMOV of element 0; scalar FJCVTZS is illegal too. Of SVE, everything that gathers or
 * scatters, the first-fault and non-fault loads and FFR, and a list of instructions with no streaming
 * implementation (ADR, COMPACT, FADDA, FEXPA, the trigonometric helpers, the matrix multiplies, 128-bit
 * permutes, loads and stores, HISTCNT and HISTSEG, MATCH and NMATCH, the bit permutes and the SVE2
 * cryptographic instructions). tests/arm64/streaming.test.ts checks these rules against the M5.
 */
import { NEED, type InstrSpec } from '../encoding/table'

const NEON_GROUPS = new Set(['simd', 'simdfp', 'crypto', 'vload'])
/** Advanced SIMD scalar instructions that stay legal. */
const NEON_LEGAL = /^(fmulx|frecps|frsqrts|frecpe|frecpx|frsqrte)-sch?$|^(ldr|str|ldp|stp|ldnp|stnp)-[bhsdq](-|$)/
/** UMOV and SMOV: legal for element 0 only. */
const MOV_TO_GENERAL = /^[us]mov-[wx][bhsd]$/

const SVE_ILLEGAL = [
  /^sve-adr-/,
  /^sve-(zip|uzp|trn)[12]-q$/,
  /^sve-compact$/,
  /^sve-(rdffrs?(-z)?|setffr|wrffr)$/,
  /^sve-(ftsmul-unpred|fadda|ftmad|ftssel|fexpa|bfmmla|fmmla-[sd]|smmla|usmmla|ummla)$/,
  /^sve-ld(ff|nf)1/,
  /^sve-(ld|st)1[wd]-q-(imm|reg)$/,
  /^sve-ld1ro[bhwd]-/,
  // Gathers and scatters: vector bases, vector offsets, and the vector-plus-scalar forms.
  /-(gvec32|gvec64|gunpacked|gimm)(-sc)?$/,
  /^sve-(ld|st)nt1s?[bhwd]-[sd]-vec$/,
  /^sve-(ld|st)1q$/,
  /^sve-prf[bhwd]-[sd]-(vec32|vec64|unpacked|imm)$/,
  /^sve-pmull[bt]-q$/,
  /^sve-(bext|bdep|bgrp|histcnt|histseg|match|nmatch|aese|aesmc|aesd|aesimc|sm4e|sm4ekey|rax1)$/,
]

/** Set `needs` on every instruction Streaming SVE mode forbids. */
export function markStreaming(specs: InstrSpec[]): void {
  for (const spec of specs) {
    if (spec.needs !== undefined) continue
    if (NEON_GROUPS.has(spec.group)) {
      if (MOV_TO_GENERAL.test(spec.id)) spec.needs = (f) => (f.idx ? NEED.nonStreaming : 0)
      else if (!NEON_LEGAL.test(spec.id)) spec.needs = NEED.nonStreaming
    } else if (spec.id === 'fjcvtzs' || SVE_ILLEGAL.some((r) => r.test(spec.id))) spec.needs = NEED.nonStreaming
  }
}
