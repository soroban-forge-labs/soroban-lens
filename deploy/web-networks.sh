#!/bin/sh
# Write /networks.json for the UI's network switcher, at container start (#82).
#
# Run by the nginx image's entrypoint (it executes /docker-entrypoint.d/*.sh).
# The bundle's VITE_LENS_NETWORKS is fixed at build time, so it cannot know
# whether `docker compose --profile mainnet` started a second API; this can.
#
#   LENS_WEB_NETWORKS           {"label":"browser URL",...} always listed.
#   LENS_WEB_OPTIONAL_NETWORKS  space-separated label|browserUrl|probeUrl.
#                               Listed only if probeUrl answers right now.
#
# The probe URL is the in-network address (http://api-mainnet:8080/health);
# the browser URL is what the user's browser can reach (http://localhost:8081).
# They differ because the browser is not on the compose network.
#
# With neither variable set nothing is written, and the UI keeps the list it
# was built with.
set -eu

out_dir=${LENS_WEB_NETWORKS_DIR:-/tmp/lens}
out="$out_dir/networks.json"
mkdir -p "$out_dir"
rm -f "$out"

base="${LENS_WEB_NETWORKS:-}"
optional="${LENS_WEB_OPTIONAL_NETWORKS:-}"
[ -z "$base" ] && [ -z "$optional" ] && exit 0

# Start from the base object without its closing brace, so optional entries can
# be appended. An empty or missing base is an empty object.
[ -z "$base" ] && base='{}'
body=$(printf '%s' "$base" | sed 's/^[[:space:]]*{//; s/}[[:space:]]*$//')

for entry in $optional; do
  label=${entry%%|*}
  rest=${entry#*|}
  browser=${rest%%|*}
  probe=${rest#*|}
  if wget -q -T 3 -O /dev/null "$probe" 2>/dev/null; then
    [ -n "$(printf '%s' "$body" | tr -d '[:space:]')" ] && body="$body,"
    body="$body\"$label\":\"$browser\""
    echo "lens: network \"$label\" is up ($probe), listing it as $browser"
  else
    echo "lens: network \"$label\" did not answer at $probe, leaving it out"
  fi
done

printf '{%s}\n' "$body" > "$out"
echo "lens: wrote $out: $(cat "$out")"
