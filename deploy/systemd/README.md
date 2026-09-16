# Systemd Service Units for Soroban Lens

This directory contains systemd service unit files to run Soroban Lens services on Linux servers (Ubuntu, Debian, RHEL, Rocky, Fedora).

## Services Included

- **`lens-api.service`**: Fastify REST & WebSocket API daemon.
- **`lens-indexer.service`**: Soroban event & ledger polling indexer daemon.
- **`lens-web.service`**: Web dashboard frontend server.

## Installation

1. Create a dedicated system user and directories:
   ```bash
   sudo useradd -r -s /bin/false soroban-lens
   sudo mkdir -p /var/lib/soroban-lens /etc/soroban-lens /opt/soroban-lens
   sudo chown -R soroban-lens:soroban-lens /var/lib/soroban-lens /opt/soroban-lens
   ```

2. Copy the unit files into systemd directory:
   ```bash
   sudo cp deploy/systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

3. Enable and start services:
   ```bash
   sudo systemctl enable --now lens-api lens-indexer lens-web
   ```

4. Check status and logs:
   ```bash
   sudo systemctl status lens-api
   sudo journalctl -u lens-api -f
   sudo journalctl -u lens-indexer -f
   ```
