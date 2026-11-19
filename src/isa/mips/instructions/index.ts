/** The 155 basic instructions, grouped by family. Order matters within a mnemonic: forms are tried in order. */
import { ALU } from './alu'
import { BRANCH } from './branch'
import { COP1 } from './cop1'
import { MEMORY } from './memory'
import { SYSTEM } from './system'
import type { InstrDef } from './types'

export const BASIC: InstrDef[] = [...ALU, ...MEMORY, ...BRANCH, ...SYSTEM, ...COP1]

export const BASIC_BY_NAME = new Map<string, InstrDef[]>()
for (const d of BASIC) {
  const list = BASIC_BY_NAME.get(d.name)
  if (list) list.push(d)
  else BASIC_BY_NAME.set(d.name, [d])
}

export type { InstrDef, Decoded, Cpu, Op, FormatId, Group } from './types'
