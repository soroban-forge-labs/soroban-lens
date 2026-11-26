# Benchmarks

`npm run bench` measures insert throughput, query latency by filter and API
response times against a generated dataset of 1,000,000 events, so a claim like
"a benchmark shows..." has somewhere to be checked.

## Running

```bash
npm run bench                  # 1M events; writes bench/results/latest.json
npm run bench:quick            # 50k events, a smoke run
npm run bench -- --seed 7      # a different (still deterministic) dataset
npm run bench -- --out bench/results/before.json
```

A full run takes a few minutes, almost all of it seeding. It needs Node 22.13+
and no network. `bench/results/` is git-ignored.

| Flag | Default | Meaning |
|---|---|---|
| `--events` | `1000000` (or `LENS_BENCH_EVENTS`) | Dataset size. Runs of different sizes are not comparable. |
| `--seed` | `1` | PRNG seed. The same seed builds the same database. |
| `--out` | `bench/results/latest.json` | Where to write the results. |
| `--root` | `.` | Benchmark another checkout's built packages (used by CI for the base commit). |
| `--skip-api` | off | Skip the HTTP section. |

## What is measured

The dataset is deterministic and realistic rather than uniform: 1000 contracts
and 5000 accounts with long-tail popularity, mostly SAC-style `transfer`
events with `i128` amounts, plus mint, burn, approve and swap, and a rare topic
for search.

- **`insert.*`**: events per second through `insertEvents` (XDR decode, row
  insert, address index), overall and for the median 5000-event batch.
- **`query.*`**: `EventStore.queryEvents` and the aggregate methods, 50-row
  pages. Cases ending `_exact_count` pay for a real `COUNT(*)` (the count cache
  is off); the others use `skipTotal`. Covers hot and cold contracts, topic
  prefix, hot and cold address, ledger and time windows, tx hash, a deep
  cursor page, single-event lookup, FTS search (skipped when SQLite has no
  FTS5), `countByTopic` and `countByTimeBucket`. Contract listing compares a
  fresh `GROUP BY events` scan (`query.list_contracts_group_by`) with the
  summary-table lookup used by `listContracts` (`query.list_contracts`). The
  latter keeps the pre-change metric name so CI compares the optimization with
  the old implementation.
- **`api.*`**: the built API (`packages/api/dist/bin.js`) as a child process:
  `/health`, `/contracts`, `/contracts/<id>/events?limit=50` for a hot and a
  cold contract, and eight concurrent clients against the hot one (requests per
  second and latency).

Latencies are medians (p50); p95 is recorded alongside. Every case checks that
it actually returned rows, so a broken filter fails the run instead of
reporting a fast, meaningless number.

The contract-list comparison uses the same deterministic fixture and page
size for both paths. Run the default 1,000,000-event fixture for a representative
measurement; `npm run bench:quick` is only a smoke test.

## Comparing

```bash
npm run bench -- --out bench/results/before.json
# ...make a change, rebuild...
npm run bench -- --out bench/results/after.json
npm run bench:compare -- bench/results/before.json bench/results/after.json
```

`bench:compare` prints a table and exits 1 if any metric is more than 25%
worse (`--threshold`), ignoring latency changes smaller than 0.5 ms
(`--min-ms`). Runs from different dataset sizes or seeds are refused.

Compare runs from the same machine. Absolute numbers depend on hardware, which
is why there is no committed baseline file.

### Contract summaries (#152)

On the 1,000,000-event fixture (seed 1), listing 100 contracts took 12,190.555
ms p50 / 13,035.985 ms p95 with a fresh `GROUP BY events` scan, compared with
0.468 ms p50 / 0.722 ms p95 through `listContracts` and the summary table
(seven samples per path). This run used Node v24.15.0 on Windows x64 with an
Intel Core i7-7600U; absolute timings are machine-specific.

## In CI

`.github/workflows/bench.yml`:

- **Pull requests** build and benchmark the PR, then check out the base commit,
  build it and benchmark it on the same runner with the same harness, and
  compare. A significant regression fails the check, annotates the PR and
  writes the table to the job summary.
- **Pushes to `main`** benchmark and upload `bench/results/head.json` as an
  artifact (90 days), which is the history of the numbers over time.

Shared runners are noisy, so the threshold is deliberately generous. If a PR is
flagged and you suspect noise, re-run the job; a real regression reproduces.

## Adding a benchmark

Add a case to the `cases` list in `bench/run.js` (store) or a call in the API
section. Give it a stable name, because `compare.js` matches metrics by name. A
metric present on only one side is reported as new or removed, never as a
regression.

## Adaptive page size (#14)

```bash
npm run bench:page-size
```

Drives the real `EventPoller` against a simulated node: the same history served
twice, once at the fixed default page size and once with
`LENS_PAGE_SIZE_MIN=100` / `LENS_PAGE_SIZE_MAX=10000`. The node's response time
grows with page size, and in the second scenario it fails any request that would
take more than five seconds. Simulated rather than live, because the comparison
needs identical conditions twice; the latency constants are illustrative.

Recorded 2026-11-21:

| scenario | mode | events | round trips | failed requests | simulated time |
|---|---|---:|---:|---:|---:|
| busy contract, healthy node | fixed 200 | 100000 | 501 | 0 | 97.2s |
| busy contract, healthy node | adaptive 100..10000 | 100000 | 15 | 0 | 24.3s |
| busy contract, node times out above ~4000/page | fixed 200 | 100000 | 501 | 0 | 197.2s |
| busy contract, node times out above ~4000/page | adaptive 100..10000 | 100000 | 35 | 0 | 127.3s |
| quiet contract | fixed 200 | 150 | 1 | 0 | 2.2s |
| quiet contract | adaptive 100..10000 | 150 | 1 | 0 | 2.2s |

The page size grows while pages come back full and fast, halves on a slow page
or a failed request, and after a shrink will not grow back past the size that
was too much until 50 good pages in a row. In the timeout scenario, slow pages
shrink it before any request actually fails, which is why the error count stays
at zero.
