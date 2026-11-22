#!/usr/bin/env bash
# Build the documentation site (#100) into site/dist.
#
#   bash site/build.sh            # then: npx --yes vitepress@1.6.4 preview site
#
# Two tools, both pinned and run through npx so neither becomes a dependency
# of the project (the same way CI already runs @redocly/cli for linting):
#   - VitePress renders the repo's markdown, in place, with local search;
#   - Redocly renders packages/api/openapi.json — the file the API serves at
#     /openapi.json — as the API reference at /api/.
set -euo pipefail
cd "$(dirname "$0")/.."

npx --yes vitepress@1.6.4 build site
mkdir -p site/dist/api
npx --yes @redocly/cli@2.53.2 build-docs packages/api/openapi.json \
  --output site/dist/api/index.html \
  --title "soroban-lens API reference"
echo "site built in site/dist"
