/**
 * Registers every instruction table, in an order that matters twice: an encoding listed earlier wins a tie
 * when decoding, and a form listed earlier is tried first when assembling a mnemonic.
 */
import { defineAliases, defineInstrs } from '../encoding/table'
import * as atomic from './atomic'
import * as branch from './branch'
import * as crypto from './crypto'
import * as dpImm from './dp-imm'
import * as dpReg from './dp-reg'
import * as fp from './fp'
import * as ldst from './ldst'
import * as simdFp from './simd-fp'
import * as simdInt from './simd-int'
import * as simdLdst from './simd-ldst'
import * as simdMore from './simd-more'
import * as sveInt from './sve-int'
import * as sveFp from './sve-fp'
import * as sveLdst from './sve-ldst'
import * as svePerm from './sve-perm'
import * as svePred from './sve-pred'
import * as sve2 from './sve2'
import * as sme from './sme'
import * as sme2 from './sme2'
import * as sme2Vec from './sme2-vec'
import { markStreaming } from './streaming'

let done = false

export function loadTables(): void {
  if (done) return
  done = true
  for (const t of [dpImm, dpReg, branch, ldst, atomic, fp, simdInt, simdMore, simdFp, simdLdst, crypto, sveInt, svePerm, svePred, sveFp, sveLdst, sve2, sme, sme2, sme2Vec]) {
    markStreaming(t.INSTRS)
    defineInstrs(t.INSTRS)
  }
  for (const t of [dpImm, dpReg, branch, ldst, atomic, fp, simdInt, simdMore, simdFp, simdLdst, crypto, sveInt, svePerm, svePred, sveFp, sveLdst, sve2, sme, sme2, sme2Vec]) defineAliases(t.ALIASES)
}
