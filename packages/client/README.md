# @soroban-lens/client

Typed TypeScript client for the soroban-lens query API.

```ts
import { createLensClient } from '@soroban-lens/client';

const lens = createLensClient('http://localhost:8080');
const { data, error } = await lens.GET('/contracts/{contractId}/events', {
  params: { path: { contractId }, query: { limit: 50 } },
});
```

Request parameters and response bodies are typed from
[`packages/api/openapi.json`](../api/openapi.json).

## Timeouts, retries and cancellation

Every method accepts an optional `signal` so a request can be cancelled, and
the client applies a default timeout so a hung API call cannot hang the caller
forever.

```ts
const lens = createLensClient('http://localhost:8080', {
  // Client-wide default timeout in milliseconds (default: 30_000).
  timeoutMs: 10_000,
  // Retry configuration for idempotent GETs (default: 3 attempts).
  retries: {
    attempts: 3, // set to 0 to disable retries
    baseDelayMs: 250, // exponential backoff base
    maxDelayMs: 5_000, // cap on any single backoff delay
  },
});

const controller = new AbortController();
const { data, error } = await lens.GET('/contracts/{contractId}/events', {
  params: { path: { contractId } },
  signal: controller.signal,
  // Per-request override of the client-wide timeout.
  timeoutMs: 2_000,
});
```

Idempotent `GET` requests are retried on network errors, `429` and `503`
responses with exponential backoff. When the API sends a `Retry-After` header
(seconds or an HTTP date), that delay is honoured instead of the computed
backoff. Non-idempotent methods are never retried automatically.

## How it is built

The generated types are not committed. `npm run build` here:

1. generates `src/schema.d.ts` from the spec with `openapi-typescript`;
2. checks that this package's `version` equals the spec's `info.version`;
3. compiles `src/index.ts` against the generated types.

If the spec changes in a way `src/index.ts` no longer fits, or the versions
drift, the build fails. The `client` job in `.github/workflows/ci.yml` runs this
on every change.

This package sits outside the root npm workspaces so it does not affect the
root lockfile; install and build it from this directory.
