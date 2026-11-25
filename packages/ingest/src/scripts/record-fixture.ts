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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { LensRpcClient, buildFilters } from '../rpc-client.js';
import { RpcRecorder } from '../recorder.js';
import { resolveNetwork } from '../networks.js';

const MAX_PAGES = 32;

/** Default output paths, relative to the repo root (cwd when run via npm). */
const DEFAULT_RECORDING_OUT = 'fixtures/testnet-getevents-recording.json';
const DEFAULT_SPECS_OUT = 'fixtures/testnet-specs.json';

interface SpecEntry {
  contractId: string;
  spec: unknown;
}

/**
 * Recursively sort object keys so serialization is deterministic. Arrays keep
 * their order (call order for exchanges, contract order for specs).
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Serialize with sorted keys, 2-space indent and a trailing newline. */
function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/**
 * Trim a contract spec the same way the checked-in fixture is trimmed: drop
 * `function` and error-enum entries, and drop contracts with no event entries.
 * Returns `undefined` when nothing remains.
 */
function trimSpec(spec: unknown): unknown | undefined {
  if (spec === null || typeof spec !== 'object') return undefined;
  const src = spec as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === 'functions' || key === 'function') continue;
    if (key === 'events') {
      if (Array.isArray(value) && value.length === 0) continue;
      out[key] = value;
      continue;
    }
    if (key === 'enums' && Array.isArray(value)) {
      const enums = value.filter((entry) => {
        if (entry === null || typeof entry !== 'object') return true;
        const e = entry as Record<string, unknown>;
        const cases = e.cases;
        // Drop error enums (those whose cases are all error variants).
        const isErrorEnum =
          Array.isArray(cases) &&
          cases.length > 0 &&
          cases.every(
            (c) =>
              c !== null &&
              typeof c === 'object' &&
              typeof (c as Record<string, unknown>).error === 'string',
          );
        return !isErrorEnum;
      });
      if (enums.length > 0) out[key] = enums;
      continue;
    }
    out[key] = value;
  }
  // Drop contracts with no event entries.
  const events = out.events;
  if (!Array.isArray(events) || events.length === 0) return undefined;
  return out;
}

/** Load a JSON config file listing contract ids to capture. */
async function loadContractConfig(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed.map((v) => String(v));
  }
  if (parsed !== null && typeof parsed === 'object') {
    const contracts = (parsed as Record<string, unknown>).contracts;
    if (Array.isArray(contracts)) return contracts.map((v) => String(v));
  }
  throw new Error(`config ${path} must be an array or { "contracts": [...] }`);
}
=======

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
      config: { type: 'string' },
      out: { type: 'string', short: 'o' },
      'specs-out': { type: 'string' },
      'no-specs': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      'usage: record-fixture [-c <contract>]... [--config <path>] [-o <path>] [--specs-out <path>] [--no-specs]\n' +
        '                     [--start-ledger N] [--end-ledger N] [--page-size N] [--network NAME] [--rpc-url URL]\n' +
        '\n' +
        '  -c, --contract   contract id to capture (repeatable)\n' +
        '  --config         JSON file with an array of ids or { "contracts": [...] }\n' +
        '  -o, --out        recording output (default fixtures/testnet-getevents-recording.json)\n' +
        '  --specs-out      specs output (default fixtures/testnet-specs.json)\n' +
        '  --no-specs       skip the specs capture\n',
    );
    return 0;
  }

  const contracts = [...(values.contract ?? [])];
  if (values.config) {
    contracts.push(...(await loadContractConfig(values.config)));
  }
  const uniqueContracts = [...new Set(contracts.map((c) => c.trim()).filter((c) => c.length > 0))].sort();
  if (uniqueContracts.length === 0) {
    process.stderr.write('error: at least one -c <contract> or --config <path> is required\n');
    return 2;
  }

  const recordingOut = values.out ?? DEFAULT_RECORDING_OUT;
  const specsOut = values['specs-out'] ?? DEFAULT_SPECS_OUT;
  const captureSpecs = !values['no-specs'];

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
      filters: buildFilters(uniqueContracts),
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

  // 3. Capture each contract's spec, trimmed the same way the fixture is.
  const specs: SpecEntry[] = [];
  if (captureSpecs) {
    for (const contractId of uniqueContracts) {
      try {
        const spec = await client.getContractSpec(contractId);
        const trimmed = trimSpec(spec);
        if (trimmed === undefined) {
          process.stderr.write(`[record] ${contractId}: no event entries, skipping spec\n`);
          continue;
        }
        specs.push({ contractId, spec: trimmed });
        process.stderr.write(`[record] ${contractId}: captured spec\n`);
      } catch (error) {
        process.stderr.write(
          `[record] ${contractId}: spec capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  const capturedAt = new Date().toISOString();
  const command = ['record-fixture', ...argv].join(' ');
  const source = {
    rpcUrl: network.rpcUrl,
    network: network.name,
    capturedAt,
    command,
  };

  // 4. Write the recording deterministically.
  const recording = recorder.toJSON() as Record<string, unknown>;
  recording._source = source;
  await mkdir(dirname(resolve(recordingOut)), { recursive: true });
  await writeFile(resolve(recordingOut), stableJson(recording), 'utf8');
  process.stderr.write(`[record] wrote ${recordingOut}\n`);

  // 5. Write the specs deterministically (contracts sorted by id).
  if (captureSpecs) {
    const specsDoc = {
      _source: source,
      contracts: specs.sort((a, b) => a.contractId.localeCompare(b.contractId)),
    };
    await mkdir(dirname(resolve(specsOut)), { recursive: true });
    await writeFile(resolve(specsOut), stableJson(specsDoc), 'utf8');
    process.stderr.write(`[record] wrote ${specsOut} (${specs.length} contract(s))\n`);
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`[record] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
