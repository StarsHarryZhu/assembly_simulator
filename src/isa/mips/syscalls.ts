/**
 * The 39 MARS 4.5 system calls ($v0 = 1..17, 30..36, 40..44, 50..59).
 * Console and file I/O go through the Environment; numbers print the way Java prints them, as in MARS.
 */
import { L } from '../../core/i18n'
import { javaDouble, javaFloat } from '../../core/format'
import type { MipsMachine } from './cpu'
import { A0, A1, A2, A3, V0 } from './registers'

/** java.util.Random, so seeded streams (syscall 40) give the same numbers as MARS. */
export class JavaRandom {
  private seed: bigint
  private static readonly MULT = 0x5deece66dn
  private static readonly MASK = (1n << 48n) - 1n

  constructor(seed: number | bigint) {
    this.seed = (BigInt.asIntN(64, BigInt(seed)) ^ JavaRandom.MULT) & JavaRandom.MASK
  }

  private next(bits: number): number {
    this.seed = (this.seed * JavaRandom.MULT + 0xbn) & JavaRandom.MASK
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)))
  }

  nextInt(bound?: number): number {
    if (bound == null) return this.next(32)
    if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n)
    let bits: number
    let val: number
    do {
      bits = this.next(31)
      val = bits % bound
    } while (bits - val + (bound - 1) < 0 || bits - val + (bound - 1) > 2147483647)
    return val
  }

  nextFloat(): number {
    return this.next(24) / (1 << 24)
  }

  nextDouble(): number {
    return (this.next(26) * 134217728 + this.next(27)) * 2 ** -53
  }
}

const utf8 = new TextDecoder('utf-8')
const encoder = new TextEncoder()

/** Java Integer.parseInt: optional sign, decimal digits, int range. */
function parseJavaInt(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null
  const v = Number(s)
  return v >= -2147483648 && v <= 2147483647 ? v : null
}

/** Java Float/Double.parseFloat: decimal or exponent forms, NaN, Infinity, optional f/d suffix. */
function parseJavaReal(s: string): number | null {
  const t = s.trim()
  if (/^[+-]?(NaN|Infinity)$/.test(t)) return Number(t)
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(t)) return null
  return Number(t.replace(/[fFdD]$/, ''))
}

function hex8(v: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(8, '0')
}

export function runSyscall(m: MipsMachine): void {
  const service = m.g(V0)
  switch (service) {
    case 1:
      m.out(String(m.g(A0)))
      return
    case 2:
      m.out(javaFloat(m.single(12)))
      return
    case 3:
      m.out(javaDouble(m.double(12)))
      return
    case 4:
      m.out(utf8.decode(m.loadCString(m.g(A0))))
      return
    case 5: {
      const s = m.input({ kind: 'line', purpose: 'int' })
      const v = parseJavaInt(s.trim())
      if (v == null) m.fault(L('输入的不是整数（syscall 5 读取整数）', 'Invalid integer input (syscall 5 read integer)'), 'input-int')
      m.sg(V0, v)
      return
    }
    case 6: {
      const v = parseJavaReal(m.input({ kind: 'line', purpose: 'float' }))
      if (v == null) m.fault(L('输入的不是浮点数（syscall 6 读取单精度）', 'Invalid float input (syscall 6 read float)'), 'input-float')
      m.setSingle(0, Math.fround(v))
      return
    }
    case 7: {
      const v = parseJavaReal(m.input({ kind: 'line', purpose: 'double' }))
      if (v == null) m.fault(L('输入的不是浮点数（syscall 7 读取双精度）', 'Invalid double input (syscall 7 read double)'), 'input-double')
      m.setDouble(0, v)
      return
    }
    case 8: {
      const buf = m.g(A0)
      let max = m.g(A1) - 1
      let nul = true
      if (max < 0) {
        max = 0
        nul = false
      }
      const line = m.input({ kind: 'line', purpose: 'string', maxLength: max })
      const bytes = encoder.encode(line + '\n').slice(0, max)
      m.storeBytes(buf, bytes)
      if (nul) m.storeByte(buf + bytes.length, 0)
      return
    }
    case 9:
      m.sg(V0, m.sbrk(m.g(A0)))
      return
    case 10:
      m.exit(null)
      return
    case 11:
      m.out(String.fromCharCode(m.g(A0) & 0xff))
      return
    case 12: {
      const c = m.inputChar()
      if (c < 0) m.fault(L('没有读到字符（syscall 12 读取字符）', 'No character to read (syscall 12 read character)'), 'input-char')
      m.sg(V0, c & 0xff)
      return
    }
    case 13:
      m.sg(V0, openFile(m, utf8.decode(m.loadCString(m.g(A0))), m.g(A1)))
      return
    case 14:
      m.sg(V0, readFile(m, m.g(A0), m.g(A1), m.g(A2)))
      return
    case 15:
      m.sg(V0, writeFile(m, m.g(A0), m.g(A1), m.g(A2)))
      return
    case 16:
      closeFile(m, m.g(A0))
      return
    case 17:
      m.exit(m.g(A0))
      return
    case 30: {
      const ms = BigInt(Math.floor(m.env.now()))
      m.sg(A0, Number(BigInt.asIntN(32, ms)))
      m.sg(A1, Number(BigInt.asIntN(32, ms >> 32n)))
      return
    }
    case 31:
    case 33: {
      const pitch = m.g(A0)
      const duration = m.g(A1)
      const instrument = m.g(A2)
      const volume = m.g(A3)
      m.env.playNote?.(clamp(pitch, 0, 127, 60), duration < 0 ? 1000 : duration, clamp(instrument, 0, 127, 0), clamp(volume, 0, 127, 100))
      if (service === 33) m.sleep(Math.max(0, duration))
      return
    }
    case 32:
      m.sleep(Math.max(0, m.g(A0)))
      return
    case 34:
      m.out(hex8(m.g(A0)))
      return
    case 35:
      m.out((m.g(A0) >>> 0).toString(2).padStart(32, '0'))
      return
    case 36:
      m.out(String(m.g(A0) >>> 0))
      return
    case 40:
      m.randoms.set(m.g(A0), new JavaRandom(m.g(A1)))
      return
    case 41:
      m.sg(A0, stream(m, m.g(A0)).nextInt())
      return
    case 42: {
      const id = m.g(A0)
      const bound = m.g(A1)
      if (bound <= 0) m.fault(L('随机数上限必须是正数（syscall 42）', 'The upper bound of the random range must be positive (syscall 42)'), 'random-bound')
      m.sg(A0, stream(m, id).nextInt(bound))
      return
    }
    case 43:
      m.setSingle(0, Math.fround(stream(m, m.g(A0)).nextFloat()))
      return
    case 44:
      m.setDouble(0, stream(m, m.g(A0)).nextDouble())
      return
    case 50: {
      const r = m.dialog({ type: 'confirm', message: str(m, m.g(A0)) })
      m.sg(A0, r.type === 'confirm' ? (r.choice === 'yes' ? 0 : r.choice === 'no' ? 1 : 2) : 2)
      return
    }
    case 51:
    case 52:
    case 53: {
      const purpose = service === 51 ? 'int' : service === 52 ? 'float' : 'double'
      const r = m.dialog({ type: 'input', message: str(m, m.g(A0)), purpose })
      const text = r.type === 'input' ? r.text : null
      let status = 0
      let value = 0
      if (text == null) status = -2
      else if (text.trim() === '') status = -3
      else {
        const v = purpose === 'int' ? parseJavaInt(text.trim()) : parseJavaReal(text)
        if (v == null) status = -1
        else value = v
      }
      if (purpose === 'int') {
        if (status === 0) m.sg(A0, value)
      } else if (status === 0) {
        if (purpose === 'float') m.setSingle(0, Math.fround(value))
        else m.setDouble(0, value)
      }
      m.sg(A1, status)
      return
    }
    case 54: {
      const buf = m.g(A1)
      const max = m.g(A2)
      const r = m.dialog({ type: 'input', message: str(m, m.g(A0)), purpose: 'string', maxLength: max })
      const text = r.type === 'input' ? r.text : null
      if (text == null) m.sg(A1, -2)
      else if (text === '') m.sg(A1, -3)
      else {
        const bytes = encoder.encode(text)
        const room = Math.max(0, max - 1)
        const keep = bytes.slice(0, room)
        m.storeBytes(buf, keep)
        m.storeByte(buf + keep.length, 0)
        m.sg(A1, bytes.length > room ? -4 : 0)
      }
      return
    }
    case 55: {
      const t = m.g(A1)
      const level = t === 0 ? 'error' : t === 1 ? 'info' : t === 2 ? 'warning' : t === 3 ? 'question' : 'plain'
      m.dialog({ type: 'message', message: str(m, m.g(A0)), level })
      return
    }
    case 56:
      m.dialog({ type: 'message', message: str(m, m.g(A0)) + String(m.g(A1)), level: 'info' })
      return
    case 57:
      m.dialog({ type: 'message', message: str(m, m.g(A0)) + javaFloat(m.single(12)), level: 'info' })
      return
    case 58:
      m.dialog({ type: 'message', message: str(m, m.g(A0)) + javaDouble(m.double(12)), level: 'info' })
      return
    case 59:
      m.dialog({ type: 'message', message: str(m, m.g(A0)) + str(m, m.g(A1)), level: 'info' })
      return
    default:
      m.fault(L(`没有编号为 ${service} 的系统调用（$v0 = ${service}）`, `Invalid or unimplemented syscall ${service} ($v0 = ${service})`), 'syscall-invalid')
  }
}

function clamp(v: number, lo: number, hi: number, fallback: number): number {
  return v < lo || v > hi ? fallback : v
}

function str(m: MipsMachine, addr: number): string {
  return utf8.decode(m.loadCString(addr))
}

function stream(m: MipsMachine, id: number): JavaRandom {
  let r = m.randoms.get(id)
  if (!r) {
    r = new JavaRandom(Math.floor(m.env.now() * 1000) ^ (id * 0x9e3779b9))
    m.randoms.set(id, r)
  }
  return r
}

/* ---------------------------------------------------------------- files */

function openFile(m: MipsMachine, name: string, flags: number): number {
  const write = flags === 1 || flags === 9
  if (flags !== 0 && !write) return -1
  let data: Uint8Array
  let length = 0
  if (write) {
    const existing = flags === 9 ? m.env.files.read(name) : null
    data = new Uint8Array(Math.max(64, existing?.length ?? 0))
    if (existing) {
      data.set(existing)
      length = existing.length
    }
    m.env.files.write(name, data.subarray(0, length), false)
  } else {
    const existing = m.env.files.read(name)
    if (!existing) return -1
    data = existing
    length = existing.length
  }
  let fd = 3
  while (m.openFiles.has(fd)) fd++
  m.openFiles.set(fd, { name, data, length, pos: write ? length : 0, write })
  return fd
}

function readFile(m: MipsMachine, fd: number, buf: number, len: number): number {
  if (fd === 0) {
    const line = m.input({ kind: 'line', purpose: 'string', maxLength: len })
    const bytes = encoder.encode(line + '\n').slice(0, Math.max(0, len))
    m.storeBytes(buf, bytes)
    return bytes.length
  }
  const f = m.openFiles.get(fd)
  if (!f || f.write || len < 0) return -1
  const n = Math.min(len, f.length - f.pos)
  m.storeBytes(buf, f.data.subarray(f.pos, f.pos + n))
  f.pos += n
  return n
}

function writeFile(m: MipsMachine, fd: number, buf: number, len: number): number {
  if (len < 0) return -1
  const bytes: number[] = []
  for (let i = 0; i < len; i++) bytes.push(m.loadByte(buf + i, false))
  if (fd === 1 || fd === 2) {
    m.out(utf8.decode(Uint8Array.from(bytes)))
    return len
  }
  const f = m.openFiles.get(fd)
  if (!f || !f.write) return -1
  if (f.length + len > f.data.length) {
    const grown = new Uint8Array(Math.max(f.data.length * 2, f.length + len))
    grown.set(f.data.subarray(0, f.length))
    f.data = grown
  }
  f.data.set(bytes, f.length)
  f.length += len
  m.env.files.write(f.name, f.data.subarray(0, f.length), false)
  return len
}

function closeFile(m: MipsMachine, fd: number): void {
  const f = m.openFiles.get(fd)
  if (!f) return
  if (f.write) m.env.files.write(f.name, f.data.slice(0, f.length), false)
  m.openFiles.delete(fd)
}
