# Log Rotation and Retention Guidance

This guide details best practices for managing log files produced by Soroban Lens indexer, API server, and web dashboard across containerized and bare-metal deployments.

## 1. Docker & Docker Compose Logging

When using `docker compose`, configure Docker daemon or compose service logging drivers to prevent unbounded container log growth on disk.

Add a `logging` block to your `docker-compose.yml`:

```yaml
services:
  indexer:
    # ...
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"

  api:
    # ...
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"
```

## 2. Linux Systemd / Logrotate

For bare-metal and systemd setups:

1. Copy the logrotate policy into `/etc/logrotate.d/`:
   ```bash
   sudo cp deploy/logrotate/soroban-lens /etc/logrotate.d/soroban-lens
   sudo chown root:root /etc/logrotate.d/soroban-lens
   sudo chmod 644 /etc/logrotate.d/soroban-lens
   ```

2. Test logrotate execution:
   ``bash
   sudo logrotate -d /etc/logrotate.d/soroban-lens
   ```

3. Journald retention settings in `/etc/systemd/journald.conf`:
   ```ini
   [Journal]
   SystemMaxUse=2G
   SystemMaxFileSize=100M
   MaxRetentionSec=14day
   ```

## 3. Database Retention by Size

Pruning by ledger count only is often not enough: operators care about disk usage, not how many ledgers are stored. Soroban Lens supports an optional size target that prunes the oldest ledgers in chunks until the database fits within the configured budget.

The target is compared against `sizeBytes + walSizeBytes` (the main database file plus the Write-Ahead Log). When the combined size exceeds the target, the indexer prunes the oldest ledgers in chunks until the size is under the target, then checkpoints the database to reclaim space. The prune is run on an interval from the indexer, and the number of removed ledgers and bytes is logged.

### Configuration

Add the size target to your indexer configuration (env or config file):

```bash
# Target maximum combined size of the database + WAL, e.g. 20 GB
SOROBAN_LENS_DB_SIZE_TARGET_BYTES=20000000000

# How often to check the size target (Go duration string)
SOROBAN_LENS_DB_PRINE_INTERVAL=5m

# How many ledgers to remove per chunk when pruning
SOROBAN_LENS_DB_PRINE_CHUNK_SIZE=1000
```

Leave `SOROBAN_LENS_DB_SIZE_TARGET_BYTES` unset (or zero) to disable size-based pruning and keep the existing ledger-based retention behavior.

### Behavior

- The size check runs on the configured interval from the indexer.
- When `sizeBytes + walSizeBytes` exceeds the target, the oldest ledgers are pruned in chunks of `SOROBAN_LENS_DB_PRINE_CHUNK_SIZE`.
- After each chunk, the database is checkpointed and the size is re-measured. Pruning stops as soon as the combined size is under the target.
- Each run logs the number of ledgers removed, the bytes reclaimed, and the resulting size.

### Example log output

```
indexer | db-retention: size target exceeded (sizeBytes=21000000000, walSizeBytes=200000000, targetBytes=20000000000)
indexer | db-retention: pruned chunk of 1000 ledgers (1000-1999), reclaimed 120000000 bytes
indexer | db-retention: checkpoint complete, sizeBytes=19800000000, walSizeBytes=150000000, targetBytes=20000000000
indexer | db-retention: size target met after removing 1000 ledgers; total reclaimed 120000000 bytes
```
