# `@soroban-lens/web` — Module 4: Web UI

Owner: **Person D**

Single-page explorer. Type a contract id, watch its events arrive, click one to
see the decoded payload. Read-only, no authentication in v0.1.

## Deliverable

```bash
# 1. an API with data behind it
npm run seed                                     # loads fixtures/testnet-events.json
node packages/api/dist/bin.js --db ./data/lens.db --port 8080 &

# 2. the UI
npm run dev -w @soroban-lens/web                 # http://localhost:5173
```

Click **use the testnet XLM contract** to jump straight to a contract that is
always emitting.

## What it does

- **Shareable URLs** — contract, topic, network, and expanded-event state all
  live in the query string. Copy the address bar, paste it in a fresh browser,
  and the exact same view appears. The `/events/{eventId}` path is a clean deep
  link that opens that event expanded, with the current filters preserved.
- **Back/forward navigation** — filter changes push a new history entry; expanding
  or collapsing an event replaces the current entry. Back moves through filter
  history, not through every row you ever clicked. A bare visit (no query params)
  falls back to whatever was last saved in `localStorage`.
- **Contract filter** — paste a contract id; the id is validated against the
  StrKey shape before a request goes out, so a typo is a message rather than a
  400 from the server.
- **Topic filter** — type one, or click any topic chip in the table. Known
  topics for the current contract populate a `<datalist>`, so the field
  autocompletes from what has actually been indexed.
- **Live updates** — streamed over the API's `GET /events/stream` (Server-Sent Events). When the stream is not open — before it connects, while the browser retries a dropped connection, or against an API without it — it falls back to polling every 5 seconds, which pauses while the tab is hidden.
- **Expandable rows** — click a row for decoded topics and value, plus the raw
  XDR the decoding came from, under a disclosure. The expanded event is part of
  the URL, so a colleague can open the same view.
- **Network switcher** — selects between configured API instances.
- **Load more** — keyset pagination via the API's `nextCursor`.

Theme stays in `localStorage` (not the URL); everything else is in the address
bar.

## URL structure

The address bar is the source of truth for the current view. Two shapes:

```
/?contract=C…&topic=transfer&successfulOnly=true&live=false&network=testnet
/events/0020166232959352832-0000000000?contract=C…&network=testnet
```

| Param | Default | Notes |
|---|---|---|
| `contract` | *(empty)* | StrKey contract id; empty means all indexed contracts |
| `topic` | *(empty)* | Topic prefix to filter on |
| `successfulOnly` | `false` | Only sent when `true` |
| `live` | `true` | Only sent when `false` |
| `network` | first configured network | The API instance label |

Only non-default values are written, so a shared URL stays short. The
`/events/{eventId}` path opens that event expanded; the query params carry the
filters so the surrounding table shows the right context.

A bare visit (no query params and no `/events/{id}` path) falls back to the
last-used filters and network from `localStorage`, so returning to the explorer
without a shared link picks up where you left off.

## Configuration

Vite bakes `VITE_*` variables in **at build time**, not at runtime.

```bash
# one network
VITE_LENS_API_URL=http://localhost:8080

# several — a JSON object of { label: apiBaseUrl }
VITE_LENS_NETWORKS='{"testnet":"http://localhost:8080","mainnet":"http://localhost:8081"}'
```

Each network is a **separate API instance**, because one database holds events
from exactly one network. The switcher changes which API the UI talks to; it
does not ask one API for a different network.

The status bar compares the network you picked against the one `/health`
reports and warns if they disagree — a misconfigured compose file that serves
testnet data under a "mainnet" label is otherwise invisible, and that is exactly
the kind of mistake worth shouting about.

## Notes for whoever works on this next

**Decoded integers are strings.** `event.value.value` for an `i128` is
`"4300000000"`. `Number()` on it will silently lose precision on large
transfers — use `BigInt`. Decoded `bytes` are hex strings.

**Types are hand-written** in [`src/types.ts`](./src/types.ts), mirroring
`packages/api/openapi.json`. That keeps the UI free of a build dependency on
the API package. If you would rather generate them, the spec is right there.

**In-flight responses are versioned** by a request counter, so a slow earlier
request cannot overwrite a newer one when filters change quickly.

**In production the bundle is served by nginx**, not by Vite. `npm run dev` and
`npm run preview` are for local work; `deploy/Dockerfile.web` builds `dist/` and
hands it to a static server.

**No design system**, by project constraint — the CSS is hand-written in
[`src/styles.css`](./src/styles.css). Light and dark themes: dark follows the system
setting unless the header toggle overrides it; the choice is saved in `localStorage`.

## Tests

`npm test -w @soroban-lens/web` runs the production build, which type-checks
every component under `strict` with `noUnusedLocals`. There is no component test
runner in v0.1 — adding one is [ISSUES.md #62](../../ISSUES.md), and it is the
most valuable thing anyone could contribute to this module.
