# `@soroban-lens/ingest` — Module 1: Ingestion & RPC Client

Owner: **Person A**

Talks to a Soroban RPC node, pulls contract events, and keeps track of where it
got to. It knows nothing about SQL, HTTP, or XDR decoding — it hands the rest of
the system the exact bytes the network produced.

## Deliverable

```bash
npm run build -w @soroban-lens/ingest

node packages/ingest/dist/bin.js \
  -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --max-events 5 --no-resume
```

Raw events, one JSON object per line, on stdout. Logs go to stderr, so
`| jq` works without filtering noise out first.

## The interface other modules depend on

One type, [`RawEvent`](./src/types.ts). It mirrors an entry of the `events`
array from the RPC's [`getEvents`](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents)
method with the default `xdrFormat: "base64"`:

```ts
interface RawEvent {
  id: string;                        // "0020166232959352832-0000000000"
  type: 'contract' | 'system';
  ledger: number;
  ledgerClosedAt: string;            // RFC3339
  contractId: string;                // "C..." StrKey
  topic: string[];                   // base64 XDR ScVals, NOT decoded
  value: string;                     // base64 XDR ScVal, NOT decoded
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  inSuccessfulContractCall: boolean;
}
```

**Module 2 does not import this package.** It declares a structurally identical
input type of its own, so Person A and Person B never block each other on a
build. That duplication is deliberate; the price is that changing `RawEvent` is a
breaking change for the whole pipeline and needs a heads-up in `CONTRIBUTING.md`.

## Library use

```ts
import { LensRpcClient, EventPoller, FileCursorStore, resolveNetwork } from '@soroban-lens/ingest';

const network = resolveNetwork('testnet');
const client = new LensRpcClient({ rpcUrl: network.rpcUrl });

const poller = new EventPoller(
  { contractIds: ['CDLZ...'], pageSize: 200, pollIntervalMs: 2000 },
  { client, cursors: new FileCursorStore('./data') },
);

for await (const batch of poller.stream()) {
  console.log(batch.events.length, 'events through ledger', batch.progress.ledger);
}
```

`stream()` runs until the `AbortSignal` you pass fires. It is an async
generator, so backpressure is free: the poller does not fetch the next page
until you have finished with the current one.

## Behaviour worth knowing

**Delivery is at-least-once.** The cursor is saved only *after* the consumer
comes back for the next page. A crash mid-write replays the last batch instead
of losing it. Module 2 deduplicates on the event id, so replay is harmless —
but any other consumer has to expect duplicates.

**Cursor and ledger range are mutually exclusive.** The RPC rejects a request
carrying both `cursor` and `startLedger`. The client enforces this before the
request goes out, rather than letting the node return a confusing error.

**Retention is about 7 days.** Nodes keep ~120 960 ledgers. Two consequences:
a `startLedger` older than the window is clamped to `oldestLedger` with a
warning, and a stored cursor that has aged out triggers a restart from
`oldestLedger` — with a log line saying the gap is unrecoverable from that node,
because it is. Long backfills need an archive source, not an RPC node.

**Retries use full jitter.** `delay = random(0, min(maxDelay, base · 2ⁿ))`.
Full rather than equal jitter, so several indexers restarting against the same
node do not resynchronise into a thundering herd.

**Five contract ids per filter.** The RPC caps it. `buildFilters()` chunks
larger sets across multiple filters automatically.

## Configuration

| Flag | Env | Default |
|---|---|---|
| `--contract`, `-c` | `LENS_CONTRACT_IDS` (comma separated) | *required* |
| `--network`, `-n` | `LENS_NETWORK` | `testnet` |
| `--rpc-url`, `-r` | `LENS_RPC_URL` | the network preset |
| `--cursor-dir` | `LENS_DATA_DIR` | `./data` |
| `--start-ledger` | — | oldest retained ledger |
| `--page-size` | — | `200` (max `10000`) |
| `--poll-interval` | — | `2000` ms |
| `--once` | — | off — exit once caught up |
| `--no-resume` | — | off — ignore stored cursors |
| `--max-events` | — | unlimited |

`mainnet` has no free public RPC with useful retention. Set `LENS_RPC_URL` to
your own node or a provider before pointing this at mainnet.

## Tests

```bash
npm test -w @soroban-lens/ingest
```

No network required. The poller tests drive a scripted fake RPC client, which is
how retention-window recovery and cursor resumption get tested at all — you
cannot make a real node forget a ledger on demand.
