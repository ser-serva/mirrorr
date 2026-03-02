#!/usr/bin/env bash
# reset.sh — Wipe mirrorr dev persistence and optionally bring the stack back up.
#
# Usage:
#   ./reset.sh              # reset only (leave stack down)
#   ./reset.sh --up         # reset + start infra (temporal + postgres)
#   ./reset.sh --up-dev     # reset + start full dev stack (--profile dev)
#   ./reset.sh --help
#
# What gets wiped:
#   - SQLite database (apps/backend/data/mirrorr.db*)
#   - Temporal/Postgres Docker named volume (dev_postgres_data)
#
# What is preserved:
#   - cookies/             (TikTok auth cookies)
#   - node_modules volumes (pkgs_*, root_nm, backend_nm, turbo_cache)
#   - Firefox profile volume
#   - .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="docker compose -f $SCRIPT_DIR/compose.yaml"
DB_DIR="$REPO_ROOT/apps/backend/data"
POSTGRES_VOLUME="dev_postgres_data"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

usage() {
  grep '^#' "$0" | sed 's/^# \?//' | head -20
  exit 0
}

[[ "${1:-}" == "--help" ]] && usage

UP_MODE="${1:-}"
case "$UP_MODE" in
  ""| --up | --up-dev) ;;
  *) echo -e "${RED}Unknown option: $UP_MODE${NC}"; usage ;;
esac

echo -e "${YELLOW}▶ Stopping all mirrorr dev containers...${NC}"
$COMPOSE --profile dev down 2>/dev/null || true
$COMPOSE down 2>/dev/null || true

echo -e "${YELLOW}▶ Removing SQLite database...${NC}"
rm -f "$DB_DIR/mirrorr.db" "$DB_DIR/mirrorr.db-shm" "$DB_DIR/mirrorr.db-wal"
echo "   Removed: $DB_DIR/mirrorr.db*"

echo -e "${YELLOW}▶ Removing Temporal/Postgres volume ($POSTGRES_VOLUME)...${NC}"
if docker volume inspect "$POSTGRES_VOLUME" &>/dev/null; then
  docker volume rm "$POSTGRES_VOLUME"
  echo "   Volume removed."
else
  echo "   Volume not found — already clean."
fi

echo -e "${GREEN}✓ Reset complete.${NC}"
echo "  Preserved: cookies/, node_modules volumes, firefox profile"

if [[ "$UP_MODE" == "--up" ]]; then
  echo ""
  echo -e "${YELLOW}▶ Starting infra (temporal + postgres)...${NC}"
  $COMPOSE up -d
  echo ""
  echo -e "${GREEN}✓ Infra up. Start backend/worker on host:${NC}"
  echo "   pnpm --filter backend dev"
  echo "   pnpm --filter backend worker:dev"

elif [[ "$UP_MODE" == "--up-dev" ]]; then
  echo ""
  echo -e "${YELLOW}▶ Starting full dev stack (--profile dev)...${NC}"
  $COMPOSE --profile dev up -d
  echo ""
  echo -e "${GREEN}✓ Full dev stack up (app + worker containers + VPN).${NC}"
fi
