#!/usr/bin/env node
/**
 * `soroban-lens-store` — Module 2's standalone deliverable.
 *
 * Reads Module 1's NDJSON on stdin, decodes it, and writes it to SQLite:
 *
 *   soroban-lens-ingest -c C... --once | soroban-lens-store --db ./data/lens.db
 *
 * Also loads the committed fixture, so Modules 3 and 4 can be developed with no
 * network at all:
 *
 *   soroban-lens-store --db ./data/lens.db --fixture fixtures/testnet-events.json
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { SqliteEventStore } from './sqlite-store.js';
import type { RawEventInput } from './types.js';

const USAGE = `
soroban-lens-store — decode Soroban events into SQLite

Usage:
  soroban-lens-ingest -c <C...> | soroban-lens-store --db ./data/lens.db
  soroban-lens-store --db ./data/lens.db --fixture fixtures/testnet-events.json

Options:
  -d, --db <path>        SQLite file (default: ./data/lens.db, env LENS_DB_PATH)
  -f, --fixture <path>   Load a captured getEvents response instead of stdin.
      --stats            Print database statistics and exit.
  -h, --help             Show this help.
`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', short: 'd' },
      fixture: { type: 'string', short: 'f' },
      stats: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const dbPath = values.db ?? process.env.LENS_DB_PATH ?? './data/lens.db';
  const store = new SqliteEventStore({ path: dbPath });

  try {
    if (values.stats) {
      process.stdout.write(`${JSON.stringify(await store.getStats(), null, 2)}\n`);
      return 0;
    }

    let inserted = 0;
    let seen = 0;

    if (values.fixture) {
      const parsed = JSON.parse(await readFile(values.fixture, 'utf8')) as {
        events?: RawEventInput[];
      };
      const events = parsed.events ?? [];
      seen = events.length;
      inserted = await store.insertEvents(events);
    } else {
      // Batch stdin so each transaction covers a useful number of rows rather
      // than one row per commit.
      const batch: RawEventInput[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        inserted += await store.insertEvents(batch);
        batch.length = 0;
      };

      for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        seen++;
        try {
          batch.push(JSON.parse(trimmed) as RawEventInput);
        } catch (error) {
          process.stderr.write(
            `[store] skipping unparseable line ${seen}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          continue;
        }
        if (batch.length >= 500) await flush();
      }
      await flush();
    }

    process.stderr.write(
      `[store] ${dbPath}: read ${seen}, inserted ${inserted}, ${seen - inserted} duplicate/skipped\n`,
    );
    return 0;
  } finally {
    await store.close();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`[store] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
