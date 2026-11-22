#!/usr/bin/env node
/**
 * Refresh an RPC recording (#143).
 *
 * Drives a live `LensRpcClient` through the same startup sequence the poller
 * uses (`getNetwork`, then `retention`, then a bounded `getEvents` walk) and
 * writes the resulting request/response pairs to a fixture. Not part of any
 * test; the test only reads the fixture.
 *
 * Usage:
 *   npm run record-fixture -w @soroban-lens/ingest -- \
 *     -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
 *     --start-ledger 4695000 --end-ledger 4695400 --page-size 2 \
 *     --out fixtures/testnet-getevents-recording.json
 */
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LensRpcClient, buildFilters } from '../rpc-client.js';
import { RpcRecorder } from '../recorder.js';
import { resolveNetwork } from '../networks.js';

const MAX_PAGES = 32;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      contract: { type: 'string', short: 'c', multiple: true },
      network: { type: 'string', short: 'n' },
      'rpc-url': { type: 'string', short: 'r' },
      'start-ledger': { type: 'string' },
      'end-ledger': { type: 'string' },
      'page-size': { type: 'string' },
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      'usage: record-fixture -c <contract> -o <path> [--start-ledger N] [--end-ledger N] [--page-size N] [--network NAME] [--rpc-url URL]\n',
    );
    return 0;
  }
  if (!values.contract || values.contract.length === 0) {
    process.stderr.write('error: at least one -c <contract> is required\n');
    return 2;
  }
  if (!values.out) {
    process.stderr.write('error: -o <path> is required\n');
    return 2;
  }

  const network = resolveNetwork(
    values.network ?? process.env.LENS_NETWORK ?? 'testnet',
    values['rpc-url'] ?? process.env.LENS_RPC_URL,
  );
  const client = new LensRpcClient({ rpcUrl: network.rpcUrl });
  const recorder = new RpcRecorder(client, {
    meta: { network: network.name, rpcUrl: network.rpcUrl },
  });

  // 1. Startup sequence: getNetwork, retention. Same order the poller uses,
  //    so the recorded fixture exercises the passphrase-check path (#139).
  const networkInfo = await recorder.getNetwork();
  process.stderr.write(`[record] node reports "${networkInfo.passphrase}"\n`);
  if (networkInfo.passphrase !== network.networkPassphrase) {
    process.stderr.write(
      `[record] refusing to record: node passphrase does not match ` +
        `"${network.networkPassphrase}" for ${network.name}\n`,
    );
    return 1;
  }

  const retention = await recorder.retention();
  const effectiveStart = values['start-ledger'] !== undefined
    ? Number(values['start-ledger'])
    : retention.oldestLedger;
  const effectiveEnd = values['end-ledger'] !== undefined
    ? Number(values['end-ledger'])
    : retention.latestLedger;
  const pageSize = values['page-size'] !== undefined ? Number(values['page-size']) : 2;

  // 2. Bounded getEvents walk.
  let cursor: string | undefined;
  let recordedEvents = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await recorder.getEvents({
      filters: buildFilters(values.contract),
      limit: pageSize,
      ...(cursor ? { cursor } : { startLedger: effectiveStart }),
      endLedger: effectiveEnd,
    });
    recordedEvents += batch.events.length;
    process.stderr.write(
      `[record] page ${page + 1}: ${batch.events.length} event(s), cursor=${batch.cursor}\n`,
    );
    if (batch.events.length < pageSize) break;
    cursor = batch.cursor;
  }
  process.stderr.write(`[record] ${recordedEvents} event(s) across ${recorder.exchangeCount} exchange(s)\n`);

  await mkdir(dirname(values.out), { recursive: true });
  await recorder.save(values.out);
  process.stderr.write(`[record] wrote ${values.out}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`[record] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
