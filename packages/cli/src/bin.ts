#!/usr/bin/env node
/**
 * `lens` — the operator-facing entry point.
 *
 *   lens doctor   check everything before you wait on a silent failure
 *   lens index    run the ingest -> store pipeline
 *   lens seed     load the committed testnet fixture
 *   lens stats    what is in the database
 *   lens tail     follow new events as they are indexed
 */
import { parseArgs } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { SqliteEventStore } from '@soroban-lens/store';
import type { ContractSpecRecord, RawEventInput } from '@soroban-lens/store';
import { resolveConfig } from './config.js';
import { formatReport, runDoctor } from './doctor.js';
import { applyFixes, formatFixes } from './fix.js';
import { buildTailQuery, followEvents, formatEvent, formatEventJson, TailUsageError, wantsColor } from './tail.js';
import { runIndexer } from './indexer.js';
import { restoreBackup } from './backup.js';
import { assertContractIds, loadContractIdsFromFile, ContractFileParseError } from '@soroban-lens/ingest';
import {
  describeSpecRecord,
  lookupContractSpec,
  recordFromWasmFile,
  rpcSpecSource,
} from './specs.js';

const USAGE = `
lens — soroban-lens operator CLI

Usage:
  lens doctor [options]              Preflight: Node, data dir, database, RPC, clock skew, contract ids.
  lens doctor --fix                  Apply the safe remedies first: .env, data dir, pending migrations.
  lens index  [options]              Run the indexer (ingest -> decode -> store).
  lens seed   [--fixture <path>]     Load a captured getEvents response (and, by default, its
                                     contracts' specs) into the database.
  lens stats  [options]              Print database statistics.
  lens tail   [filters] [--json]     Follow events as they are indexed, colourised or as NDJSON.
  lens prune --before-ledger <n>     Delete events below a ledger and reclaim disk space.
  lens redecode [--all]              Re-run the decoder over previously-failed rows.
  lens verify [--repair]             Check event rows and contract summaries.
  lens migrate --down --to <n>       Roll back migrations above version <n>.
  lens export <path>                 Write every event as NDJSON, backend-portable.
  lens backup <path>                 Consistent copy of the whole database, safe while indexing.
  lens restore <path> [--force]      Replace the database with a backup (stop the indexer first).
  lens import <path>                 Load an NDJSON snapshot written by 'lens export'.
  lens spec [list]                   Show which contracts have a spec for typed decoding.
  lens spec fetch -c <id>            Look a contract's spec up on-chain now (refreshes it).
  lens spec import -c <id> <wasm>    Use a local Wasm build's spec for a contract.
  lens completion [bash|zsh|fish]    Generate shell auto-completion script.


Options:
  -c, --contract <id>     Contract to watch. Repeatable. (env LENS_CONTRACT_IDS)
      --contracts-file <path>  Load contract ids from a file (one per line, # comments allowed).
                          Merged with any -c flags; duplicates silently dropped.
      --rpc-header <h>    'Name: value' header for the RPC. Repeatable.
                          Values are redacted in all output. (env LENS_RPC_HEADERS)
      --retry-attempts <n>     Total RPC attempts including the first.
      --retry-base-delay <ms>  First retry delay.
      --retry-max-delay <ms>   Ceiling on any one retry delay.
  -n, --network <name>    testnet | mainnet | futurenet  (env LENS_NETWORK)
  -r, --rpc-url <url>     Override the network's RPC URL. (env LENS_RPC_URL)
      --rpc-url-list <url> Repeatable ordered RPC failover list. (env LENS_RPC_URLS)
      --archive-url <url>  Public Stellar history archive root. (env LENS_ARCHIVE_URL)
  -d, --db <path>         SQLite file. (env LENS_DB_PATH, default ./data/lens.db)
      --data-dir <path>   Working directory for state. (env LENS_DATA_DIR)
      --start-ledger <n>  First ledger when no cursor is stored. (env LENS_START_LEDGER)
      --page-size <n>     Events per RPC page, 1-10000. (env LENS_PAGE_SIZE)
      --page-size-min <n> Let the page size adapt, no lower than this. (env LENS_PAGE_SIZE_MIN)
      --page-size-max <n> Let the page size adapt, no higher than this. (env LENS_PAGE_SIZE_MAX)
      --reorg-depth <n>   Recent ledgers re-read to catch reorgs; 0 is off. (env LENS_REORG_DEPTH, default 3)
      --poll-interval <n> Milliseconds to wait at the tip. (env LENS_POLL_INTERVAL_MS)
      --poll-max-interval <n> Maximum idle wait after repeated empty polls. (env LENS_POLL_MAX_INTERVAL_MS)
      --once              index: stop once caught up to the network tip.
      --max-events <n>    index: stop after this many events.
      --fixture <path>    seed: file to load (default fixtures/testnet-events.json).
      --before-ledger <n> prune: delete events with ledger below this.
      --all               redecode: re-run over every row, not only failures.
      --repair            verify: recompute derived rows and contract summaries.
      --down              migrate: roll back rather than apply forward.
      --to <n>            migrate --down: target schema version.
      --fix               doctor: create .env and data/, run pending migrations. Never
                          deletes anything, never touches network settings.

tail filters (the API's, by the same rules):
  -c, --contract <id>     Follow one contract. Omit to follow every indexed contract.
      --topic <t>         Topic prefix, positional and repeatable; '*' matches any one position.
      --address <G…|C…>   Events mentioning this address anywhere.
      --tx-hash <hex>     Events from one transaction.
      --search <text>     Substring match on decoded topics and value (3+ characters).
      --successful-only   Skip events from failed contract calls.
      --from-ledger <n>   Replay matching history from this ledger, then keep following.
      --from-time <t>     Replay from an ISO-8601 time or epoch seconds, then keep following.
      --json              One full event per line (NDJSON), for piping into jq.
      --max-events <n>    Stop after this many matching events.
  -h, --help              Show this help.

Examples:
  lens doctor -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
  lens index  -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --once
  lens seed
  lens tail   -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --topic transfer
  lens tail   --topic transfer --json | jq .value
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = command && !command.startsWith('-') ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      contract: { type: 'string', short: 'c', multiple: true },
      'contracts-file': { type: 'string' },
      network: { type: 'string', short: 'n' },
      'rpc-url': { type: 'string', short: 'r' },
      'rpc-url-list': { type: 'string', multiple: true },
      'archive-url': { type: 'string' },
      db: { type: 'string', short: 'd' },
      'data-dir': { type: 'string' },
      'start-ledger': { type: 'string' },
      'page-size': { type: 'string' },
      'page-size-min': { type: 'string' },
      'page-size-max': { type: 'string' },
      'reorg-depth': { type: 'string' },
      'poll-interval': { type: 'string' },
      'poll-max-interval': { type: 'string' },
      'rpc-header': { type: 'string', multiple: true },
      'retry-attempts': { type: 'string' },
      'retry-base-delay': { type: 'string' },
      'retry-max-delay': { type: 'string' },
      once: { type: 'boolean' },
      all: { type: 'boolean' },
      repair: { type: 'boolean' },
      force: { type: 'boolean' },
      down: { type: 'boolean' },
      to: { type: 'string' },
      'max-events': { type: 'string' },
      fixture: { type: 'string' },
      'before-ledger': { type: 'string' },
      fix: { type: 'boolean' },
      topic: { type: 'string', multiple: true },
      address: { type: 'string' },
      'tx-hash': { type: 'string' },
      search: { type: 'string' },
      'successful-only': { type: 'boolean' },
      'from-ledger': { type: 'string' },
      'from-time': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true, // 'export <path>', 'import <path>', 'completion <shell>'
  });

  if (values.help || !command || command.startsWith('-')) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }

  // Load contract ids from --contracts-file (if given) and merge with -c flags.
  // File ids come first; -c ids are appended, then duplicates are dropped.
  let contractIds: string[] | undefined;
  if (values['contracts-file'] !== undefined) {
    let fileIds: string[];
    try {
      fileIds = await loadContractIdsFromFile(values['contracts-file']);
    } catch (error) {
      if (error instanceof ContractFileParseError) {
        process.stderr.write(`error: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
    // Merge: file ids first, then -c flags; duplicates silently dropped.
    const seen = new Set<string>(fileIds);
    const merged = [...fileIds];
    for (const id of values.contract ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
    contractIds = merged;
  } else if (values.contract !== undefined) {
    contractIds = values.contract;
  }

  const config = resolveConfig({
    ...(values.network !== undefined ? { network: values.network } : {}),
    ...(values['rpc-url'] !== undefined ? { rpcUrl: values['rpc-url'] } : {}),
    ...(values['rpc-url-list'] !== undefined ? { rpcUrls: values['rpc-url-list'] } : {}),
    ...(values['archive-url'] !== undefined ? { archiveUrl: values['archive-url'] } : {}),
    ...(contractIds !== undefined ? { contracts: contractIds } : {}),
    ...(values.db !== undefined ? { db: values.db } : {}),
    ...(values['data-dir'] !== undefined ? { dataDir: values['data-dir'] } : {}),
    ...(values['start-ledger'] !== undefined ? { startLedger: Number(values['start-ledger']) } : {}),
    ...(values['page-size'] !== undefined ? { pageSize: Number(values['page-size']) } : {}),
    ...(values['page-size-min'] !== undefined ? { pageSizeMin: Number(values['page-size-min']) } : {}),
    ...(values['page-size-max'] !== undefined ? { pageSizeMax: Number(values['page-size-max']) } : {}),
    ...(values['reorg-depth'] !== undefined ? { reorgDepth: Number(values['reorg-depth']) } : {}),
    ...(values['poll-interval'] !== undefined ? { pollInterval: Number(values['poll-interval']) } : {}),
    ...(values['poll-max-interval'] !== undefined ? { maxPollInterval: Number(values['poll-max-interval']) } : {}),
    ...(values['rpc-header'] !== undefined ? { rpcHeaders: values['rpc-header'] } : {}),
    ...(values['retry-attempts'] !== undefined ? { retryAttempts: Number(values['retry-attempts']) } : {}),
    ...(values['retry-base-delay'] !== undefined ? { retryBaseDelay: Number(values['retry-base-delay']) } : {}),
    ...(values['retry-max-delay'] !== undefined ? { retryMaxDelay: Number(values['retry-max-delay']) } : {}),
  });

  switch (command) {
    case 'doctor': {
      // Fixes run first, so the report that follows describes the result.
      if (values.fix) process.stdout.write(formatFixes(await applyFixes(config)));
      const { text, exitCode } = formatReport(await runDoctor(config));
      process.stdout.write(text);
      return exitCode;
    }

    case 'tail': {
      let built: ReturnType<typeof buildTailQuery>;
      try {
        // -c straight from the flags, not config.contractIds: LENS_CONTRACT_IDS
        // is what the indexer watches, and may name several contracts, whereas
        // tail follows the one you asked for or, with none, all of them.
        built = buildTailQuery({
          contract: values.contract,
          topic: values.topic,
          address: values.address,
          txHash: values['tx-hash'],
          search: values.search,
          successfulOnly: values['successful-only'],
          fromLedger: values['from-ledger'],
          fromTime: values['from-time'],
        });
      } catch (error) {
        if (error instanceof TailUsageError) {
          process.stderr.write(`error: ${error.message}\n`);
          return 2;
        }
        throw error;
      }
      let maxEvents: number | undefined;
      if (values['max-events'] !== undefined) {
        maxEvents = Number(values['max-events']);
        if (!Number.isInteger(maxEvents) || maxEvents < 1) {
          process.stderr.write(`error: --max-events must be a positive integer, got "${values['max-events']}"\n`);
          return 2;
        }
      }
      try {
        await access(config.dbPath);
      } catch {
        // Opening a missing path would quietly create an empty database and
        // then follow it forever, which looks exactly like a quiet contract.
        process.stderr.write(`error: no database at ${config.dbPath}. Run \`lens index\` (or \`lens seed\`) first, or pass --db.\n`);
        return 1;
      }

      const controller = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
      // `| head` closing the pipe is a normal way to stop tailing, not a crash.
      process.stdout.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') controller.abort();
      });

      const color = !values.json && wantsColor(process.stdout);
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        if (!values.json) {
          process.stderr.write(
            `[lens] following ${built.query.contractId ?? 'every contract'} in ${config.dbPath}` +
              `${built.fromStart ? ', from history' : ''} (Ctrl-C to stop)\n`,
          );
        }
        await followEvents({
          store,
          query: built.query,
          fromStart: built.fromStart,
          signal: controller.signal,
          maxEvents,
          ...(values['poll-interval'] !== undefined ? { pollIntervalMs: Number(values['poll-interval']) } : {}),
          onEvent: (event) => {
            process.stdout.write(`${values.json ? formatEventJson(event) : formatEvent(event, { color })}\n`);
          },
        });
      } finally {
        await store.close();
      }
      return 0;
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
        // The default fixture comes with the specs of its contracts, captured
        // the same day, so a seeded instance shows typed events (#33) with no
        // network. A custom --fixture has no matching spec file to assume.
        if (values.fixture === undefined) {
          const specsPath = 'fixtures/testnet-specs.json';
          const { specs } = JSON.parse(await readFile(specsPath, 'utf8')) as { specs: ContractSpecRecord[] };
          for (const record of specs) await store.saveContractSpec(record);
          process.stderr.write(`[lens] seeded ${specs.length} contract spec(s) from ${specsPath}\n`);
        }
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
        if (stats.decodeErrorCount > 0) {
          process.stderr.write(
            `[lens] ${stats.decodeErrorCount} event(s) failed to decode; run \`lens redecode\` to retry them\n`,
          );
        }
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'prune': {
      const raw = values['before-ledger'];
      if (raw === undefined) {
        process.stderr.write('error: prune requires --before-ledger <n>\n');
        return 2;
      }
      const beforeLedger = Number(raw);
      if (!Number.isFinite(beforeLedger) || beforeLedger < 0) {
        process.stderr.write(`error: --before-ledger must be a non-negative number, got "${raw}"\n`);
        return 2;
      }
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        const before = await store.getStats();
        const removed = await store.pruneBefore(beforeLedger);
        const after = await store.getStats();
        process.stderr.write(
          `[lens] pruned ${removed} event(s) below ledger ${beforeLedger} ` +
            `(${before.sizeBytes ?? '?'} -> ${after.sizeBytes ?? '?'} bytes)\n`,
        );
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'redecode': {
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        const rewritten = await store.redecode(values.all ?? false);
        process.stderr.write(
          `[lens] redecoded ${rewritten} row(s)${values.all ? ' (--all)' : ' with a stored decode error'}\n`,
        );
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'verify': {
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        const problems = await store.checkIntegrity();
        if (problems.length === 0) {
          process.stderr.write('[lens] verify: all rows are internally consistent\n');
          return 0;
        }
        for (const { kind, id, problems: rowProblems } of problems) {
          const label = kind === 'contract_summary' ? `contract summary ${id}` : id;
          process.stderr.write(`[lens] ${label}: ${rowProblems.join('; ')}\n`);
        }
        if (values.repair) {
          for (const { kind, id } of problems) {
            if (kind === 'contract_summary') await store.repairContractSummary(id);
            else await store.repairRow(id);
          }
          const remaining = await store.checkIntegrity();
          if (remaining.length === 0) {
            process.stderr.write(`[lens] repaired ${problems.length} problem(s); verification passed\n`);
            return 0;
          }
          process.stderr.write(`[lens] repair left ${remaining.length} problem(s)\n`);
          return 1;
        }
        process.stderr.write(`[lens] verify: ${problems.length} problem(s). Re-run with --repair to fix.\n`);
        return 1;
      } finally {
        await store.close();
      }
    }

    case 'migrate': {
      if (!values.down) {
        process.stderr.write('error: lens migrate currently only supports --down (forward migration runs automatically on open)\n');
        return 2;
      }
      if (values.to === undefined) {
        process.stderr.write('error: --down requires --to <version>\n');
        return 2;
      }
      const toVersion = Number(values.to);
      if (!Number.isFinite(toVersion) || toVersion < 0) {
        process.stderr.write(`error: --to must be a non-negative number, got "${values.to}"\n`);
        return 2;
      }
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        const rolledBack = await store.migrateDown(toVersion);
        if (rolledBack.length === 0) {
          process.stderr.write(`[lens] already at or below schema v${toVersion}; nothing to roll back\n`);
        } else {
          process.stderr.write(
            `[lens] rolled back migration(s) ${rolledBack.join(', ')}; now at schema v${toVersion}\n`,
          );
        }
      } catch (error) {
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'backup': {
      const path = positionals[0];
      if (!path) {
        process.stderr.write('error: lens backup requires a destination path\n');
        return 2;
      }
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        await store.backupTo(path);
        const stats = await store.getStats();
        process.stderr.write(`[lens] backed up ${config.dbPath} to ${path}: ${stats.eventCount} event(s), schema v${stats.schemaVersion}\n`);
      } catch (error) {
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'restore': {
      const path = positionals[0];
      if (!path) {
        process.stderr.write('error: lens restore requires a backup path\n');
        return 2;
      }
      const result = await restoreBackup(path, config.dbPath, { force: values.force ?? false });
      process.stderr.write(result.ok ? `[lens] ${result.message}\n` : `error: ${result.message}\n`);
      return result.ok ? 0 : 1;
    }

    case 'export': {
      const path = positionals[0];
      if (!path) {
        process.stderr.write('error: lens export requires a destination path\n');
        return 2;
      }
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        const count = await store.exportSnapshot(path);
        process.stderr.write(`[lens] exported ${count} event(s) to ${path}\n`);
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'import': {
      const path = positionals[0];
      if (!path) {
        process.stderr.write('error: lens import requires a source path\n');
        return 2;
      }
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        const count = await store.importSnapshot(path);
        process.stderr.write(`[lens] imported ${count} new event(s) from ${path}\n`);
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'spec': {
      const sub = positionals[0] ?? 'list';
      const store = new SqliteEventStore({ path: config.dbPath });
      try {
        if (sub === 'list') {
          const records = await store.listContractSpecs();
          if (records.length === 0) {
            process.stdout.write('no specs stored yet — `lens index` fetches them, or run `lens spec fetch -c <id>`\n');
          }
          for (const record of records) process.stdout.write(`${describeSpecRecord(record)}\n`);
          return 0;
        }
        if (sub !== 'fetch' && sub !== 'import') {
          process.stderr.write(`error: unknown spec subcommand "${sub}" (list | fetch | import)\n`);
          return 2;
        }
        if (config.contractIds.length === 0) {
          process.stderr.write(`error: lens spec ${sub} needs at least one -c <contract id>\n`);
          return 2;
        }
        assertContractIds(config.contractIds);

        if (sub === 'import') {
          const wasmPath = positionals[1];
          if (!wasmPath || config.contractIds.length !== 1) {
            process.stderr.write('error: lens spec import takes exactly one -c <id> and a .wasm path\n');
            return 2;
          }
          const record = await recordFromWasmFile(config.contractIds[0]!, wasmPath);
          await store.saveContractSpec(record);
          process.stdout.write(`${describeSpecRecord(record)}\n`);
          return record.source === 'none' ? 1 : 0;
        }

        const source = rpcSpecSource(config.network.rpcUrl, config.rpcHeaders);
        let failed = 0;
        for (const id of config.contractIds) {
          try {
            const record = await lookupContractSpec(source, id);
            await store.saveContractSpec(record);
            process.stdout.write(`${describeSpecRecord(record)}\n`);
          } catch (error) {
            failed++;
            process.stderr.write(`[lens] ${id}: lookup failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        return failed > 0 ? 1 : 0;
      } finally {
        await store.close();
      }
    }

    case 'completion': {
      const shell = positionals[0] || 'bash';
      process.stdout.write(`${generateCompletion(shell)}\n`);
      return 0;
    }

    default:
      process.stderr.write(`error: unknown command "${command}"\n${USAGE}\n`);
      return 2;
  }
}

function generateCompletion(shell: string): string {
  switch (shell.toLowerCase()) {
    case 'bash':
      return `_lens_completions() {
  local cur prev commands options
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="doctor index seed stats tail prune redecode verify migrate export import backup restore spec completion"
  options="-c --contract -n --network -r --rpc-url -d --db --data-dir --start-ledger --page-size --page-size-min --page-size-max --reorg-depth --poll-interval --once --max-events --fixture --before-ledger --force --fix --topic --address --tx-hash --search --successful-only --from-ledger --from-time --json -h --help"

  if [ $COMP_CWORD -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi

  case "$prev" in
    -n|--network)
      COMPREPLY=( $(compgen -W "testnet mainnet futurenet" -- "$cur") )
      return 0
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return 0
      ;;
    *)
      COMPREPLY=( $(compgen -W "$options" -- "$cur") )
      return 0
      ;;
  esac
}
complete -F _lens_completions lens`;

    case 'zsh':
      return `#compdef lens
_lens() {
  local -a commands
  commands=(
    'doctor:Preflight checks'
    'index:Run the indexer pipeline'
    'seed:Load testnet events fixture'
    'stats:Print database statistics'
    'tail:Follow events as they are indexed'
    'prune:Delete events below a ledger'
    'redecode:Re-run the decoder over failed rows'
    'verify:Check event rows and contract summaries'
    'migrate:Roll migrations forward or back'
    'export:Write an NDJSON snapshot'
    'import:Load an NDJSON snapshot'
    'spec:Contract specs for typed decoding'
    'completion:Generate shell autocompletions'
  )
  _arguments '1: :->command' '*: :->args'
  case $state in
    command) _describe 'command' commands ;;
  esac
}
compdef _lens lens`;

    case 'fish':
      return `complete -c lens -f
complete -c lens -n "__fish_use_subcommand" -a doctor -d "Preflight checks"
complete -c lens -n "__fish_use_subcommand" -a index -d "Run the indexer pipeline"
complete -c lens -n "__fish_use_subcommand" -a seed -d "Load testnet events fixture"
complete -c lens -n "__fish_use_subcommand" -a stats -d "Print database statistics"
complete -c lens -n "__fish_use_subcommand" -a tail -d "Follow events as they are indexed"
complete -c lens -n "__fish_use_subcommand" -a prune -d "Delete events below a ledger"
complete -c lens -n "__fish_use_subcommand" -a redecode -d "Re-run the decoder over failed rows"
complete -c lens -n "__fish_use_subcommand" -a verify -d "Check event rows and contract summaries"
complete -c lens -n "__fish_use_subcommand" -a migrate -d "Roll migrations forward or back"
complete -c lens -n "__fish_use_subcommand" -a export -d "Write an NDJSON snapshot"
complete -c lens -n "__fish_use_subcommand" -a import -d "Load an NDJSON snapshot"
complete -c lens -n "__fish_use_subcommand" -a spec -d "Contract specs for typed decoding"
complete -c lens -n "__fish_use_subcommand" -a completion -d "Generate shell completions"
complete -c lens -l network -s n -x -a "testnet mainnet futurenet"
complete -c lens -l help -s h -d "Show help"`;

    default:
      return 'Supported shells: bash, zsh, fish';
  }
}


main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`[lens] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
