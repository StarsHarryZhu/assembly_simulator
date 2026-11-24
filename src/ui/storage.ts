/** Per-viewer UI preferences in localStorage. Every access is guarded: storage may be unavailable. */
import type { IsaPlugin } from '../core/isa'

const PREFIX = 'asmsim.'

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* storage full or blocked: preferences are best-effort */
  }
}

/** An ISA's saved machine settings (such as the SVE vector length); a value it does not offer takes the default. */
export function loadSettings(isa: IsaPlugin): Record<string, number> {
  const out: Record<string, number> = {}
  for (const o of isa.settings ?? []) {
    const v = load<number>(`${isa.id}.setting.${o.id}`, o.default)
    out[o.id] = o.options.some((x) => x.value === v) ? v : o.default
  }
  return out
}

/**
 * A preference key for one ISA. MIPS, the first ISA, keeps the unscoped names it has always used, so the
 * preferences people already saved stay theirs.
 */
export function isaKey(isaId: string, key: string): string {
  return isaId === 'mips32' ? key : `${isaId}.${key}`
}
