#!/usr/bin/env bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DB_PATH="./data/lens.db"
API_PORT="${LENS_API_PORT:-8080}"
VITE_PORT="${VITE_PORT:-5173}"
PIDS=()

# Cleanup function to kill all background processes
cleanup() {
  echo -e "\n${YELLOW}Stopping all processes...${NC}"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "${PIDS[@]}" 2>/dev/null || true
  echo -e "${GREEN}All processes stopped.${NC}"
  exit 0
}

# Set trap to cleanup on Ctrl-C
trap cleanup SIGINT SIGTERM

echo -e "${GREEN}Building all packages...${NC}"
npm run build --workspaces --if-present

echo -e "${GREEN}Checking if database needs seeding...${NC}"
if [ ! -f "$DB_PATH" ]; then
  echo -e "${YELLOW}No database found at $DB_PATH, seeding...${NC}"
  npm run seed
else
  echo -e "${GREEN}Database already exists, skipping seed.${NC}"
fi

echo -e "${GREEN}Starting TypeScript watch mode for packages...${NC}"
# Start watch mode for backend packages only (web uses Vite which handles TS automatically)
for workspace in packages/ingest packages/store packages/api packages/cli; do
  npm run watch --workspace "$workspace" &
  PIDS+=($!)
done
sleep 2  # Give watch mode time to start

echo -e "${GREEN}Starting API server on port $API_PORT...${NC}"
npm run api &
API_PID=$!
PIDS+=($API_PID)
sleep 2  # Give API time to start

echo -e "${GREEN}Starting Vite dev server on port $VITE_PORT...${NC}"
npm run web &
WEB_PID=$!
PIDS+=($WEB_PID)

echo -e "${GREEN}✓ Development environment is ready!${NC}"
echo -e "${YELLOW}API: http://localhost:$API_PORT${NC}"
echo -e "${YELLOW}Web: http://localhost:$VITE_PORT${NC}"
echo -e "${YELLOW}Press Ctrl-C to stop all processes.${NC}"

# Wait for all background processes
wait
