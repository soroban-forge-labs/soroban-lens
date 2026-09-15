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

- **Contract filter** — paste a contract id; the id is validated against the
  StrKey shape before a request goes out, so a typo is a message rather than a
  400 from the server.
- **Topic filter** — type one, or click any topic chip in the table. Known
  topics for the current contract populate a `<datalist>`, so the field
  autocompletes from what has actually been indexed.
- **Live updates** — polls every 5 seconds, and pauses while the tab is hidden.
- **Expandable rows** — click a row for decoded topics and value, plus the raw
  XDR the decoding came from, under a disclosure.
- **Network switcher** — selects between configured API instances.
- **Load more** — keyset pagination via the API's `nextCursor`.

Filters and the selected network persist in `localStorage`.

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
[`src/styles.css`](./src/styles.css). Light theme only; dark mode is a tracked
issue.

## Tests

`npm test -w @soroban-lens/web` runs the production build, which type-checks
every component under `strict` with `noUnusedLocals`. There is no component test
runner in v0.1 — adding one is a tracked issue, and it is the most valuable
thing anyone could contribute to this module.
