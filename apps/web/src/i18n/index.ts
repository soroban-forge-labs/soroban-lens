/**
 * Minimal i18n core.
 *
 * Design goals:
 *  - Zero dependencies — no external i18n library.
 *  - t(key, vars?) — look up a string, interpolate {var} placeholders.
 *  - useLocale() — React hook that returns { t, locale, setLocale }.
 *  - Locale is persisted in localStorage and picked up on page load.
 *  - Unknown keys fall back to English, so an incomplete translation never
 *    shows a bare key to the user.
 *
 * Pure utilities live in ./translate.ts so they can be tested under plain
 * Node without importing React.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { Catalogue } from './en.js';
import { en } from './en.js';
import { es } from './es.js';
export { translate } from './translate.js';

// ── Supported locales ──────────────────────────────────────────────────────────

export type LocaleCode = 'en' | 'es';

const LOCALES: Record<LocaleCode, Partial<Catalogue>> = { en, es };

export const LOCALE_LABELS: Record<LocaleCode, string> = {
  en: 'English',
  es: 'Español',
};

export const LOCALE_CODES = Object.keys(LOCALES) as LocaleCode[];

const STORAGE_KEY = 'lens.locale';
const DEFAULT_LOCALE: LocaleCode = 'en';

function isLocaleCode(value: string): value is LocaleCode {
  return value in LOCALES;
}

function loadStoredLocale(): LocaleCode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) ?? '';
    return isLocaleCode(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

// ── Core translation function (re-exported from translate.ts) ────────────────
// `translate` is exported via the re-export above. Components that are class-
// based (ErrorBoundary) import it from here or from './translate.js' directly.

// ── React context ──────────────────────────────────────────────────────────────

/** The value exposed by LocaleProvider and consumed by useLocale(). */
export interface LocaleContextValue {
  /** Bounded translate: calls translate() with the active catalogue. */
  t: (key: keyof Catalogue, vars?: Record<string, string | number>) => string;
  locale: LocaleCode;
  setLocale: (code: LocaleCode) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

interface LocaleProviderProps {
  children: ReactNode;
}

/** Wrap the application in this once (in App.tsx). */
export function LocaleProvider({ children }: LocaleProviderProps): React.JSX.Element {
  const [locale, setLocaleState] = useState<LocaleCode>(loadStoredLocale);

  const setLocale = useCallback((code: LocaleCode) => {
    setLocaleState(code);
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // localStorage may be unavailable in some environments (e.g. incognito
      // with storage blocked) — the selection still works for the current session.
    }
  }, []);

  // Sync the <html lang> attribute with the active locale for accessibility.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const catalogue = LOCALES[locale];

  const t = useCallback(
    (key: keyof Catalogue, vars?: Record<string, string | number>) => {
      // Inline the interpolation rather than calling translate() to avoid
      // importing from translate.ts at runtime (tree-shaking boundary).
      const template = (catalogue[key] ?? en[key]) as string;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => {
        const value = vars[name];
        return value !== undefined ? String(value) : `{${name}}`;
      });
    },
    [catalogue],
  );

  const value: LocaleContextValue = { t, locale, setLocale };

  return createElement(LocaleContext.Provider, { value }, children);
}

/**
 * Returns `{ t, locale, setLocale }` for the current locale.
 *
 * Must be used inside a <LocaleProvider>.
 */
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useLocale() must be used inside <LocaleProvider>');
  }
  return ctx;
}
