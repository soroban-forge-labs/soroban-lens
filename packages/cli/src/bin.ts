#!/usr/bin/env node
/**
 * `lens` — the operator-facing entry point.
 *
 *   lens doctor   check everything before you wait on a silent failure
 *   lens index    run the ingest -> store pipeline
 *   lens seed     load the committed testnet fixture
 *   lens stats    what is in the database
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { SqliteEventStore } from '@soroban-lens/store';
import type { RawEventInput } from '@soroban-lens/store';
import { resolveConfig } from './config.js';
import { formatReport, runDoctor } from './doctor.js';
import { runIndexer } from './indexer.js';

const USAGE = `
lens — soroban-lens operator CLI

Usage:
  lens doctor [options]              Preflight: Node, data dir, database, RPC, contract ids.
  lens index  [options]              Run the indexer (ingest -> decode -> store).
  lens seed   [--fixture <path>]     Load a captured getEvents response into the database.
  lens stats  [options]              Print database statistics.

Options:
  -c, --contract <id>     Contract to watch. Repeatable. (env LENS_CONTRACT_IDS)
  -n, --network <name>    testnet | mainnet | futurenet  (env LENS_NETWORK)
  -r, --rpc-url <url>     Override the network's RPC URL. (env LENS_RPC_URL)
  -d, --db <path>         SQLite file. (env LENS_DB_PATH, default ./data/lens.db)
      --data-dir <path>   Working directory for state. (env LENS_DATA_DIR)
      --start-ledger <n>  First ledger when no cursor is stored. (env LENS_START_LEDGER)
      --page-size <n>     Events per RPC page, 1-10000. (env LENS_PAGE_SIZE)
      --poll-interval <n> Milliseconds to wait at the tip. (env LENS_POLL_INTERVAL_MS)
      --once              index: stop once caught up to the network tip.
      --max-events <n>    index: stop after this many events.
      --fixture <path>    seed: file to load (default fixtures/testnet-events.json).
  -h, --help              Show this help.

Examples:
  lens doctor -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
  lens index  -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --once
  lens seed
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = command && !command.startsWith('-') ? argv.slice(1) : argv;

  const { values } = parseArgs({
    args: rest,
    options: {
      contract: { type: 'string', short: 'c', multiple: true },
      network: { type: 'string', short: 'n' },
      'rpc-url': { type: 'string', short: 'r' },
      db: { type: 'string', short: 'd' },
      'data-dir': { type: 'string' },
      'start-ledger': { type: 'string' },
      'page-size': { type: 'string' },
      'poll-interval': { type: 'string' },
      once: { type: 'boolean' },
      'max-events': { type: 'string' },
      fixture: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help || !command || command.startsWith('-')) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }

  const config = resolveConfig({
    ...(values.network !== undefined ? { network: values.network } : {}),
    ...(values['rpc-url'] !== undefined ? { rpcUrl: values['rpc-url'] } : {}),
    ...(values.contract !== undefined ? { contracts: values.contract } : {}),
    ...(values.db !== undefined ? { db: values.db } : {}),
    ...(values['data-dir'] !== undefined ? { dataDir: values['data-dir'] } : {}),
    ...(values['start-ledger'] !== undefined ? { startLedger: Number(values['start-ledger']) } : {}),
    ...(values['page-size'] !== undefined ? { pageSize: Number(values['page-size']) } : {}),
    ...(values['poll-interval'] !== undefined ? { pollInterval: Number(values['poll-interval']) } : {}),
  });

  switch (command) {
    case 'doctor': {
      const { text, exitCode } = formatReport(await runDoctor(config));
      process.stdout.write(text);
      return exitCode;
    }

    case 'index': {
      const controller = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          process.stderr.write(`\n[lens] ${signal}, finishing the current batch…\n`);
          controller.abort();
        });
      }
      const result = await runIndexer({
        config,
        signal: controller.signal,
        log: (m) => process.stderr.write(`[lens] ${m}\n`),
        ...(values['max-events'] ? { maxEvents: Number(values['max-events']) } : {}),
        ...(values.once ? { stopWhenCaughtUp: true } : {}),
      });
      process.stderr.write(
        `[lens] stopped: ${result.inserted} new event(s) of ${result.seen} seen, through ledger ${result.lastLedger}\n`,
      );
      return 0;
    }

    case 'seed': {
      const path = values.fixture ?? 'fixtures/testnet-events.json';
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { events?: RawEventInput[] };
      const events = parsed.events ?? [];
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        const inserted = await store.insertEvents(events);
        process.stderr.write(
          `[lens] seeded ${config.dbPath} from ${path}: ${inserted} new of ${events.length}\n`,
        );
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'stats': {
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        const [stats, contracts, topics, streams] = await Promise.all([
          store.getStats(),
          store.listContracts(10),
          store.countByTopic(10),
          store.listStreamStates(),
        ]);
        process.stdout.write(
          `${JSON.stringify(
            { ...stats, streams, topContracts: contracts, topTopics: topics },
            null,
            2,
          )}\n`,
        );
      } finally {
        await store.close();
      }
      return 0;
    }

    default:
      process.stderr.write(`error: unknown command "${command}"\n${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`[lens] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
