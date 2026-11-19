/**
 * The UI language: a reactive copy of the core locale, saved per viewer; before they choose, the system language if supported, else English. Components call t(zh, en) for
 * their own words and tx(text) for engine data; both read `lang`, so a switch re-renders them.
 */
import { ref, watch } from 'vue'
import { setLocale, type Locale, type Text } from '../core/i18n'
import { load, save } from './storage'

function initial(): Locale {
  const saved = load<Locale | null>('lang', null)
  if (saved === 'zh' || saved === 'en') return saved
  // The system language when we have it, English otherwise.
  const wanted = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const tag of wanted) {
    if (/^zh\b/i.test(tag)) return 'zh'
    if (/^en\b/i.test(tag)) return 'en'
  }
  return 'en'
}

export const lang = ref<Locale>(initial())

function apply(l: Locale) {
  setLocale(l)
  if (typeof document !== 'undefined') document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
}
apply(lang.value)

// Synchronous, so engine text produced in the same tick already uses the new language.
watch(
  lang,
  (l) => {
    apply(l)
    save('lang', l)
  },
  { flush: 'sync' },
)

export function t(zh: string, en: string): string {
  return lang.value === 'en' ? en : zh
}

export function tx(text: Text): string {
  return text[lang.value]
}
