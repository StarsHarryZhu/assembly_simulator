/**
 * The simulated Linux kernel: system calls made with `svc #0` (number in x8, arguments in x0–x5, result in
 * x0, errors as -errno), the process's memory map, and the state the kernel and the C library keep.
 *
 * Kernel and library state lives in one immutable `OsState` object: every change makes a new one, so the
 * machine's undo log only has to remember which object was current before a step.
 */
import { L } from '../../core/i18n'
import type { Environment, InputRequest } from '../../core/isa'

/* ------------------------------------------------------------------ memory map (internal addresses) */

const TOP = 2 ** 48
/** Built-in C library entry points, 16 bytes apart; only executable. */
export const STUB_BASE = 0x100000
/** Where `main` returns to: the start-up code that calls exit with main's result. */
export const MAIN_RETURN = STUB_BASE
export const STUB_END = STUB_BASE + 0x1000
/** The brk heap. */
export const HEAP_BASE = 0x10000000
export const HEAP_LIMIT = 0x20000000
/** The C library's malloc arena. */
export const MALLOC_BASE = 0x20000000
export const MALLOC_LIMIT = 0x40000000
/** Anonymous mmap regions, from 1 TB. */
export const MMAP_BASE = 0x10000000000
export const MMAP_LIMIT = 0x20000000000
export const STACK_TOP = 0xfffffffff000
export const STACK_SIZE = 8 * 1024 * 1024
export const KTEXT_BASE = TOP + 0x800000000000
export const KDATA_BASE = KTEXT_BASE + 0x800000
/** The kernel stack (SP_EL1) ends here; kernel data and stack share [KDATA_BASE, KSTACK_TOP). */
export const KSTACK_TOP = KTEXT_BASE + 0x1100000
export const PAGE = 4096

export const pageUp = (n: number) => Math.ceil(n / PAGE) * PAGE

/* ------------------------------------------------------------------ state */

export interface Block {
  addr: number
  size: number
  /** Creation order, for the memory panel. */
  serial: number
}

export interface OsState {
  /** Current program break. */
  brk: number
  mmaps: readonly Block[]
  /** Next mmap address (regions are never reused, so each starts zeroed). */
  mmapTop: number
  /** Live malloc blocks, by address. */
  allocs: readonly Block[]
  /** Highest address the malloc arena has handed out. */
  arenaTop: number
  serial: number
  /** Read position in the bytes typed so far. */
  stdinPos: number
  /** glibc's random() state: the last 31 values of its additive generator, and where the next goes. */
  rand: { ring: readonly number[]; at: number } | null
  /** Highest program break so far: pages above the break that come back must come back zeroed. */
  brkMax: number
  /** The start of a UTF-8 character written to the terminal whose remaining bytes have not come yet. */
  outPending: readonly number[]
  /** Open files (descriptors 3 and up), in the order they were opened. */
  fds: readonly OpenFile[]
}

export const INITIAL_OS: OsState = {
  brk: HEAP_BASE,
  mmaps: [],
  mmapTop: MMAP_BASE,
  allocs: [],
  arenaTop: MALLOC_BASE,
  serial: 0,
  stdinPos: 0,
  rand: null,
  brkMax: HEAP_BASE,
  outPending: [],
  fds: [],
}

/**
 * An open file description (immutable, like the rest of `OsState`). The file's bytes live in the
 * environment's file system, so every descriptor of a file sees the others' writes, as descriptors of one
 * inode do.
 */
export interface OpenFile {
  fd: number
  name: string
  pos: number
  read: boolean
  write: boolean
  append: boolean
}

/** Thrown when the program needs typed input that has not arrived; the step is retried later. */
export class WaitForInput {
  constructor(readonly request: InputRequest) {}
}

/** What the kernel and the C library need from the machine. Register and memory accesses are logged for undo. */
export interface Host {
  readonly env: Environment
  os: OsState
  x(n: number): bigint
  setX(n: number, v: bigint): void
  load(addr: bigint, size: number): bigint
  store(addr: bigint, size: number, v: bigint): void
  /** The next typed byte, without consuming it; waits for a line when everything typed is used up. */
  peekByte(): number
  nextByte(): number
  out(text: string): void
  sleep(ms: number): void
  exit(code: number): void
  /** Stop the program with an error (an abort in the C library). */
  abort(code: string, message: string): never
}

export const utf8 = new TextDecoder('utf-8')
export const toUtf8 = (s: string) => new TextEncoder().encode(s)

export function readBytes(h: Host, addr: bigint, n: number): Uint8Array {
  // Touch the last byte first, so a length past the end of memory faults before anything is allocated.
  if (n > 0) h.load(addr + BigInt(n - 1), 1)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Number(h.load(addr + BigInt(i), 1))
  return out
}

export function writeBytes(h: Host, addr: bigint, bytes: ArrayLike<number>): void {
  for (let i = 0; i < bytes.length; i++) h.store(addr + BigInt(i), 1, BigInt(bytes[i]! & 0xff))
}

/**
 * Write bytes to the terminal. A terminal decodes UTF-8 across writes, so a character whose bytes arrive
 * in separate writes (putchar one byte at a time) still shows as one character.
 */
export function writeTerminal(h: Host, bytes: ArrayLike<number>): void {
  const all = h.os.outPending.length ? [...h.os.outPending, ...Array.from(bytes)] : Array.from(bytes)
  // Hold back a trailing lead byte (and its continuation bytes) whose character is not complete yet.
  let keep = 0
  for (let k = 1; k <= Math.min(3, all.length); k++) {
    const b = all[all.length - k]!
    if ((b & 0xc0) === 0x80) continue
    const need = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 1
    if (need > k) keep = k
    break
  }
  if (keep || h.os.outPending.length) h.os = { ...h.os, outPending: all.slice(all.length - keep) }
  if (all.length > keep) h.out(utf8.decode(Uint8Array.from(all.slice(0, all.length - keep))))
}

export function readCString(h: Host, addr: bigint, max = 1 << 20): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < max; i++) {
    const b = Number(h.load(addr + BigInt(i), 1))
    if (b === 0) break
    out.push(b)
  }
  return Uint8Array.from(out)
}

/* ------------------------------------------------------------------ system calls */

const ENOENT = 2
const ENXIO = 6
const EBADF = 9
const ENOMEM = 12
const EFAULT = 14
const EEXIST = 17
const EINVAL = 22
const ESPIPE = 29
const ENOSYS = 38

export interface SyscallInfo {
  nr: number
  name: string
  /** Argument registers it reads. */
  args: number
}

export const SYSCALLS: SyscallInfo[] = [
  { nr: 56, name: 'openat', args: 4 },
  { nr: 57, name: 'close', args: 1 },
  { nr: 62, name: 'lseek', args: 3 },
  { nr: 63, name: 'read', args: 3 },
  { nr: 64, name: 'write', args: 3 },
  { nr: 93, name: 'exit', args: 1 },
  { nr: 94, name: 'exit_group', args: 1 },
  { nr: 101, name: 'nanosleep', args: 2 },
  { nr: 113, name: 'clock_gettime', args: 2 },
  { nr: 172, name: 'getpid', args: 0 },
  { nr: 173, name: 'getppid', args: 0 },
  { nr: 174, name: 'getuid', args: 0 },
  { nr: 178, name: 'gettid', args: 0 },
  { nr: 214, name: 'brk', args: 1 },
  { nr: 215, name: 'munmap', args: 2 },
  { nr: 222, name: 'mmap', args: 6 },
  { nr: 278, name: 'getrandom', args: 3 },
]
const BY_NR = new Map(SYSCALLS.map((s) => [s.nr, s]))

/** The file's current bytes, from the file system. */
const fileData = (h: Host, f: OpenFile) => h.env.files.read(f.name) ?? new Uint8Array(0)
/** Replace a descriptor's state. */
const setFd = (h: Host, f: OpenFile) => (h.os = { ...h.os, fds: h.os.fds.map((g) => (g.fd === f.fd ? f : g)) })

/** Write at the file position (or the end, with O_APPEND); a gap left by seeking past the end reads as zeros. */
function fileWrite(h: Host, f: OpenFile, bytes: Uint8Array): void {
  const old = fileData(h, f)
  const pos = f.append ? old.length : f.pos
  const end = pos + bytes.length
  const data = new Uint8Array(Math.max(old.length, end))
  data.set(old)
  data.set(bytes, pos)
  h.env.files.write(f.name, data, false)
  setFd(h, { ...f, pos: end })
}

/** A fault on a user pointer inside a system call (the machine's SIGSEGV), which Linux reports as -EFAULT. */
const isMemoryFault = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'sigsegv' && 'far' in e

/** Run the system call in x8. */
export function syscall(h: Host): void {
  const nr = Number(h.x(8) & 0xffffffffn)
  const info = BY_NR.get(nr)
  if (!info) {
    h.out(L(`\n[系统调用 ${nr} 没有实现，返回 -ENOSYS]\n`, `\n[System call ${nr} is not implemented; it returns -ENOSYS]\n`))
    h.setX(0, BigInt.asUintN(64, BigInt(-ENOSYS)))
    return
  }
  const a = Array.from({ length: info.args }, (_, i) => h.x(i))
  let ret: bigint | null
  try {
    ret = run(h, nr, a)
  } catch (e) {
    // A bad buffer is an error the program gets back, not a signal.
    if (!isMemoryFault(e)) throw e
    ret = BigInt(-EFAULT)
  }
  if (ret !== null) h.setX(0, BigInt.asUintN(64, ret))
}

const MAP_FIXED = 0x10
const MAP_ANONYMOUS = 0x20
const MAP_FIXED_NOREPLACE = 0x100000

/** Remove [addr, end) from the mmap regions, keeping the parts of a region outside it. */
function unmap(h: Host, addr: number, end: number): void {
  const mmaps: Block[] = []
  for (const m of h.os.mmaps) {
    if (m.addr >= end || m.addr + m.size <= addr) mmaps.push(m)
    else {
      if (m.addr < addr) mmaps.push({ ...m, size: addr - m.addr })
      if (m.addr + m.size > end) mmaps.push({ ...m, addr: end, size: m.addr + m.size - end })
    }
  }
  if (mmaps.length !== h.os.mmaps.length || mmaps.some((m, i) => m !== h.os.mmaps[i])) h.os = { ...h.os, mmaps }
}

/** Clear [from, to) (8-byte aligned), which must be mapped: memory a new mapping reuses starts zeroed. */
function zero(h: Host, from: number, to: number): void {
  for (let p = from; p < to; p += 8) if (h.load(BigInt(p), 8) !== 0n) h.store(BigInt(p), 8, 0n)
}

/** Clocks clock_gettime accepts: REALTIME to BOOTTIME_ALARM, and TAI. */
const CLOCKS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11])

function run(h: Host, nr: number, a: bigint[]): bigint | null {
  const int = (v: bigint) => Number(BigInt.asIntN(64, v))
  /** An unsigned int argument (file descriptors). */
  const uint = (v: bigint) => Number(v & 0xffffffffn)
  const file = (fd: number) => h.os.fds.find((f) => f.fd === fd)
  switch (nr) {
    case 63: {
      // read(fd, buf, count)
      const fd = uint(a[0]!)
      const f = file(fd)
      if (fd !== 0 && !f?.read) return BigInt(-EBADF)
      // A count past SSIZE_MAX cannot be a valid buffer.
      const count = int(a[2]!)
      if (count < 0) return BigInt(-EFAULT)
      if (count === 0) return 0n
      if (fd === 0) {
        // A terminal read returns at most one line.
        const bytes: number[] = []
        // Typed lines end in '\n', so only the first byte can wait for input.
        while (bytes.length < count) {
          const b = h.nextByte()
          bytes.push(b)
          if (b === 10) break
        }
        writeBytes(h, a[1]!, bytes)
        return BigInt(bytes.length)
      }
      const data = fileData(h, f!)
      const n = Math.max(0, Math.min(count, data.length - f!.pos))
      writeBytes(h, a[1]!, data.subarray(f!.pos, f!.pos + n))
      setFd(h, { ...f!, pos: f!.pos + n })
      return BigInt(n)
    }
    case 64: {
      // write(fd, buf, count)
      const fd = uint(a[0]!)
      const f = file(fd)
      if (fd !== 1 && fd !== 2 && !f?.write) return BigInt(-EBADF)
      const count = int(a[2]!)
      if (count < 0) return BigInt(-EFAULT)
      const bytes = readBytes(h, a[1]!, count)
      if (fd === 1 || fd === 2) writeTerminal(h, bytes)
      else fileWrite(h, f!, bytes)
      return BigInt(count)
    }
    case 56: {
      // openat(dirfd, path, flags, mode)
      const name = utf8.decode(readCString(h, a[1]!, 4096)).replace(/^\.\//, '')
      const flags = int(a[2]!)
      const acc = flags & 3
      const create = (flags & 0o100) !== 0
      const excl = (flags & 0o200) !== 0
      const trunc = (flags & 0o1000) !== 0
      const append = (flags & 0o2000) !== 0
      if (!name) return BigInt(-ENOENT)
      const data = h.env.files.read(name)
      if (data && create && excl) return BigInt(-EEXIST)
      if (!data && !create) return BigInt(-ENOENT)
      // Linux truncates even when the file is opened read-only.
      const bytes = data && !trunc ? data : new Uint8Array(0)
      if (bytes !== data) h.env.files.write(name, bytes, false)
      let fd = 3
      while (file(fd)) fd++
      // Access mode 3 opens the file for neither reading nor writing.
      const f: OpenFile = { fd, name, pos: 0, read: acc === 0 || acc === 2, write: acc === 1 || acc === 2, append }
      h.os = { ...h.os, fds: [...h.os.fds, f] }
      return BigInt(fd)
    }
    case 57: {
      const fd = uint(a[0]!)
      if (fd <= 2) return 0n
      if (!file(fd)) return BigInt(-EBADF)
      h.os = { ...h.os, fds: h.os.fds.filter((f) => f.fd !== fd) }
      return 0n
    }
    case 62: {
      // lseek(fd, offset, whence)
      const fd = uint(a[0]!)
      const f = file(fd)
      // The terminal cannot seek.
      if (!f) return BigInt(fd <= 2 ? -ESPIPE : -EBADF)
      const off = int(a[1]!)
      const whence = int(a[2]!)
      const size = fileData(h, f).length
      let pos: number
      if (whence === 0) pos = off
      else if (whence === 1) pos = f.pos + off
      else if (whence === 2) pos = size + off
      else if (whence === 3 || whence === 4) {
        // SEEK_DATA, SEEK_HOLE: the file is all data, with the hole at its end.
        if (off < 0 || off >= size) return BigInt(off < 0 ? -EINVAL : -ENXIO)
        pos = whence === 3 ? off : size
      } else return BigInt(-EINVAL)
      if (pos < 0) return BigInt(-EINVAL)
      setFd(h, { ...f, pos })
      return BigInt(pos)
    }
    case 93:
    case 94:
      h.exit(int(a[0]!) & 0xff)
      return null
    case 101: {
      // nanosleep(req, rem): rem is only written when a signal interrupts the sleep, which never happens.
      const sec = BigInt.asIntN(64, h.load(a[0]!, 8))
      const nsec = BigInt.asIntN(64, h.load(a[0]! + 8n, 8))
      if (sec < 0n || nsec < 0n || nsec > 999_999_999n) return BigInt(-EINVAL)
      h.sleep(Math.min(Number(sec) * 1000 + Number(nsec) / 1e6, 60000))
      return 0n
    }
    case 113: {
      // clock_gettime(clock, tp): struct timespec { long tv_sec; long tv_nsec; }
      if (!CLOCKS.has(int(a[0]!))) return BigInt(-EINVAL)
      const ms = h.env.now()
      h.store(a[1]!, 8, BigInt(Math.floor(ms / 1000)))
      h.store(a[1]! + 8n, 8, BigInt(Math.floor((ms % 1000) * 1e6)))
      return 0n
    }
    case 172:
    case 178:
      return 1000n
    case 173:
      return 1n
    case 174:
      return 1000n
    case 214: {
      // brk(addr): 0 or a bad address returns the current break.
      const want = Number(BigInt.asUintN(64, a[0]!))
      if (want >= HEAP_BASE && want <= HEAP_LIMIT) {
        const { brk: old, brkMax } = h.os
        h.os = { ...h.os, brk: want, brkMax: Math.max(brkMax, want) }
        // Shrinking unmapped the whole pages above the break; growing again maps fresh zeroed pages.
        zero(h, pageUp(old), Math.min(pageUp(want), pageUp(brkMax)))
      }
      return BigInt(h.os.brk)
    }
    case 222: {
      // mmap(addr, length, prot, flags, fd, offset): anonymous mappings only.
      const len = BigInt.asUintN(64, a[1]!)
      const flags = int(a[3]!)
      if (a[5]! % BigInt(PAGE) || len === 0n || (flags & 3) === 0) return BigInt(-EINVAL)
      if (!(flags & MAP_ANONYMOUS)) {
        h.out(L('\n[mmap 只支持匿名映射（MAP_ANONYMOUS）]\n', '\n[mmap supports anonymous mappings (MAP_ANONYMOUS) only]\n'))
        return BigInt(-EINVAL)
      }
      if (len > BigInt(MMAP_LIMIT - MMAP_BASE)) return BigInt(-ENOMEM)
      const size = pageUp(Number(len))
      const serial = h.os.serial + 1
      if (flags & (MAP_FIXED | MAP_FIXED_NOREPLACE)) {
        // The mapping goes exactly at addr, replacing whatever was mapped there (or failing, with NOREPLACE).
        if (a[0]! % BigInt(PAGE)) return BigInt(-EINVAL)
        const addr = Number(BigInt.asUintN(64, a[0]!))
        const end = addr + size
        if (addr < MMAP_BASE || end > MMAP_LIMIT) {
          h.out(L(`\n[mmap 的 MAP_FIXED 地址只能在 0x${MMAP_BASE.toString(16)} 到 0x${MMAP_LIMIT.toString(16)} 之间]\n`, `\n[mmap with MAP_FIXED only works between 0x${MMAP_BASE.toString(16)} and 0x${MMAP_LIMIT.toString(16)}]\n`))
          return BigInt(-ENOMEM)
        }
        if (!(flags & MAP_FIXED) && h.os.mmaps.some((m) => m.addr < end && addr < m.addr + m.size)) return BigInt(-EEXIST)
        const reused = addr < h.os.mmapTop
        unmap(h, addr, end)
        h.os = { ...h.os, mmaps: [...h.os.mmaps, { addr, size, serial }], mmapTop: Math.max(h.os.mmapTop, end + PAGE), serial }
        if (reused) zero(h, addr, end)
        return BigInt(addr)
      }
      // Without MAP_FIXED the address is only a hint, which we do not take. Regions are never reused, so
      // each one starts zeroed.
      if (h.os.mmapTop + size > MMAP_LIMIT) return BigInt(-ENOMEM)
      const addr = h.os.mmapTop
      h.os = { ...h.os, mmaps: [...h.os.mmaps, { addr, size, serial }], mmapTop: addr + size + PAGE, serial }
      return BigInt(addr)
    }
    case 215: {
      // munmap(addr, length): pages in the range go, even when that splits a mapping.
      const len = BigInt.asUintN(64, a[1]!)
      if (a[0]! % BigInt(PAGE) || len === 0n || BigInt.asUintN(64, a[0]!) + len > BigInt(TOP)) return BigInt(-EINVAL)
      const addr = Number(a[0]!)
      unmap(h, addr, addr + pageUp(Number(len)))
      return 0n
    }
    case 278: {
      // getrandom(buf, len, flags): GRND_NONBLOCK, GRND_RANDOM and GRND_INSECURE (not the last two together).
      const flags = uint(a[2]!)
      if (flags & ~7 || (flags & 6) === 6) return BigInt(-EINVAL)
      const n = int(a[1]!)
      if (n < 0) return BigInt(-EFAULT)
      // Like the kernel, return what was copied before a bad address (or -EFAULT if nothing was).
      for (let i = 0; i < n; i++) {
        try {
          h.store(a[0]! + BigInt(i), 1, BigInt(Math.floor(Math.random() * 256)))
        } catch (e) {
          if (i && isMemoryFault(e)) return BigInt(i)
          throw e
        }
      }
      return BigInt(n)
    }
  }
  return BigInt(-EFAULT)
}

export const ERRNO_NAMES: Record<number, string> = {
  [ENOENT]: 'ENOENT',
  [ENXIO]: 'ENXIO',
  [EBADF]: 'EBADF',
  [ENOMEM]: 'ENOMEM',
  [EFAULT]: 'EFAULT',
  [EEXIST]: 'EEXIST',
  [EINVAL]: 'EINVAL',
  [ESPIPE]: 'ESPIPE',
  [ENOSYS]: 'ENOSYS',
}
