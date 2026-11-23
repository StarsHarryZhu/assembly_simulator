/**
 * Architecture registry. MIPS32 is done; AArch64 is being built and is selectable only in the development
 * build (`import.meta.env.DEV`) until every phase is done; x86-64 is listed so the selector shows the plan.
 */
import type { IsaPlugin } from '../core/isa'
import { mips } from './mips'

// Loaded only in the development build, so the published page leaves the unfinished ARM code out.
const arm64: IsaPlugin | null = import.meta.env.DEV ? (await import('./arm64')).arm64 : null

export interface IsaEntry {
  id: string
  displayName: string
  available: boolean
  plugin: IsaPlugin | null
}

export const isas: IsaEntry[] = [
  { id: mips.id, displayName: mips.displayName, available: true, plugin: mips },
  { id: 'arm64', displayName: 'ARMv9-A (AArch64)', available: arm64 !== null, plugin: arm64 },
  { id: 'x86_64', displayName: 'x86-64', available: false, plugin: null },
]

export const defaultIsa: IsaPlugin = mips

export function getIsa(id: string): IsaPlugin | null {
  return isas.find((e) => e.id === id)?.plugin ?? null
}
