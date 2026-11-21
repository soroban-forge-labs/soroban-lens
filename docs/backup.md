# Backup and restore

Re-indexing cannot recover anything older than the RPC's retention window
(about seven days on testnet). Past that, a lost database is lost data, so back
it up.

## What a backup is

`lens backup <path>` writes a complete copy of the SQLite database: events,
the indexer's stream cursors, contract specs and the schema version. It uses
SQLite's `VACUUM INTO`, which reads one consistent snapshot, so it is **safe to
run while the indexer is writing**. You do not need to stop anything.

Restoring one gives you a working instance that resumes indexing from the
cursor saved in the backup. Events between the backup and now are re-fetched
from the RPC, as long as they are still inside its retention window.

`lens export` (NDJSON) is different. It is portable between backends (#37), but
it holds events only, with no cursor and no specs. Use `backup` for disaster
recovery and `export` for moving to Postgres or another tool.

## Locally

```bash
# Take one (indexer may keep running)
npm run lens -- backup backups/lens-$(date +%Y%m%d-%H%M).db

# Restore: stop the indexer and API first, so nothing holds the old file
npm run lens -- restore backups/lens-20261121-0900.db --force
npm run lens -- verify
npm run index
```

`restore` checks the backup before touching anything. It must open, pass the
row-invariant check, and hold a schema this build can read. An older schema is
fine, since it migrates forward on first open. It then copies to a temporary name
beside the database and renames it into place, and removes the old `-wal`/`-shm`
sidecars. Without `--force` it refuses to replace an existing database.
`backup` never overwrites an existing file.

## Docker volume

The database lives in the `lens-data` volume at `/app/data/lens.db`.

```bash
# Back up while running, then copy it out of the volume
docker compose exec indexer node packages/cli/dist/bin.js backup /app/data/backup.db
docker compose cp indexer:/app/data/backup.db ./lens-backup-$(date +%Y%m%d).db
docker compose exec indexer rm /app/data/backup.db

# Restore into the volume
docker compose stop indexer api
docker compose run --rm -v "$PWD:/restore:ro" --entrypoint node indexer \
  packages/cli/dist/bin.js restore /restore/lens-backup-20261121.db --force
docker compose start indexer api
```

For the mainnet profile, use `indexer-mainnet` / `api-mainnet` and the
`lens-data-mainnet` volume the same way.

## Schedule it

A daily backup with a week of history, from cron on the host:

```cron
15 3 * * * cd /srv/soroban-lens && npm run --silent lens -- backup backups/lens-$(date +\%a).db.tmp && mv backups/lens-$(date +\%a).db.tmp backups/lens-$(date +\%a).db
```

Naming by weekday keeps seven files. `backup` refuses to overwrite, so the job
writes to a `.tmp` name and moves it over last week's file only once the new
backup has finished.

## Check that it works

A backup you have never restored is a hope. Once, on a spare path:

```bash
npm run lens -- restore backups/lens-Mon.db --db /tmp/restore-test.db
npm run lens -- stats --db /tmp/restore-test.db
```
