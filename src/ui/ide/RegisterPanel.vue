<script setup lang="ts">
/**
 * Every register in one grid, coloured by what the program has done to it so far: grey = not used,
 * green = read, red = written. Registers the last step wrote stay highlighted until the next step.
 * Clicking a cell opens its details (hex, binary, signed, unsigned, ASCII, float) under the grid; a vector
 * register opens as lanes of a chosen size and format, a matrix register (SME's ZA) as a grid of its tiles.
 */
import { t, tx } from '../i18n'
import { computed, ref } from 'vue'
import { bfloatFromBits, bigOfBytes, binGroupsOf, charOf, doubleFromBits, floatFromBits, halfFromBits, hexBits, javaDouble, javaFloat, signedText, unsignedText } from '../../core/format'
import { READ, WRITTEN, type Machine, type RegisterSpec, type RegValue } from '../../core/isa'
import { isaKey, load, save } from '../storage'
import { laneText, type LaneFormat } from './lanes'
import MatrixGrid from './MatrixGrid.vue'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const s = props.handle.session
const v = props.handle.version
const isa = s.isa

const banks = isa.registers
const bank = ref<string>(load(isaKey(isa.id, 'regBank'), banks[0]!.id))
if (!banks.some((b) => b.id === bank.value)) bank.value = banks[0]!.id
const selected = ref<number | null>(null)
const specs = new Map<number, RegisterSpec>()
for (const b of banks) for (const r of b.registers) specs.set(r.id, r)

/** One value: int, float, flag and special registers. The others are read as bytes. */
const scalar = (r: RegisterSpec) => r.kind === 'int' || r.kind === 'float' || r.kind === 'flag' || r.kind === 'special'

/** A register's value as one number; a vector or predicate register reads as the number its bytes make. */
function valueOf(m: Machine, r: RegisterSpec): RegValue {
  if (!scalar(r) && m.readRegisterBytes) {
    const bytes = m.readRegisterBytes(r.id)
    return bigOfBytes(bytes, 0, bytes.length)
  }
  return m.readRegister(r.id)
}

/** The width a register has on this machine: vector and predicate registers follow the vector length. */
function widthOf(m: Machine | null, r: RegisterSpec): number {
  if (scalar(r) || !m?.readRegisterBytes) return r.bits
  return m.readRegisterBytes(r.id).length * 8 || r.bits
}

/** A cell shows at most 64 bits: wider registers show their low 64 after an ellipsis; the details show all. */
function cellText(r: RegisterSpec, value: RegValue, bits: number): string {
  if (r.kind === 'flag') return String(Number(value) & 1)
  if (bits <= 64) return hexBits(value, bits)
  return '…' + hexBits(BigInt.asUintN(64, BigInt(value)), 64).slice(2)
}

function pickBank(id: string) {
  bank.value = id
  save(isaKey(isa.id, 'regBank'), id)
}

const view = computed(() => {
  void v.value
  const m = s.machine
  const last = s.mode === 'running' ? null : s.last
  const wrote = new Map<number, { before: RegValue; after: RegValue }>()
  for (const w of last?.writes ?? []) wrote.set(w.id, { before: w.before, after: w.after })
  const current = banks.find((b) => b.id === bank.value) ?? banks[0]!
  const cells = current.registers
    .filter((r) => !r.untracked)
    .map((r) => {
      // The SME ZA array is too large for a cell; it opens in the details.
      const matrix = r.kind === 'matrix'
      const value = m && !matrix ? valueOf(m, r) : 0
      const status = m ? m.registerStatus(r.id) : 0
      return {
        spec: r,
        text: matrix ? t('点开查看', 'open to view') : cellText(r, value, widthOf(m, r)),
        cls: status === WRITTEN ? 'w' : status === READ ? 'r' : 'i',
        now: wrote.has(r.id),
      }
    })
  const counts = new Map<string, number>()
  for (const b of banks) {
    let n = 0
    if (m) for (const r of b.registers) if (!r.untracked && m.registerStatus(r.id) === WRITTEN) n++
    counts.set(b.id, n)
  }
  const pcSpec = specs.get(isa.pcRegister)
  return { cells, pc: m ? hexBits(m.readRegister(isa.pcRegister), pcSpec?.bits ?? 32) : '—', counts, wrote }
})

/** How a vector register is split into lanes, and how each lane reads. */
const laneBytes = ref<number>(load(isaKey(isa.id, 'laneBytes'), 4))
const laneFormat = ref<LaneFormat>(load(isaKey(isa.id, 'laneFormat'), 'hex'))
const LANE_SIZES = [
  { bytes: 1, name: 'B' },
  { bytes: 2, name: 'H' },
  { bytes: 4, name: 'S' },
  { bytes: 8, name: 'D' },
  { bytes: 16, name: 'Q' },
]
function setLanes(bytes: number | null, format: typeof laneFormat.value | null) {
  if (bytes != null) laneBytes.value = bytes
  if (format != null) laneFormat.value = format
  save(isaKey(isa.id, 'laneBytes'), laneBytes.value)
  save(isaKey(isa.id, 'laneFormat'), laneFormat.value)
}

const detail = computed(() => {
  void v.value
  const id = selected.value
  if (id == null) return null
  const spec = specs.get(id)
  if (!spec) return null
  const m = s.machine
  const bits = spec.bits
  const w = view.value.wrote.get(id)
  const status = m ? m.registerStatus(id) : 0
  const change = w ? `${hexBits(w.before, widthOf(m, spec))} → ${hexBits(w.after, widthOf(m, spec))}` : null
  if (spec.kind === 'predicate') {
    // One bit per vector byte: an element of the chosen size is active when the bit of its first byte is set.
    const bytes = m?.readRegisterBytes?.(id) ?? new Uint8Array(Math.ceil(bits / 8))
    const size = Math.min(laneBytes.value, bytes.length * 8)
    const bit = (i: number) => (bytes[i >> 3]! >> (i & 7)) & 1
    const lanes = Array.from({ length: Math.floor((bytes.length * 8) / size) }, (_, i) => ({ i, text: String(bit(i * size)) }))
    return { spec, scalar: false, hex: '', groups: [] as string[], top: 0, rows: [], lanes, change, status }
  }
  // A matrix register is drawn by MatrixGrid, as tiles or rows.
  if (spec.kind === 'matrix') return { spec, scalar: false, hex: '', groups: [] as string[], top: 0, rows: [], lanes: [], change: null, status }
  if (!scalar(spec)) {
    // Vector registers: lanes of the chosen size, lowest lane first.
    const bytes = m?.readRegisterBytes?.(id) ?? new Uint8Array(Math.ceil(bits / 8))
    const size = Math.min(laneBytes.value, bytes.length)
    const lanes = Array.from({ length: Math.floor(bytes.length / size) }, (_, i) => ({ i, text: laneText(bytes, i * size, size, laneFormat.value) }))
    return { spec, scalar: false, hex: '', groups: [] as string[], top: 0, rows: [], lanes, change, status }
  }
  const value = m ? valueOf(m, spec) : 0
  const bytes = Array.from({ length: Math.ceil(bits / 8) }, (_, i) => Number((BigInt.asUintN(bits, BigInt(value)) >> BigInt(8 * i)) & 0xffn))
  const rows: { k: string; v: string }[] = [
    { k: t('有符号', 'Signed'), v: signedText(value, bits) },
    { k: t('无符号', 'Unsigned'), v: unsignedText(value, bits) },
    { k: 'ASCII', v: bytes.reverse().map(charOf).join(' ') },
  ]
  if (spec.kind === 'int' && bits === 64) {
    const low = BigInt.asUintN(32, BigInt(value))
    rows.splice(2, 0, { k: t('低 32 位', 'Low 32 bits'), v: `${hexBits(low, 32)} = ${BigInt.asIntN(32, low)}` })
  }
  if (spec.kind === 'float' && bits === 32) {
    const n = Number(value) | 0
    rows.unshift({ k: t('单精度', 'Single'), v: javaFloat(floatFromBits(n)) })
    // MIPS: an even float register and the one after it hold a double.
    const next = specs.get(id + 1)
    if (spec.number != null && spec.number % 2 === 0 && next?.kind === 'float' && m) {
      const high = Number(m.readRegister(id + 1)) | 0
      rows.splice(1, 0, { k: t(`双精度（和 ${next.name}）`, `Double (with ${next.name})`), v: javaDouble(doubleFromBits(n, high)) })
    }
  }
  if (spec.kind === 'float' && bits === 64) {
    const b = BigInt.asUintN(64, BigInt(value))
    rows.unshift({ k: t('双精度', 'Double'), v: javaDouble(doubleFromBits(Number(b & 0xffffffffn) | 0, Number(b >> 32n) | 0)) })
  }
  if (spec.kind === 'float' && bits === 16) {
    rows.unshift({ k: t('半精度', 'Half'), v: String(halfFromBits(Number(value))) }, { k: 'BFloat16', v: javaFloat(bfloatFromBits(Number(value))) })
  }
  return { spec, scalar: true, hex: hexBits(value, bits), groups: binGroupsOf(value, bits), top: Math.ceil(bits / 8) * 8 - 1, rows, lanes: [], change, status }
})

function toggle(id: number) {
  selected.value = selected.value === id ? null : id
}
</script>

<template>
  <section class="card panel regs" :aria-label="t('寄存器', 'Registers')">
    <header class="head">
      <h3>{{ t('寄存器', 'Registers') }}</h3>
      <span class="pc small">pc <b class="mono">{{ view.pc }}</b></span>
      <span class="legend small">
        <i class="dot i" />{{ t('未用', 'unused') }} <i class="dot r" />{{ t('读过', 'read') }} <i class="dot w" />{{ t('改过', 'written') }}
      </span>
    </header>
    <div class="banks" role="tablist" :aria-label="t('寄存器组', 'Register banks')">
      <button v-for="b in banks" :key="b.id" class="chip" role="tab" :aria-pressed="bank === b.id" :aria-selected="bank === b.id" @click="pickBank(b.id)">
        {{ tx(b.title) }}<span v-if="view.counts.get(b.id)" class="cnt">{{ view.counts.get(b.id) }}</span>
      </button>
    </div>
    <div class="grid">
      <button
        v-for="c in view.cells"
        :key="c.spec.id"
        class="cell"
        :class="[c.cls, { now: c.now, sel: selected === c.spec.id }]"
        :title="(c.spec.note ? tx(c.spec.note) : '') + (c.now ? t('（上一步改了它）', ' (changed by the last step)') : '')"
        :aria-pressed="selected === c.spec.id"
        @click="toggle(c.spec.id)"
      >
        <span class="n mono">{{ c.spec.name }}<small v-if="c.spec.number != null && c.spec.kind === 'int'">{{ c.spec.number }}</small></span>
        <span class="val mono">{{ c.text }}</span>
      </button>
    </div>
    <div v-if="detail" class="detail">
      <div class="dh">
        <b class="mono">{{ detail.spec.name }}</b>
        <span class="small muted">{{ detail.spec.note ? tx(detail.spec.note) : '' }}</span>
        <span class="badge" :class="{ err: detail.status === 2 }" :style="detail.status === 1 ? 'background:var(--bg-success);color:var(--success)' : ''">{{
          detail.status === 2 ? t('改过', 'written') : detail.status === 1 ? t('读过', 'read') : t('未用', 'unused')
        }}</span>
        <button class="btn x" @click="selected = null">{{ t('收起', 'Close') }}</button>
      </div>
      <div v-if="detail.scalar" class="hex mono">{{ detail.hex }}</div>
      <div v-if="detail.change" class="small mono changed">{{ t('本步：', 'This step: ') }}{{ detail.change }}</div>
      <div v-if="detail.scalar" class="bits mono">
        <span v-for="(g, i) in detail.groups" :key="i" class="byte">
          <span class="b">{{ g }}</span>
          <small>{{ detail.top - i * 8 }}…{{ detail.top - 7 - i * 8 }}</small>
        </span>
      </div>
      <template v-else>
        <div class="lanectl">
          <span class="small muted">{{ t('按', 'Lanes of') }}</span>
          <button v-for="l in LANE_SIZES" :key="l.bytes" class="chip" :aria-pressed="laneBytes === l.bytes" @click="setLanes(l.bytes, null)">{{ l.name }}</button>
          <template v-if="detail.spec.kind !== 'predicate'">
            <span class="small muted">{{ t('显示为', 'shown as') }}</span>
            <button class="chip" :aria-pressed="laneFormat === 'hex'" @click="setLanes(null, 'hex')">{{ t('十六进制', 'Hex') }}</button>
            <button class="chip" :aria-pressed="laneFormat === 'int'" @click="setLanes(null, 'int')">{{ t('有符号', 'Signed') }}</button>
            <button class="chip" :aria-pressed="laneFormat === 'uint'" @click="setLanes(null, 'uint')">{{ t('无符号', 'Unsigned') }}</button>
            <button class="chip" :aria-pressed="laneFormat === 'float'" @click="setLanes(null, 'float')">{{ t('浮点', 'Float') }}</button>
          </template>
          <span v-else class="small muted">{{ t('每个元素一位：1 = 活跃', 'one bit per element: 1 = active') }}</span>
        </div>
        <MatrixGrid v-if="detail.spec.kind === 'matrix'" :handle="handle" :spec="detail.spec" :size="laneBytes" :format="laneFormat" />
        <div v-else class="lanes mono">
          <span v-for="l in detail.lanes" :key="l.i" class="lane"><small>[{{ l.i }}]</small>{{ l.text }}</span>
        </div>
      </template>
      <dl v-if="detail.scalar" class="rows">
        <template v-for="r in detail.rows" :key="r.k">
          <dt>{{ r.k }}</dt>
          <dd class="mono">{{ r.v }}</dd>
        </template>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
h3 {
  margin: 0;
  font-size: 13.5px;
}
.pc b {
  font-size: 12.5px;
  color: var(--accent);
}
.legend {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
}
.dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 3px;
  margin-left: 6px;
  border: 1px solid var(--border);
}
.dot.i {
  background: var(--surface-2);
}
.dot.r {
  background: var(--bg-success);
  border-color: var(--success);
}
.dot.w {
  background: var(--bg-danger);
  border-color: var(--danger);
}
.banks {
  display: flex;
  gap: 4px;
}
.banks .chip {
  font-family: var(--font-sans);
  display: flex;
  gap: 4px;
  align-items: center;
}
.cnt {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 10px;
  background: var(--bg-danger);
  color: var(--danger);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(98px, 1fr));
  gap: 4px;
}
.cell {
  appearance: none;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: var(--surface-2);
  cursor: pointer;
  min-width: 0;
  color: var(--text-muted);
}
.cell .n {
  font-size: 10.5px;
  display: flex;
  justify-content: space-between;
}
.cell .n small {
  opacity: 0.7;
}
.cell .val {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell.r {
  background: var(--bg-success);
  border-color: color-mix(in srgb, var(--success) 55%, transparent);
  color: var(--text-primary);
}
.cell.r .n {
  color: var(--success);
}
.cell.w {
  background: var(--bg-danger);
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
  color: var(--text-primary);
}
.cell.w .n {
  color: var(--danger);
}
.cell.sel {
  outline: 2px solid var(--accent);
  outline-offset: 0;
}
/* Written by the last step: a steady, stronger red until the next step. */
.cell.now {
  background: color-mix(in srgb, var(--danger) 28%, transparent);
  border-color: var(--danger);
  box-shadow: inset 0 0 0 1px var(--danger);
}
.cell.now .val {
  font-weight: 700;
}
.detail {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dh {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.x {
  margin-left: auto;
  padding: 1px 8px;
  font-size: 11.5px;
}
.hex {
  font-size: 17px;
  font-weight: 600;
}
.changed {
  color: var(--danger);
}
.bits {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}
.byte {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3px 2px;
  border-radius: 5px;
  background: var(--surface-2);
}
.byte .b {
  font-size: 12px;
  letter-spacing: 0.04em;
}
.byte small {
  font-size: 9.5px;
  color: var(--text-muted);
}
.lanectl {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.lanes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 3px;
  font-size: 12px;
  max-height: 260px;
  overflow: auto;
}
.lane {
  display: flex;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--surface-2);
  word-break: break-all;
}
.lane small {
  color: var(--text-muted);
}
.rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 12.5px;
}
.rows dt {
  color: var(--text-muted);
}
.rows dd {
  margin: 0;
  word-break: break-all;
}
</style>
