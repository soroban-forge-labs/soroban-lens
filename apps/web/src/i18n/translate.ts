/**
 * Pure translation utilities — no React dependency.
 *
 * Split out so they can be imported by Node --test suites without pulling in
 * React context machinery.
 */

import { en, type Catalogue } from './en.js';

/**
 * Look up `key` in `catalogue`, falling back to English, and interpolate any
 * `{placeholder}` tokens in the resulting string.
 *
 * @example
 *   translate(en, 'eventCount', { count: 50, suffix: 's' })  // → "50 events"
 */
export function translate(
  catalogue: Partial<Catalogue>,
  key: keyof Catalogue,
  vars?: Record<string, string | number>,
): string {
  // Prefer the active locale, fall back to English.
  const template = (catalogue[key] ?? en[key]) as string;
  if (!vars) return template;

  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name];
    return value !== undefined ? String(value) : `{${name}}`;
  });
}
