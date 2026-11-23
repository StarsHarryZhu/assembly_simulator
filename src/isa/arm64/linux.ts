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
}

export const INITIAL_OS: OsState = { brk: HEAP_BASE, mmaps: [], mmapTop: MMAP_BASE, allocs: [], arenaTop: MALLOC_BASE, serial: 0, stdinPos: 0, rand: null }

export interface OpenFile {
  name: string
  data: Uint8Array
  length: number
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
  readonly files: Map<number, OpenFile>
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
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Number(h.load(addr + BigInt(i), 1))
  return out
}

export function writeBytes(h: Host, addr: bigint, bytes: ArrayLike<number>): void {
  for (let i = 0; i < bytes.length; i++) h.store(addr + BigInt(i), 1, BigInt(bytes[i]! & 0xff))
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
const EBADF = 9
const ENOMEM = 12
const EFAULT = 14
const EINVAL = 22
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

function flushFile(h: Host, f: OpenFile) {
  h.env.files.write(f.name, f.data.slice(0, f.length), false)
}

function fileWrite(h: Host, f: OpenFile, bytes: Uint8Array) {
  if (f.append) f.pos = f.length
  const end = f.pos + bytes.length
  if (end > f.data.length) {
    const d = new Uint8Array(Math.max(end, f.data.length * 2, 64))
    d.set(f.data.subarray(0, f.length))
    f.data = d
  }
  f.data.set(bytes, f.pos)
  f.pos = end
  f.length = Math.max(f.length, end)
  flushFile(h, f)
}

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
  const ret = run(h, nr, a)
  if (ret !== null) h.setX(0, BigInt.asUintN(64, ret))
}

function run(h: Host, nr: number, a: bigint[]): bigint | null {
  const int = (v: bigint) => Number(BigInt.asIntN(64, v))
  switch (nr) {
    case 63: {
      // read(fd, buf, count)
      const fd = int(a[0]!)
      const count = int(a[2]!)
      if (count < 0) return BigInt(-EINVAL)
      if (fd === 0) {
        if (count === 0) return 0n
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
      const f = h.files.get(fd)
      if (!f || !f.read) return BigInt(-EBADF)
      const n = Math.max(0, Math.min(count, f.length - f.pos))
      writeBytes(h, a[1]!, f.data.subarray(f.pos, f.pos + n))
      f.pos += n
      return BigInt(n)
    }
    case 64: {
      // write(fd, buf, count)
      const fd = int(a[0]!)
      const count = int(a[2]!)
      if (count < 0) return BigInt(-EINVAL)
      const bytes = readBytes(h, a[1]!, count)
      if (fd === 1 || fd === 2) {
        h.out(utf8.decode(bytes))
        return BigInt(count)
      }
      const f = h.files.get(fd)
      if (!f || !f.write) return BigInt(-EBADF)
      fileWrite(h, f, bytes)
      return BigInt(count)
    }
    case 56: {
      // openat(dirfd, path, flags, mode)
      const name = utf8.decode(readCString(h, a[1]!, 4096)).replace(/^\.\//, '')
      const flags = int(a[2]!)
      const acc = flags & 3
      const create = (flags & 0o100) !== 0
      const trunc = (flags & 0o1000) !== 0
      const append = (flags & 0o2000) !== 0
      if (!name) return BigInt(-ENOENT)
      let data = h.env.files.read(name)
      if (!data) {
        if (!create) return BigInt(-ENOENT)
        data = new Uint8Array(0)
      }
      if (trunc && acc !== 0) data = new Uint8Array(0)
      let fd = 3
      while (h.files.has(fd)) fd++
      const f: OpenFile = { name, data: data.slice(), length: data.length, pos: 0, read: acc !== 1, write: acc !== 0, append }
      h.files.set(fd, f)
      if (f.write) flushFile(h, f)
      return BigInt(fd)
    }
    case 57: {
      const fd = int(a[0]!)
      if (fd >= 0 && fd <= 2) return 0n
      return h.files.delete(fd) ? 0n : BigInt(-EBADF)
    }
    case 62: {
      // lseek(fd, offset, whence)
      const f = h.files.get(int(a[0]!))
      if (!f) return BigInt(-EBADF)
      const off = int(a[1]!)
      const whence = int(a[2]!)
      const base = whence === 0 ? 0 : whence === 1 ? f.pos : whence === 2 ? f.length : NaN
      if (Number.isNaN(base) || base + off < 0) return BigInt(-EINVAL)
      f.pos = base + off
      return BigInt(f.pos)
    }
    case 93:
    case 94:
      h.exit(int(a[0]!) & 0xff)
      return null
    case 101: {
      // nanosleep(req, rem)
      const sec = h.load(a[0]!, 8)
      const nsec = h.load(a[0]! + 8n, 8)
      h.sleep(Math.min(Number(sec) * 1000 + Number(nsec) / 1e6, 60000))
      return 0n
    }
    case 113: {
      // clock_gettime(clock, tp)
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
      if (want >= HEAP_BASE && want <= HEAP_LIMIT) h.os = { ...h.os, brk: want }
      return BigInt(h.os.brk)
    }
    case 222: {
      // mmap(addr, length, prot, flags, fd, offset): anonymous mappings only.
      const len = int(a[1]!)
      const flags = int(a[3]!)
      if (!(flags & 0x20)) {
        h.out(L('\n[mmap 只支持匿名映射（MAP_ANONYMOUS）]\n', '\n[mmap supports anonymous mappings (MAP_ANONYMOUS) only]\n'))
        return BigInt(-EINVAL)
      }
      if (len <= 0) return BigInt(-EINVAL)
      const size = pageUp(len)
      if (h.os.mmapTop + size > MMAP_LIMIT) return BigInt(-ENOMEM)
      const addr = h.os.mmapTop
      h.os = { ...h.os, mmaps: [...h.os.mmaps, { addr, size, serial: h.os.serial + 1 }], mmapTop: addr + size + PAGE, serial: h.os.serial + 1 }
      return BigInt(addr)
    }
    case 215: {
      // munmap(addr, length)
      const addr = Number(BigInt.asUintN(64, a[0]!))
      const len = int(a[1]!)
      if (addr % PAGE || len <= 0) return BigInt(-EINVAL)
      const end = addr + pageUp(len)
      h.os = { ...h.os, mmaps: h.os.mmaps.filter((m) => m.addr + m.size <= addr || m.addr >= end) }
      return 0n
    }
    case 278: {
      // getrandom(buf, len, flags)
      const n = int(a[1]!)
      if (n < 0) return BigInt(-EINVAL)
      writeBytes(h, a[0]!, Array.from({ length: n }, () => Math.floor(Math.random() * 256)))
      return BigInt(n)
    }
  }
  return BigInt(-EFAULT)
}

export const ERRNO_NAMES: Record<number, string> = { [ENOENT]: 'ENOENT', [EBADF]: 'EBADF', [ENOMEM]: 'ENOMEM', [EFAULT]: 'EFAULT', [EINVAL]: 'EINVAL', [ENOSYS]: 'ENOSYS' }
