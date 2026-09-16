import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, formatRecord, resolveLogFormat } from '../dist/index.js';

test('resolveLogFormat reads LENS_LOG_FORMAT=json, defaults to text', () => {
  assert.equal(resolveLogFormat({}), 'text');
  assert.equal(resolveLogFormat({ LENS_LOG_FORMAT: 'json' }), 'json');
  assert.equal(resolveLogFormat({ LENS_LOG_FORMAT: 'anything-else' }), 'text');
});

test('text mode renders the message with no envelope, matching a hand-written log line', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const line = formatRecord({ level: 'info', event: 'batch_indexed', message: 'indexed 5 events' }, 'text', now);
  assert.equal(line, 'indexed 5 events');
});

test('text mode appends fields not already folded into the message', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const line = formatRecord(
    { level: 'info', event: 'batch_indexed', message: 'indexed 5 events', fields: { ledger: 100, cursor: 'abc' } },
    'text',
    now,
  );
  assert.equal(line, 'indexed 5 events (ledger=100 cursor=abc)');
});

test('text mode applies a prefix when configured', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const line = formatRecord({ level: 'info', event: 'x', message: 'hello' }, 'text', now, '[api]');
  assert.equal(line, '[api] hello');
});

test('json mode emits one JSON object per line with the full record', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const line = formatRecord(
    { level: 'warn', event: 'retry', message: 'retrying', fields: { attempt: 2 } },
    'json',
    now,
  );
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.event, 'retry');
  assert.equal(parsed.message, 'retrying');
  assert.equal(parsed.attempt, 2);
  assert.equal(parsed.time, '2026-09-16T12:00:00.000Z');
});

test('createLogger routes level, event and fields to the sink', () => {
  const lines = [];
  const logger = createLogger({ format: 'json', write: (l) => lines.push(l), now: () => new Date('2026-01-01T00:00:00Z') });
  logger.info('started', 'server started', { port: 8080 });
  logger.error('crashed', 'oh no');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).port, 8080);
  assert.equal(JSON.parse(lines[1]).level, 'error');
});

test('createLogger defaults to stderr and text format when nothing is configured', () => {
  // Just confirms construction does not throw and returns a full Logger shape —
  // the actual write target (process.stderr) is not asserted against, since
  // capturing it would mean monkey-patching a global stream.
  const logger = createLogger();
  assert.equal(typeof logger.info, 'function');
  assert.equal(typeof logger.debug, 'function');
  assert.equal(typeof logger.warn, 'function');
  assert.equal(typeof logger.error, 'function');
});
