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

**`Dockerfile.node` is a two-stage build.** The builder installs dev
dependencies and compiles the four Node workspaces. The runtime stage installs
only production dependencies and copies only `dist/`, `packages/api/openapi.json`
and the fixtures used by `lens seed`. The web app has its own image, so its large
dev dependencies are never installed here.

**The web image bakes most of its config at build time.** Vite inlines `VITE_*`
variables into the bundle; it does not read them at runtime. Changing the
optional `LENS_WEB_EXPLORERS` block-explorer map means `docker compose build web`,
not a restart. The network list is the exception: `deploy/web-networks.sh` runs
when the container starts and writes `/networks.json` from `LENS_WEB_NETWORKS`,
which the UI prefers over the baked-in list — so a network change is
`docker compose up -d web`, no rebuild.

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

Images use **Node 26**. The floor is **22.13**, the version where `node:sqlite`
stopped requiring `--experimental-sqlite` (it was added behind that flag back in
22.5). Using the built-in driver is what keeps these images free of a native
build toolchain. CI tests against 22.13 and 24.

## Cloud deploy (Terraform)

`terraform/aws/` is a module that runs the compose stack on one EC2 instance
with a persistent EBS volume, a dedicated VPC and secrets in SSM Parameter
Store. `terraform/examples/aws/` is a ready-to-apply root. See
[`terraform/aws/README.md`](terraform/aws/README.md).

## Testnet and mainnet side by side

```bash
LENS_MAINNET_RPC_URL=https://your-mainnet-rpc docker compose --profile mainnet up
```

The `mainnet` profile adds a second, independent pipeline — `doctor-mainnet`,
`indexer-mainnet`, `api-mainnet` — on its own `lens-data-mainnet` volume, with
the API on port `8081` (`LENS_MAINNET_API_PORT`). One database holds one
network's events, so the two never share a volume.

The UI's network switcher gets both entries without a rebuild. `web` waits for
`api-mainnet` to be healthy when the profile is on (`depends_on` with
`required: false`, so Compose 2.20 or newer), and `web-networks.sh` lists
mainnet only if `http://api-mainnet:8080/health` answers at that moment. Without
the profile, nothing answers and the switcher shows testnet alone.

**Mainnet needs your RPC.** There is no free public mainnet RPC with useful
retention, so `LENS_MAINNET_RPC_URL` is required — set it in `.env` or the
environment. Without it `doctor-mainnet` fails, says exactly this, and the
mainnet indexer and API do not start; the testnet stack is unaffected.
`LENS_MAINNET_RPC_HEADERS` carries a provider API key, the same way
`LENS_RPC_HEADERS` does for testnet.

The mainnet pair watches mainnet's native XLM contract by default
(`LENS_MAINNET_CONTRACT_IDS`); set your own contracts before leaving it running.

## Released images

Each `v*.*.*` tag runs `.github/workflows/release.yml`. It builds
`ghcr.io/soroban-forge-labs/soroban-lens-node` and `-web` for amd64 and arm64,
publishes the npm packages at that exact version, and creates a GitHub release
with a changelog from the commit subjects, `openapi.json`, and a
`docker-compose.release.yml` pinned to that version.

To run a release without cloning:

```bash
curl -LO https://github.com/soroban-forge-labs/soroban-lens/releases/latest/download/docker-compose.release.yml
docker compose -f docker-compose.release.yml up -d
```

Set `LENS_VERSION=0.2.0` to pin or roll back. The published web bundle talks to
`http://localhost:8080`. Pointing it anywhere else means building the web image
from source, as above.

Maintainers cutting a release: `git tag v0.2.0 && git push origin v0.2.0`.
npm publishing needs an `NPM_TOKEN` repository secret and is skipped with a
warning without one. Images and the GitHub release need nothing extra.
