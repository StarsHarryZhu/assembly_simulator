/** Throughput of the AArch64 machine on a tight integer loop with loads and stores. */
import { expect, it } from 'vitest'
import { assemble } from '../../src/isa/arm64/assembler'
import { createMachine } from '../../src/isa/arm64/cpu'
import { ConsoleEnv } from '../helpers'

const LOOP = `
_start:
    adr     x1, buf
    ldr     x0, =200000
1:
    ldr     x2, [x1]
    add     x2, x2, x0
    eor     x3, x2, x0, lsl #3
    str     x3, [x1, #8]
    subs    x0, x0, #1
    b.ne    1b
    mov     x8, #93
    svc     #0
    .data
buf: .quad 0, 0
`

it('runs at least 2 million instructions per second', () => {
  const r = assemble({ name: 's.s', text: LOOP })
  // The best of three runs: the first warms up the JIT, and the others may share the CPU with other test files.
  let best = 0
  for (let i = 0; i < 3; i++) {
    const m = createMachine(r.program!, new ConsoleEnv())
    const t0 = performance.now()
    m.run(10_000_000, new Set())
    const seconds = (performance.now() - t0) / 1000
    expect(m.halted).toEqual({ kind: 'exit', code: 0 })
    best = Math.max(best, m.steps / seconds)
  }
  console.log(`${(best / 1e6).toFixed(2)} M instructions/s`)
  expect(best).toBeGreaterThan(2e6)
})
