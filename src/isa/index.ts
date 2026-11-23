/**
 * Architecture registry. Only MIPS32 exists today; ARM and x86-64 are listed so the selector shows the plan.
 * An ISA still being built is `available` only in the development build (`import.meta.env.DEV`).
 */
import type { IsaPlugin } from '../core/isa'
import { mips } from './mips'

export interface IsaEntry {
  id: string
  displayName: string
  available: boolean
  plugin: IsaPlugin | null
}

export const isas: IsaEntry[] = [
  { id: mips.id, displayName: mips.displayName, available: true, plugin: mips },
  { id: 'arm64', displayName: 'ARM64', available: false, plugin: null },
  { id: 'x86_64', displayName: 'x86-64', available: false, plugin: null },
]

export const defaultIsa: IsaPlugin = mips

export function getIsa(id: string): IsaPlugin | null {
  return isas.find((e) => e.id === id)?.plugin ?? null
}
