/**
 * Registers every instruction table, in an order that matters twice: an encoding listed earlier wins a tie
 * when decoding, and a form listed earlier is tried first when assembling a mnemonic.
 */
import { defineAliases, defineInstrs } from '../encoding/table'
import * as atomic from './atomic'
import * as branch from './branch'
import * as dpImm from './dp-imm'
import * as dpReg from './dp-reg'
import * as ldst from './ldst'

let done = false

export function loadTables(): void {
  if (done) return
  done = true
  for (const t of [dpImm, dpReg, branch, ldst, atomic]) defineInstrs(t.INSTRS)
  for (const t of [dpImm, dpReg, branch, ldst, atomic]) defineAliases(t.ALIASES)
}
