/** Per-viewer UI preferences in localStorage. Every access is guarded: storage may be unavailable. */
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

/**
 * A preference key for one ISA. MIPS, the first ISA, keeps the unscoped names it has always used, so the
 * preferences people already saved stay theirs.
 */
export function isaKey(isaId: string, key: string): string {
  return isaId === 'mips32' ? key : `${isaId}.${key}`
}
