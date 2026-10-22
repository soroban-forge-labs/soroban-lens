# ADR-006: Retain raw XDR and never throw on decode

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Contracts can emit arbitrary ScVal shapes, including ones the current decoder
does not understand. The indexer must keep running and must let operators inspect
what the network actually emitted. RPC nodes eventually forget old ledgers, so
re-indexing after a decoder fix may be impossible.

## Decision

Store the original base64-encoded topics and value alongside decoded projections.
If decoding fails, store the row with `decodeError` set and the raw bytes intact;
never throw and never drop the event. Keep the decoded topic array authoritative
(`topics_json`) and use `topic0`–`topic3` only as indexed filter projections.

## Alternatives considered

- **Decode and discard raw bytes.** Saves disk, but makes decoder fixes
  unrecoverable once the RPC retention window passes and prevents the UI from
  showing the original payload.
- **Fail the batch on a malformed event.** One hostile or buggy contract would
  stall ingestion for every other event in the batch.
- **Quarantine table for failures.** Adds a second read path and schema for
  little benefit; the existing row already carries the error and raw bytes.

## Consequences

- Disk usage is higher than a decoded-only store.
- Decoding rules must normalise BigInt to decimal strings and bytes to hex so
  JSON can carry them; see `docs/architecture.md`.
- The UI can always show raw data, even when typed decoding fails.
- `redecode` can repair rows in place after a decoder change.

## References

- [`docs/architecture.md`](../architecture.md)
- `packages/store/src/decode.ts`
- `packages/store/src/schema.ts`
