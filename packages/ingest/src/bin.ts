#!/usr/bin/env node
/**
 * `soroban-lens-ingest` — Module 1's standalone deliverable.
 *
 * Given a contract id and an RPC URL, streams raw events to stdout as NDJSON
 * (one JSON object per line), which pipes cleanly into jq or into Module 2.
 */
import { parseArgs } from 'node:util';
import { LensRpcClient } from './rpc-client.js';
import { EventPoller } from './poller.js';
import { FileCursorStore, MemoryCursorStore } from './cursor.js';
import { resolveNetwork, NETWORKS } from './networks.js';
import type { EventType } from './types.js';
import { IngestMetrics } from './metrics.js';
import { startMetricsServer, closeMetricsServer, parseMetricsPort } from './metrics-server.js';

const EVENT_TYPES: EventType[] = ['contract', 'system', 'diagnostic'];

function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as string[]).includes(value);
}

/** The RPC matches a prefix of at most 4 topic segments. */
const MAX_TOPIC_SEGMENTS = 4;

/**
 * Repeated `--topic` flags form one positional prefix filter, so the flag order
 * is the topic order. `*` is the wildcard the RPC understands for a position.
 */
function parseTopicFlags(flags: string[] | undefined): string[][] | undefined {
  if (!flags || flags.length === 0) return undefined;
  if (flags.length > MAX_TOPIC_SEGMENTS) {
    throw new Error(
      `at most ${MAX_TOPIC_SEGMENTS} --topic segments are supported, got ${flags.length}. ` +
        'The RPC matches a prefix of at most 4 segments; events may carry more, ' +
        'so filter on the prefix and narrow afterwards.',
    );
  }
  return [flags];
}

/** Parse repeated `--rpc-header 'Name: value'` flags and LENS_RPC_HEADERS. */
function parseHeaders(flags: string[] | undefined, env: string | undefined): Record<string, string> {
  const raw = [...(env ? env.split(',') : []), ...(flags ?? [])];
  const headers: Record<string, string> = {};
  for (const entry of raw) {
    const text = entry.trim();
    if (text === '') continue;
    const split = text.indexOf(':');
    if (split <= 0) {
      // Never echo the entry itself — it is most likely a bare API key.
      throw new Error("--rpc-header expects 'Name: value'");
    }
    const name = text.slice(0, split).trim();
    const value = text.slice(split + 1).trim();
    if (name === '' || value === '') throw new Error("--rpc-header expects 'Name: value'");
    headers[name] = value;
  }
  return headers;
}

/** Header names only. Values authenticate to a paid provider. */
function redactHeaders(headers: Record<string, string>): string {
  return Object.keys(headers)
    .map((name) => `${name}: <redacted>`)
    .join(', ');
}

/** A CLI/env number, dropped rather than passed through as NaN. */
function numeric<K extends string>(key: K, raw: string | undefined): Partial<Record<K, number>> {
  if (raw === undefined || raw.trim() === '') return {};
  const value = Number(raw);
  return Number.isFinite(value) ? ({ [key]: value } as Record<K, number>) : {};
}

/** Validate CLI numbers before they can be passed to the poller or RPC client. */
function parseNumericFlag(flag: string, raw: string | undefined, min: number, max = Infinity): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`error: ${flag} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

const USAGE = `
soroban-lens-ingest — stream Soroban contract events as NDJSON

Usage:
  soroban-lens-ingest --contract <C...> [options]

Options:
  -c, --contract <id>      Contract id to watch. Repeatable (max 5 per RPC filter).
  -n, --network <name>     ${Object.keys(NETWORKS).join(' | ')}  (default: testnet)
  -r, --rpc-url <url>      Override the network's RPC URL.
      --start-ledger <n>   First ledger to read when no cursor is stored.
      --page-size <n>      Events per RPC page, 1-10000 (default: 200).
      --poll-interval <ms> Wait after catching up to the tip (default: 2000).
      --poll-max-interval <ms> Maximum idle wait after repeated empty polls (default: 30000).
      --stalled-threshold <ms> Warn if the RPC tip does not advance (default: 60000).
      --end-ledger <n>     Last ledger to read. Exits cleanly once passed.
      --type <kind>        contract | system | diagnostic (default: contract).
      --topic <seg>        Server-side topic filter segment: a base64 ScVal, or
                           '*' to match any value in that position. Repeatable,
                           positional, at most 4 — the RPC matches a prefix of
                           at most 4 segments, though events may carry more.
      --rpc-header <h>     'Name: value' header for the RPC. Repeatable.
                           Values are redacted in all output.
      --retry-attempts <n> Total RPC attempts including the first (default: 5).
      --retry-base-delay <ms>  First retry delay (default: 250).
      --retry-max-delay <ms>   Ceiling on any one retry delay (default: 30000).
      --cursor-dir <path>  Where to persist resume state (default: ./data).
      --no-resume          Ignore and do not write any stored cursor.
      --once               Exit once caught up to the current tip.
      --max-events <n>     Exit after emitting this many events.
      --metrics-port <n>   Enable /metrics (typically 9090; disabled by default).
      --metrics-host <ip>  Bind address (default: 127.0.0.1).
  -h, --help               Show this help.

Environment:
  LENS_NETWORK, LENS_RPC_URL, LENS_CONTRACT_IDS (comma separated), LENS_DATA_DIR
  LENS_POLL_INTERVAL_MS, LENS_POLL_MAX_INTERVAL_MS
  LENS_RPC_HEADERS (comma separated 'Name: value' pairs)
  LENS_RETRY_ATTEMPTS, LENS_RETRY_BASE_DELAY_MS, LENS_RETRY_MAX_DELAY_MS
  LENS_STALLED_THRESHOLD_MS
  LENS_METRICS_PORT, LENS_METRICS_HOST

Examples:
  # Testnet native XLM contract, 20 events, then exit
  soroban-lens-ingest -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \\
    --max-events 20 --no-resume | jq -c '{ledger, id, txHash}'
`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      contract: { type: 'string', short: 'c', multiple: true },
      network: { type: 'string', short: 'n' },
      'rpc-url': { type: 'string', short: 'r' },
      'start-ledger': { type: 'string' },
      'page-size': { type: 'string' },
      'poll-interval': { type: 'string' },
      'poll-max-interval': { type: 'string' },
      'stalled-threshold': { type: 'string' },
      'end-ledger': { type: 'string' },
      type: { type: 'string' },
      topic: { type: 'string', multiple: true },
      'rpc-header': { type: 'string', multiple: true },
      'retry-attempts': { type: 'string' },
      'retry-base-delay': { type: 'string' },
      'retry-max-delay': { type: 'string' },
      'cursor-dir': { type: 'string' },
      'no-resume': { type: 'boolean' },
      once: { type: 'boolean' },
      'max-events': { type: 'string' },
      'metrics-port': { type: 'string' },
      'metrics-host': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const contractIds =
    values.contract ??
    (process.env.LENS_CONTRACT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  if (contractIds.length === 0) {
    process.stderr.write('error: at least one --contract is required\n');
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  let startLedger: number | undefined;
  let endLedger: number | undefined;
  let pageSize: number | undefined;
  let pollInterval: number | undefined;
  let maxEvents: number | undefined;
  try {
    startLedger = parseNumericFlag('--start-ledger', values['start-ledger'], 1);
    endLedger = parseNumericFlag('--end-ledger', values['end-ledger'], 1);
    pageSize = parseNumericFlag('--page-size', values['page-size'], 1, 10_000);
    pollInterval = parseNumericFlag('--poll-interval', values['poll-interval'], 0);
    maxEvents = parseNumericFlag('--max-events', values['max-events'], 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const network = resolveNetwork(
    values.network ?? process.env.LENS_NETWORK ?? 'testnet',
    values['rpc-url'] ?? process.env.LENS_RPC_URL,
  );

  let eventType: EventType = 'contract';
  if (values.type !== undefined) {
    if (!isEventType(values.type)) {
      process.stderr.write(
        `error: --type must be contract, system or diagnostic, got "${values.type}"\n`,
      );
      return 2;
    }
    eventType = values.type;
  }

  let topics: string[][] | undefined;
  try {
    topics = parseTopicFlags(values.topic);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let headers: Record<string, string>;
  try {
    headers = parseHeaders(values['rpc-header'], process.env.LENS_RPC_HEADERS);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (endLedger !== undefined && startLedger !== undefined && endLedger < startLedger) {
    process.stderr.write(
      `error: --end-ledger (${endLedger}) is before --start-ledger (${startLedger})\n`,
    );
    return 2;
  }
  // A stored cursor and a bounded range are contradictory instructions: the
  // cursor says "carry on from where you were", the range says "read exactly
  // this window". Rather than silently picking one, say so.
  if (endLedger !== undefined && !values['no-resume']) {
    process.stderr.write(
      'error: --end-ledger indexes a fixed range and cannot resume from a stored cursor.\n' +
        '       Add --no-resume to read the range, or drop --end-ledger to follow the tip.\n',
    );
    return 2;
  }

  const retry = {
    ...numeric('attempts', values['retry-attempts'] ?? process.env.LENS_RETRY_ATTEMPTS),
    ...numeric('baseDelayMs', values['retry-base-delay'] ?? process.env.LENS_RETRY_BASE_DELAY_MS),
    ...numeric('maxDelayMs', values['retry-max-delay'] ?? process.env.LENS_RETRY_MAX_DELAY_MS),
  };

  const port = parseMetricsPort(values['metrics-port'] ?? process.env.LENS_METRICS_PORT);
  const metrics = new IngestMetrics();
  const client = new LensRpcClient({
    metrics,
    rpcUrl: network.rpcUrl,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    retry: {
      ...retry,
      onRetry: (attempt, delay, error) =>
        process.stderr.write(
          `[ingest] retry ${attempt} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
    },
  });

  const dataDir = values['cursor-dir'] ?? process.env.LENS_DATA_DIR ?? './data';
  const cursors = values['no-resume'] ? new MemoryCursorStore() : new FileCursorStore(dataDir);

  const poller = new EventPoller(
    {
      contractIds,
      eventType,
      ...(topics ? { topics } : {}),
      ...(endLedger !== undefined ? { endLedger } : {}),
      ...(startLedger !== undefined ? { startLedger } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(pollInterval !== undefined ? { pollIntervalMs: pollInterval } : {}),
      ...(values['poll-max-interval'] || process.env.LENS_POLL_MAX_INTERVAL_MS
        ? { maxPollIntervalMs: Number(values['poll-max-interval'] ?? process.env.LENS_POLL_MAX_INTERVAL_MS) }
        : {}),
      ...numeric('stalledThresholdMs', values['stalled-threshold'] ?? process.env.LENS_STALLED_THRESHOLD_MS),
    },
    {
      client,
      cursors,
      metrics,
      log: (m) => process.stderr.write(`[ingest] ${m}\n`),
    },
  );

  const eventLimit = maxEvents ?? Infinity;
  let emitted = 0;

  process.stderr.write(
    `[ingest] ${network.name} ${network.rpcUrl} watching ${contractIds.length} contract(s)` +
      ` type=${eventType}` +
      (topics ? ` topics=${topics[0]?.join(',')}` : '') +
      (endLedger !== undefined ? ` endLedger=${endLedger}` : '') +
      // Names only. A header value is a provider API key and must never reach
      // a log, a terminal scrollback or a bug report.
      (Object.keys(headers).length > 0 ? ` headers=${redactHeaders(headers)}` : '') +
      '\n',
  );

  const metricsServer = port === undefined ? undefined : await startMetricsServer(
    metrics, port, values['metrics-host'] ?? process.env.LENS_METRICS_HOST ?? '127.0.0.1',
  );
  try {
    for await (const batch of poller.stream()) {
      for (const event of batch.events) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        if (++emitted >= eventLimit) {
          process.stderr.write(`[ingest] reached --max-events (${eventLimit})\n`);
          return 0;
        }
      }
      if (batch.progress.reachedEndLedger) {
        process.stderr.write(`[ingest] reached --end-ledger (${endLedger})\n`);
        return 0;
      }
      if (values.once && batch.progress.caughtUp) {
        process.stderr.write(`[ingest] caught up at ledger ${batch.progress.latestLedger}\n`);
        return 0;
      }
    }
    return 0;
  } finally {
    if (metricsServer) await closeMetricsServer(metricsServer);
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`[ingest] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
