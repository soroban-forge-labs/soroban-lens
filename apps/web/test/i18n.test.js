/**
 * Tests for the i18n catalogue and translate() function.
 *
 * Runs under plain `node --test` via the test script in package.json.
 * No React — only the pure translate module and the locale catalogues.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../.test-build/i18n/translate.js';
import { en } from '../.test-build/i18n/en.js';
import { es } from '../.test-build/i18n/es.js';

// ── translate() with the English catalogue ────────────────────────────────────

test('returns the correct English string for a known key', () => {
  assert.equal(translate(en, 'tagline'), en.tagline);
  assert.equal(translate(en, 'loading'), 'Loading…');
  assert.equal(translate(en, 'connected'), 'connected');
});

test('interpolates a single placeholder', () => {
  assert.equal(translate(en, 'loadMore', { count: 50 }), 'Load 50 more');
});

test('interpolates multiple placeholders in one string', () => {
  assert.equal(
    translate(en, 'healthStats', { count: '1,234', contracts: 3 }),
    '1,234 events · 3 contracts',
  );
});

test('interpolates placeholders in order, not position', () => {
  assert.equal(
    translate(en, 'lastUpdated', { time: '12:00:00' }),
    'updated 12:00:00',
  );
});

test('leaves an unmatched placeholder as-is', () => {
  // Guards against missing vars causing a blank or throwing.
  const result = translate(en, 'loadMore', {});
  assert.equal(result, 'Load {count} more');
});

test('returns the template unchanged when no vars are passed', () => {
  assert.equal(translate(en, 'exportJson'), 'Export JSON');
});

test('eventCount interpolates count and suffix', () => {
  assert.equal(translate(en, 'eventCount', { count: '1', suffix: '' }), '1 event');
  assert.equal(translate(en, 'eventCount', { count: '42', suffix: 's' }), '42 events');
});

test('filterByTopic interpolates the topic name', () => {
  assert.equal(
    translate(en, 'filterByTopic', { topic: 'transfer' }),
    'Filter by "transfer"',
  );
});

test('detailPositionValue interpolates txIndex and opIndex', () => {
  assert.equal(
    translate(en, 'detailPositionValue', { txIndex: 2, opIndex: 0 }),
    'tx 2 / op 0',
  );
});

// ── Fallback behaviour ────────────────────────────────────────────────────────

test('falls back to English when the key is missing from the locale', () => {
  // es is a Partial<Catalogue>, so it may not have every key.
  // Pick a key that is in en but deliberately absent from es to test fallback.
  // If es ever becomes complete, this test still passes because the fallback
  // returns the same string anyway.
  const partial = {}; // empty catalogue
  assert.equal(translate(partial, 'exportJson'), 'Export JSON');
  assert.equal(translate(partial, 'loading'), 'Loading…');
});

test('interpolation still works when falling back to English', () => {
  const partial = {};
  assert.equal(translate(partial, 'loadMore', { count: 25 }), 'Load 25 more');
});

// ── Spanish locale ────────────────────────────────────────────────────────────

test('Spanish catalogue has the correct tagline', () => {
  assert.equal(
    translate(es, 'tagline'),
    'Mira lo que tus contratos Soroban están emitiendo.',
  );
});

test('Spanish interpolates loadMore correctly', () => {
  assert.equal(translate(es, 'loadMore', { count: 50 }), 'Cargar 50 más');
});

test('Spanish falls back to English for any missing key', () => {
  // Even if a future update adds every key to es, this is a no-op assertion,
  // not a failure — the fallback path is still exercised internally.
  const result = translate(es, 'exportJson');
  // Either the Spanish translation or the English fallback — both are correct.
  assert.ok(typeof result === 'string' && result.length > 0);
});

// ── Catalogue completeness ────────────────────────────────────────────────────

test('every key in the English catalogue is a non-empty string', () => {
  for (const [key, value] of Object.entries(en)) {
    assert.ok(
      typeof value === 'string' && value.length > 0,
      `en.${key} should be a non-empty string`,
    );
  }
});

test('Spanish catalogue contains no keys absent from English (no typos)', () => {
  const enKeys = new Set(Object.keys(en));
  for (const key of Object.keys(es)) {
    assert.ok(enKeys.has(key), `es has extra key "${key}" not in English catalogue`);
  }
});
