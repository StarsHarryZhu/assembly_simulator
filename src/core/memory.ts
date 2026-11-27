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

/** An address's offset in its page (see WideMemory). */
const offsetIn = (addr: number) => addr - Math.floor(addr / PAGE_SIZE) * PAGE_SIZE

/**
 * Sparse memory for a 64-bit address space. Addresses are numbers below 2^49 (see MemoryLayout.addressBits),
 * beyond the reach of 32-bit shifts, so pages are found by division. Little-endian.
 */
export class WideMemory {
  // Offsets are a − key × PAGE_SIZE, not a % PAGE_SIZE: addresses here go beyond 2^31 (the stack is near 2^48),
  // and V8 has no machine instruction for % on such numbers (it calls fmod), while ÷, floor and × are exact
  // and fast for integers of this size.

  private pages = new Map<number, Uint8Array>()
  /** A DataView of each page, for 64-bit access in one operation. */
  private views = new Map<number, DataView>()
  private lastKey = -1
  private lastPage: Uint8Array | null = null
  private lastView: DataView | null = null

  private page(addr: number, create: boolean): Uint8Array | null {
    const key = Math.floor(addr / PAGE_SIZE)
    if (key === this.lastKey) return this.lastPage
    let p = this.pages.get(key) ?? null
    if (!p && create) {
      p = new Uint8Array(PAGE_SIZE)
      this.pages.set(key, p)
      this.views.set(key, new DataView(p.buffer))
    }
    if (p) {
      this.lastKey = key
      this.lastPage = p
      this.lastView = this.views.get(key)!
    }
    return p
  }

  getByte(addr: number): number {
    const p = this.page(addr, false)
    return p ? p[offsetIn(addr)]! : 0
  }

  setByte(addr: number, value: number): void {
    this.page(addr, true)![offsetIn(addr)] = value & 0xff
  }

  /** Unsigned 16-bit. No alignment check. */
  getHalf(addr: number): number {
    return this.getByte(addr) | (this.getByte(addr + 1) << 8)
  }

  setHalf(addr: number, value: number): void {
    this.setByte(addr, value)
    this.setByte(addr + 1, value >>> 8)
  }

  /** 32-bit as a signed int. No alignment check. */
  getWord(addr: number): number {
    const o = offsetIn(addr)
    if (o <= PAGE_SIZE - 4) {
      const p = this.page(addr, false)
      return p ? p[o]! | (p[o + 1]! << 8) | (p[o + 2]! << 16) | (p[o + 3]! << 24) : 0
    }
    return this.getByte(addr) | (this.getByte(addr + 1) << 8) | (this.getByte(addr + 2) << 16) | (this.getByte(addr + 3) << 24)
  }

  setWord(addr: number, value: number): void {
    const o = offsetIn(addr)
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

  /** 64-bit, unsigned. No alignment check. */
  getDword(addr: number): bigint {
    const o = offsetIn(addr)
    if (o <= PAGE_SIZE - 8) return this.page(addr, false) ? this.lastView!.getBigUint64(o, true) : 0n
    const lo = BigInt(this.getWord(addr) >>> 0)
    const hi = BigInt(this.getWord(addr + 4) >>> 0)
    return (hi << 32n) | lo
  }

  setDword(addr: number, value: bigint): void {
    const o = offsetIn(addr)
    if (o <= PAGE_SIZE - 8) {
      this.page(addr, true)
      // setBigUint64 keeps the value modulo 2^64.
      this.lastView!.setBigUint64(o, value, true)
      return
    }
    this.setWord(addr, Number(BigInt.asUintN(32, value)))
    this.setWord(addr + 4, Number(BigInt.asUintN(32, value >> 32n)))
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
