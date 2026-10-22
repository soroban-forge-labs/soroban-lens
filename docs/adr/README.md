# Architecture decision records

Short records of decisions that shape soroban-lens, including the alternatives
that were rejected. Read these before reopening a settled design discussion.

| ADR | Decision |
|---|---|
| [001](001-sqlite-store.md) | SQLite is the v0.1 event store |
| [002](002-poll-getevents.md) | Poll `getEvents` instead of streaming |
| [003](003-duplicated-rawevent.md) | Keep `RawEvent` and `RawEventInput` duplicated |
| [004](004-at-least-once.md) | Deliver events at least once |
| [005](005-keyset-pagination.md) | Paginate by event id, never by offset |
| [006](006-raw-xdr.md) | Retain raw XDR and never throw on decode |
| [007](007-eventstore-trait.md) | The API depends on `EventStore`, not SQLite |
| [008](008-v01-boundaries.md) | v0.1 has no auth, one network per database, no deep backfill |

New records use [000-template.md](000-template.md). Copy it, number it with the
next free three-digit number, and open a PR. Superseding a decision means adding
a new ADR and marking the old one `Superseded by ADR-NNN`; do not rewrite
history in place.
