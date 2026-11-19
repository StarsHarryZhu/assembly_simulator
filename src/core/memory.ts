/** Sparse byte-addressed memory in 4 KB pages. Untouched bytes read as 0. Little-endian helpers. */
const PAGE_BITS = 12
const PAGE_SIZE = 1 << PAGE_BITS
const PAGE_MASK = PAGE_SIZE - 1

export class PagedMemory {
  private pages = new Map<number, Uint8Array>()
  private lastKey = -1
  private lastPage: Uint8Array | null = null

  private page(addr: number, create: boolean): Uint8Array | null {
    const key = addr >>> PAGE_BITS
    if (key === this.lastKey) return this.lastPage
    let p = this.pages.get(key) ?? null
    if (!p && create) {
      p = new Uint8Array(PAGE_SIZE)
      this.pages.set(key, p)
    }
    if (p) {
      this.lastKey = key
      this.lastPage = p
    }
    return p
  }

  getByte(addr: number): number {
    addr >>>= 0
    const p = this.page(addr, false)
    return p ? p[addr & PAGE_MASK]! : 0
  }

  setByte(addr: number, value: number): void {
    addr >>>= 0
    this.page(addr, true)![addr & PAGE_MASK] = value & 0xff
  }

  /** Little-endian 16-bit, unsigned. No alignment check. */
  getHalf(addr: number): number {
    return this.getByte(addr) | (this.getByte(addr + 1) << 8)
  }

  setHalf(addr: number, value: number): void {
    this.setByte(addr, value)
    this.setByte(addr + 1, value >>> 8)
  }

  /** Little-endian 32-bit as a signed int. No alignment check. */
  getWord(addr: number): number {
    addr >>>= 0
    const p = this.page(addr, false)
    const o = addr & PAGE_MASK
    if (p && o <= PAGE_SIZE - 4) return p[o]! | (p[o + 1]! << 8) | (p[o + 2]! << 16) | (p[o + 3]! << 24)
    if (!p && o <= PAGE_SIZE - 4) return 0
    return this.getByte(addr) | (this.getByte(addr + 1) << 8) | (this.getByte(addr + 2) << 16) | (this.getByte(addr + 3) << 24)
  }

  setWord(addr: number, value: number): void {
    addr >>>= 0
    const o = addr & PAGE_MASK
    if (o <= PAGE_SIZE - 4) {
      const p = this.page(addr, true)!
      p[o] = value
      p[o + 1] = value >>> 8
      p[o + 2] = value >>> 16
      p[o + 3] = value >>> 24
      return
    }
    for (let i = 0; i < 4; i++) this.setByte(addr + i, value >>> (8 * i))
  }

  load(addr: number, bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.setByte(addr + i, bytes[i]!)
  }

  /** Read a NUL-terminated string (bytes as Latin-1 code units), stopping after max bytes. */
  getCString(addr: number, max = 1 << 20): string {
    let s = ''
    for (let i = 0; i < max; i++) {
      const b = this.getByte(addr + i)
      if (b === 0) break
      s += String.fromCharCode(b)
    }
    return s
  }
}
