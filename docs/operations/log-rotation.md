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
   ```bash
   sudo logrotate -d /etc/logrotate.d/soroban-lens
   ```

3. Journald retention settings in `/etc/systemd/journald.conf`:
   ```ini
   [Journal]
   SystemMaxUse=2G
   SystemMaxFileSize=100M
   MaxRetentionSec=14day
   ```
