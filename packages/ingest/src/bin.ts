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

const EVENT_TYPES: EventType[] = ['contract', 'system', 'diagnostic'];

function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as string[]).includes(value);
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
      --type <kind>        contract | system | diagnostic (default: contract).
      --cursor-dir <path>  Where to persist resume state (default: ./data).
      --no-resume          Ignore and do not write any stored cursor.
      --once               Exit once caught up to the current tip.
      --max-events <n>     Exit after emitting this many events.
  -h, --help               Show this help.

Environment:
  LENS_NETWORK, LENS_RPC_URL, LENS_CONTRACT_IDS (comma separated), LENS_DATA_DIR

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
      type: { type: 'string' },
      'cursor-dir': { type: 'string' },
      'no-resume': { type: 'boolean' },
      once: { type: 'boolean' },
      'max-events': { type: 'string' },
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

  const client = new LensRpcClient({
    rpcUrl: network.rpcUrl,
    retry: {
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
      ...(values['start-ledger'] ? { startLedger: Number(values['start-ledger']) } : {}),
      ...(values['page-size'] ? { pageSize: Number(values['page-size']) } : {}),
      ...(values['poll-interval'] ? { pollIntervalMs: Number(values['poll-interval']) } : {}),
    },
    {
      client,
      cursors,
      log: (m) => process.stderr.write(`[ingest] ${m}\n`),
    },
  );

  const maxEvents = values['max-events'] ? Number(values['max-events']) : Infinity;
  let emitted = 0;

  process.stderr.write(
    `[ingest] ${network.name} ${network.rpcUrl} watching ${contractIds.length} contract(s)` +
      ` type=${eventType}` +
      '\n',
  );

  for await (const batch of poller.stream()) {
    for (const event of batch.events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      if (++emitted >= maxEvents) {
        process.stderr.write(`[ingest] reached --max-events (${maxEvents})\n`);
        return 0;
      }
    }
    if (values.once && batch.progress.caughtUp) {
      process.stderr.write(`[ingest] caught up at ledger ${batch.progress.latestLedger}\n`);
      return 0;
    }
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`[ingest] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
