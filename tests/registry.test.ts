import { describe, expect, it } from 'vitest'
import { defaultIsa, getIsa, isas } from '../src/isa'

describe('ISA registry', () => {
  it('offers MIPS32 and AArch64 and lists x86-64 as not yet available', () => {
    expect(isas.filter((e) => e.available).map((e) => e.id)).toEqual(['mips32', 'arm64'])
    for (const e of isas) expect(e.plugin !== null, e.id).toBe(e.available)
    expect(getIsa('arm64')?.displayName).toMatch(/AArch64/)
    expect(getIsa('x86_64')).toBeNull()
    expect(defaultIsa.id).toBe('mips32')
  })

  it("suggests a real mnemonic and directive in each plugin's instruction search", () => {
    for (const e of isas) {
      if (!e.plugin) continue
      const [mnemonic, directive] = e.plugin.samples.search
      expect(e.plugin.catalog.some((c) => c.mnemonic === mnemonic), `${e.id} ${mnemonic}`).toBe(true)
      expect(e.plugin.language.directives, e.id).toContain(directive)
    }
  })
})
