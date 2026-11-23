/** The AArch64 machine: running programs, system calls, the C library, exceptions, undo and register status. */
import { describe, expect, it } from 'vitest'
import { IDLE, READ, WRITTEN } from '../../src/core/isa'
import { assemble } from '../../src/isa/arm64/assembler'
import { createMachine } from '../../src/isa/arm64/cpu'
import { FLAG_Z, SP } from '../../src/isa/arm64/registers'
import { ConsoleEnv } from '../helpers'

function machine(src: string, env = new ConsoleEnv()) {
  const r = assemble({ name: 't.s', text: src })
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
  return { m: createMachine(r.program!, env), env, program: r.program! }
}

function run(src: string, stdin = '') {
  const env = new ConsoleEnv(stdin)
  const { m } = machine(src, env)
  m.run(1_000_000, new Set())
  return { m, env, out: env.output, halt: m.halted }
}

describe('programs', () => {
  it('writes with the write system call and exits', () => {
    const { out, halt } = run(`
      .text
      .global _start
_start:
      mov x0, #1
      adr x1, msg
      mov x2, #6
      mov x8, #64
      svc #0
      mov x0, #3
      mov x8, #93
      svc #0
      .data
msg:  .ascii "hello\\n"
`)
    expect(out).toBe('hello\n')
    expect(halt).toEqual({ kind: 'exit', code: 3 })
  })

  it('calls printf from main and returns to exit', () => {
    const { out, halt } = run(`
      .text
      .global main
main:
      stp x29, x30, [sp, #-16]!
      adrp x0, fmt
      add x0, x0, :lo12:fmt
      mov w1, #42
      mov x2, #-5
      adr x3, word
      bl printf
      mov w0, #7
      ldp x29, x30, [sp], #16
      ret
      .section .rodata
fmt:  .asciz "%d|%5ld|%-4s|%04x|%%\\n"
word: .asciz "ab"
`)
    expect(out).toBe('42|   -5|ab  |0000|%\n'.replace('0000', '0000'))
    expect(halt).toEqual({ kind: 'exit', code: 7 })
  })

  it('computes a factorial recursively with a stack frame', () => {
    const { m, halt } = run(`
      .global main
main:
      stp x29, x30, [sp, #-16]!
      mov x0, #10
      bl fact
      ldp x29, x30, [sp], #16
      mov x19, x0
      mov x0, #0
      ret
fact:
      cbz x0, 1f
      stp x0, x30, [sp, #-16]!
      sub x0, x0, #1
      bl fact
      ldp x1, x30, [sp], #16
      mul x0, x0, x1
      ret
1:    mov x0, #1
      ret
`)
    expect(halt).toEqual({ kind: 'exit', code: 0 })
    expect(m.readRegister(19)).toBe(3628800n)
  })

  it('reads numbers with scanf and loads constants from the literal pool', () => {
    const { out } = run(
      `
      .global main
main:
      stp x29, x30, [sp, #-32]!
      ldr x0, =fmt_in
      add x1, sp, #16
      add x2, sp, #20
      bl scanf
      ldr w1, [sp, #16]
      ldr w2, [sp, #20]
      add w1, w1, w2
      ldr x0, =fmt_out
      ldr x2, =0x123456789
      bl printf
      ldp x29, x30, [sp], #32
      mov w0, #0
      ret
      .data
fmt_in:  .asciz "%d %d"
fmt_out: .asciz "%d %lx\\n"
`,
      '40\n2\n',
    )
    expect(out).toBe('42 123456789\n')
  })

  it('allocates with malloc and frees', () => {
    const { m, out } = run(`
      .global main
main:
      stp x29, x30, [sp, #-16]!
      mov x0, #24
      bl malloc
      mov x19, x0
      mov w1, #'A'
      strb w1, [x19]
      strb wzr, [x19, #1]
      mov x0, x19
      bl puts
      mov x0, x19
      bl free
      ldp x29, x30, [sp], #16
      mov w0, #0
      ret
`)
    expect(out).toBe('A\n')
    expect(m.heapBlocks()).toEqual([])
  })

  it('matches glibc rand()', () => {
    const { m } = run(`
      .global main
main:
      stp x29, x30, [sp, #-16]!
      mov w0, #1
      bl srand
      bl rand
      mov x19, x0
      bl rand
      mov x20, x0
      ldp x29, x30, [sp], #16
      ret
`)
    expect(m.readRegister(19)).toBe(1804289383n)
    expect(m.readRegister(20)).toBe(846930886n)
  })
})

describe('faults', () => {
  it('stops with SIGSEGV on a null pointer', () => {
    const { halt } = run('_start:\n mov x0, #0\n ldr x1, [x0]\n')
    expect(halt?.kind).toBe('error')
    expect(halt && halt.kind === 'error' && halt.code).toBe('sigsegv')
  })

  it('stops with SIGSEGV on a write to .rodata', () => {
    const { halt } = run('_start:\n adr x0, s\n strb wzr, [x0]\n .section .rodata\ns: .asciz "x"\n')
    expect(halt && halt.kind === 'error' && halt.code).toBe('sigsegv')
  })

  it('stops with SIGBUS on a misaligned exclusive load', () => {
    const { halt } = run('_start:\n adr x0, v\n add x0, x0, #1\n ldxr x1, [x0]\n .data\nv: .quad 0, 0\n')
    expect(halt && halt.kind === 'error' && halt.code).toBe('sigbus')
  })

  it('stops with SIGILL on udf and SIGTRAP on brk', () => {
    expect(run('_start:\n udf #1\n').halt).toMatchObject({ kind: 'error', code: 'sigill' })
    expect(run('_start:\n brk #3\n').halt).toMatchObject({ kind: 'error', code: 'sigtrap' })
  })

  it('takes exceptions to an EL1 vector table and returns with eret', () => {
    const { m, halt } = run(`
      .text
_start:
      adr x0, v
      add x0, x0, #4
      ldaxr x1, [x0]          // misaligned: an alignment fault
      mov x2, #99
      mov x0, #0
      mov x8, #93
      svc #0
      .data
v:    .quad 0, 0

      .section .ktext, "ax"
      .balign 2048
vectors:
      .skip 0x400
      mrs x10, esr_el1
      mrs x11, far_el1
      mrs x12, elr_el1
      add x12, x12, #4
      msr elr_el1, x12
      eret
`)
    expect(halt).toEqual({ kind: 'exit', code: 0 })
    expect(Number(m.readRegister(10)) >>> 26).toBe(0x24)
    expect(m.readRegister(2)).toBe(99n)
  })
})

describe('undo and status', () => {
  it('restores registers, flags, memory and the PC', () => {
    const { m } = machine('_start:\n adr x0, v\n mov x1, #5\n subs x2, x1, #5\n str x1, [x0]\n nop\n .data\nv: .quad 9\n')
    for (let i = 0; i < 4; i++) m.step()
    expect(m.readRegister(FLAG_Z)).toBe(1)
    const addr = 0x401000
    expect(m.readWord(addr)).toBe(5)
    m.undo()
    expect(m.readWord(addr)).toBe(9)
    m.undo()
    expect(m.readRegister(FLAG_Z)).toBe(0)
    expect(m.readRegister(2)).toBe(0n)
    expect(m.registerStatus(2)).toBe(IDLE)
  })

  it('colours registers read and written', () => {
    const { m } = machine('_start:\n mov x1, #5\n add x2, x1, x3\n sub sp, sp, #16\n')
    m.step()
    m.step()
    expect(m.registerStatus(1)).toBe(WRITTEN)
    expect(m.registerStatus(3)).toBe(READ)
    expect(m.registerStatus(2)).toBe(WRITTEN)
    m.step()
    expect(m.registerStatus(SP)).toBe(WRITTEN)
  })

  it('waits for input and completes the call once it arrives', () => {
    const env = new ConsoleEnv()
    env.readLine = () => null
    const { m } = machine('main:\n stp x29, x30, [sp, #-16]!\n bl getchar\n ldp x29, x30, [sp], #16\n ret\n', env)
    m.step()
    m.step()
    expect(m.state).toBe('waiting')
    m.resolve('xyz')
    m.step()
    expect(m.readRegister(0)).toBe(BigInt('x'.charCodeAt(0)))
  })
})
