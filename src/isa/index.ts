/**
 * Architecture registry. MIPS32 and AArch64 are done; x86-64 is listed so the selector shows the plan.
 */
import type { IsaPlugin } from '../core/isa'
import { arm64 } from './arm64'
import { mips } from './mips'

export interface IsaEntry {
  id: string
  displayName: string
  available: boolean
  plugin: IsaPlugin | null
}

export const isas: IsaEntry[] = [
  { id: mips.id, displayName: mips.displayName, available: true, plugin: mips },
  { id: arm64.id, displayName: arm64.displayName, available: true, plugin: arm64 },
  { id: 'x86_64', displayName: 'x86-64', available: false, plugin: null },
]

export const defaultIsa: IsaPlugin = mips

export function getIsa(id: string): IsaPlugin | null {
  return isas.find((e) => e.id === id)?.plugin ?? null
}
