/**
 * Vue glue for core/session.ts: one Session per IDE, a version counter that bumps on every change
 * (components read it inside computed() to re-render), persistence of the editor state, and sound.
 */
import { markRaw, onBeforeUnmount, shallowRef, type ShallowRef } from 'vue'
import type { IsaPlugin } from '../../core/isa'
import { Session, type Granularity } from '../../core/session'
import { load, save } from '../storage'
import { flushSections, translateComments } from '../../core/source'
import { lang, tx } from '../i18n'

export interface SessionHandle {
  session: Session
  /** Bumped after every session change. */
  version: ShallowRef<number>
  /** True while a slow action (loading code, assembling) is running; the toolbar shows a spinner. */
  busy: ShallowRef<boolean>
  /** Show the spinner, let the page paint, then run `work`. */
  busyWhile(work: () => void): Promise<void>
  /** A run control: when it has to assemble first it goes through busyWhile, otherwise it runs at once. */
  control(action: () => void): void
}

/** Resolves once the browser has painted the current state (or after 50 ms, as hidden tabs skip frames). */
const painted = () =>
  new Promise<void>((resolve) => {
    let done = false
    const go = () => {
      if (done) return
      done = true
      setTimeout(resolve, 0)
    }
    requestAnimationFrame(go)
    setTimeout(go, 50)
  })

interface Saved {
  name: string
  text: string
  breakpoints: number[]
}

let audio: AudioContext | null = null

/** Syscalls 31/33: a short tone, roughly by instrument family. */
function playNote(pitch: number, durationMs: number, instrument: number, volume: number): void {
  try {
    audio ??= new AudioContext()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    const family = Math.floor((instrument & 127) / 8)
    osc.type = family === 0 ? 'triangle' : family === 10 || family === 11 ? 'sawtooth' : family === 9 ? 'square' : 'sine'
    osc.frequency.value = 440 * Math.pow(2, ((pitch & 127) - 69) / 12)
    const t = audio.currentTime
    const v = Math.max(0, Math.min(127, volume)) / 127 * 0.25
    gain.gain.setValueAtTime(v, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, durationMs / 1000))
    osc.connect(gain).connect(audio.destination)
    osc.start(t)
    osc.stop(t + Math.max(0.05, durationMs / 1000) + 0.05)
  } catch {
    /* no audio available */
  }
}

export function useSession(isa: IsaPlugin): SessionHandle {
  const key = `ide.${isa.id}`
  const fallback = isa.examples[0]
  const saved = load<Saved | null>(key, null)
  // Saved code keeps section directives in the first column, and lines from an example follow the language.
  const savedText = saved ? translateComments(flushSections(saved.text, isa.language.sections), isa.examples, lang.value, isa.language.commentChar) : ''
  const session = markRaw(
    new Session(isa, saved ? { name: saved.name, text: savedText } : { name: `${fallback?.id ?? 'program'}.asm`, text: fallback ? tx(fallback.text) : '' }, {
      playNote,
    }),
  )
  if (saved?.breakpoints?.length) session.setBreakpoints(saved.breakpoints)
  session.interval = load<number>('interval', 500)
  session.granularity = load<Granularity>('stepBy', 'line')

  const version = shallowRef(0)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const persist = () => {
    save(key, { name: session.file.name, text: session.file.text, breakpoints: [...session.breakpoints] })
    save('interval', session.interval)
    save('stepBy', session.granularity)
  }
  const off = session.subscribe(() => {
    version.value++
    if (saveTimer == null) {
      saveTimer = setTimeout(() => {
        saveTimer = null
        persist()
      }, 400)
    }
  })
  session.assemble()

  onBeforeUnmount(() => {
    off()
    if (saveTimer != null) clearTimeout(saveTimer)
    persist()
    session.dispose()
  })
  const busy = shallowRef(false)
  const busyWhile = async (work: () => void) => {
    busy.value = true
    try {
      await painted()
      work()
    } finally {
      busy.value = false
    }
  }
  const control = (action: () => void) => {
    if (busy.value) return
    if (session.stale || !session.machine) void busyWhile(action)
    else action()
  }

  return { session, version, busy, busyWhile, control }
}
