/**
 * Two display languages: Chinese and English.
 *
 * Text that is fixed when a module loads (instruction descriptions, register notes) is stored as a
 * Text pair and picked with tx() when shown. Text built while assembling or running (error messages)
 * calls L(zh, en), which reads the current locale. The UI keeps its own reactive copy of the locale and
 * calls setLocale() whenever it changes.
 */
export type Locale = 'zh' | 'en'

export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
]

/** One string in both languages. */
export interface Text {
  zh: string
  en: string
}

let current: Locale = 'zh'

export function getLocale(): Locale {
  return current
}

export function setLocale(locale: Locale): void {
  current = locale
}

export function T(zh: string, en: string): Text {
  return { zh, en }
}

/** The current-language half of a pair, decided now. */
export function L(zh: string, en: string): string {
  return current === 'en' ? en : zh
}

export function tx(text: Text, locale: Locale = current): string {
  return text[locale]
}

/** Concatenate texts (and plain strings shared by both languages) language by language. */
export function cat(...parts: (Text | string)[]): Text {
  return {
    zh: parts.map((p) => (typeof p === 'string' ? p : p.zh)).join(''),
    en: parts.map((p) => (typeof p === 'string' ? p : p.en)).join(''),
  }
}
