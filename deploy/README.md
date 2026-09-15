# `deploy/` — images and compose

Owner: **Person E** (Module 5)

## Files

| File | What it builds |
|---|---|
| `Dockerfile.node` | Shared image for `doctor`, `indexer` and `api` |
| `Dockerfile.web` | The UI: Vite build stage, then a static nginx stage |
| `web-nginx.conf` | nginx config for the UI — SPA fallback and cache headers |
| `../docker-compose.yml` | All four services plus the data volume |

## Running

```bash
cp .env.example .env
docker compose up                 # http://localhost:5173
docker compose up -d --build      # rebuild and detach
docker compose logs -f indexer
docker compose down -v            # stop and drop all indexed data
```

## How the services relate

```
doctor ──(must exit 0)──▶ indexer ──┐
                                    ├──▶ lens-data volume
                      ──▶ api ──────┘
                            │
                            └──(healthy)──▶ web
```

`doctor` is a one-shot preflight. `indexer` and `api` wait on
`service_completed_successfully`, so a bad RPC URL or an unwritable volume
stops the stack at a clear error rather than at three confusing ones.

## Things that are easy to get wrong here

**`Dockerfile.node` installs only the four Node workspaces**, skipping the web
app's large dev dependencies. The web image is separate.

**The web image bakes its API URL at build time.** Vite inlines `VITE_*`
variables into the bundle; it does not read them at runtime. Changing
`LENS_WEB_NETWORKS` means `docker compose build web`, not a restart. This is the
single most common confusion with this setup.

**The API URL is a browser URL.** It is `http://localhost:8080` — the host's
port mapping — not `http://api:8080`. The compose service name only resolves
inside the compose network, and the browser is not in it.

**The API volume cannot be read-only.** The API only reads events, but SQLite
in WAL mode writes `-wal` and `-shm` sidecars even for readers.

**Nothing runs as root.** The Node services run as the image's unprivileged
`node` user; the web image is `nginx-unprivileged`, which runs as uid 101 and
listens on 8080 (compose maps it to 5173 on the host). Running as root would
also leave root-owned files behind on a bind mount.

**The web image does not ship Node.** It is a two-stage build: Node produces
`dist/`, then a static nginx image serves it. `vite preview` is a development
server and is deliberately not used — besides being the wrong tool, it needs to
write into `node_modules` at startup, which fails outright in a container that
does not run as root.

**Port 5173 is a common default.** If another Vite project is already running
on your machine, set `LENS_WEB_PORT` to something else rather than fighting
over it.

## Node version

Images use **Node 26**. The floor is **22.12**, where `node:sqlite` became
available — using the built-in driver is what keeps these images free of a
native build toolchain. CI tests against 22.12 and 24.
