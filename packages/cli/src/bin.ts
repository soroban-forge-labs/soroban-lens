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
  lens prune --before-ledger <n>     Delete events below a ledger and reclaim disk space.
  lens redecode [--all]              Re-run the decoder over previously-failed rows.
  lens verify [--repair]             Check stored-row invariants; optionally fix them.
  lens completion [bash|zsh|fish]    Generate shell auto-completion script.


Options:
  -c, --contract <id>     Contract to watch. Repeatable. (env LENS_CONTRACT_IDS)
      --rpc-header <h>    'Name: value' header for the RPC. Repeatable.
                          Values are redacted in all output. (env LENS_RPC_HEADERS)
      --retry-attempts <n>     Total RPC attempts including the first.
      --retry-base-delay <ms>  First retry delay.
      --retry-max-delay <ms>   Ceiling on any one retry delay.
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
      --before-ledger <n> prune: delete events with ledger below this.
      --all               redecode: re-run over every row, not only failures.
      --repair            verify: recompute derived columns for any bad row found.
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
      'rpc-header': { type: 'string', multiple: true },
      'retry-attempts': { type: 'string' },
      'retry-base-delay': { type: 'string' },
      'retry-max-delay': { type: 'string' },
      once: { type: 'boolean' },
      all: { type: 'boolean' },
      repair: { type: 'boolean' },
      'max-events': { type: 'string' },
      fixture: { type: 'string' },
      'before-ledger': { type: 'string' },
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
    ...(values['rpc-header'] !== undefined ? { rpcHeaders: values['rpc-header'] } : {}),
    ...(values['retry-attempts'] !== undefined ? { retryAttempts: Number(values['retry-attempts']) } : {}),
    ...(values['retry-base-delay'] !== undefined ? { retryBaseDelay: Number(values['retry-base-delay']) } : {}),
    ...(values['retry-max-delay'] !== undefined ? { retryMaxDelay: Number(values['retry-max-delay']) } : {}),
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
        for (const { id, problems: rowProblems } of problems) {
          process.stderr.write(`[lens] ${id}: ${rowProblems.join('; ')}\n`);
        }
        if (values.repair) {
          for (const { id } of problems) await store.repairRow(id);
          process.stderr.write(`[lens] repaired ${problems.length} row(s)\n`);
          return 0;
        }
        process.stderr.write(`[lens] verify: ${problems.length} row(s) with problems. Re-run with --repair to fix.\n`);
        return 1;
      } finally {
        await store.close();
      }
    }

    case 'completion': {
      const shell = rest[0] || 'bash';
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
  commands="doctor index seed stats prune redecode verify completion"
  options="-c --contract -n --network -r --rpc-url -d --db --data-dir --start-ledger --page-size --poll-interval --once --max-events --fixture --before-ledger -h --help"

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
    'prune:Delete events below a ledger'
    'redecode:Re-run the decoder over failed rows'
    'verify:Check stored-row invariants'
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
complete -c lens -n "__fish_use_subcommand" -a prune -d "Delete events below a ledger"
complete -c lens -n "__fish_use_subcommand" -a redecode -d "Re-run the decoder over failed rows"
complete -c lens -n "__fish_use_subcommand" -a verify -d "Check stored-row invariants"
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
