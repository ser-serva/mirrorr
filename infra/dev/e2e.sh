#!/usr/bin/env bash
# e2e.sh — Full account mirroring E2E for mirrorr dev.
#
# Usage:
#   ./e2e.sh <tiktok-handle>       # e.g. ./e2e.sh aaronparnas1
#
# Runs:
#   1. Login to mirrorr API
#   2. Create TikTok source
#   3. Create Loops Dev target
#   4. Test target connectivity
#   5. Create creator with auto-provisioning
#   6. PATCH creator: verify already-provisioned guard (409 expected)
#   7. List creators (confirm final state)
#
# Requires:
#   - mirrorr backend running on localhost:4001
#   - loops-dev stack running and accessible
#   - infra/dev/.env with LOOPS_API_TOKEN set

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE=http://localhost:4001
MC=/tmp/mirrorr_e2e_cookies.txt
ENV_FILE="$SCRIPT_DIR/.env"
HANDLE="${1:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
step() { echo -e "\n${CYAN}=== $* ===${NC}"; }
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
fail() { echo -e "${RED}✗ $*${NC}"; exit 1; }

[[ -z "$HANDLE" ]] && { echo "Usage: $0 <tiktok-handle>"; exit 1; }
HANDLE="${HANDLE#@}"  # strip leading @ if present

echo -e "${YELLOW}▶ E2E: account mirroring for @$HANDLE${NC}"

# ── 1. Login ──────────────────────────────────────────────────────────────────
step "1. Login"
rm -f "$MC"
R=$(curl -s -c "$MC" "$BASE/login" -H 'Content-Type: application/json' -d '{"password":"TestPassword123!"}')
echo "$R"
echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('ok') else 1)" || fail "Login failed"
ok "Logged in"

# ── 2. Create TikTok source ────────────────────────────────────────────────────
step "2. Create TikTok source"
R=$(curl -s -b "$MC" "$BASE/api/sources" -H 'Content-Type: application/json' -d '{"name":"TikTok","type":"tiktok"}')
echo "$R" | python3 -m json.tool
SOURCE_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
ok "Source id=$SOURCE_ID"

# ── 3. Create Loops Dev target ─────────────────────────────────────────────────
step "3. Create Loops Dev target"
LOOPS_TOKEN=$(grep '^LOOPS_API_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
R=$(curl -s -b "$MC" "$BASE/api/targets" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Loops Dev\",\"type\":\"loops\",\"url\":\"https://loops-dev.apps.servahome.org\",\"apiToken\":\"$LOOPS_TOKEN\"}")
echo "$R" | python3 -m json.tool
TARGET_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
ok "Target id=$TARGET_ID"

# ── 4. Test target connectivity ───────────────────────────────────────────────
step "4. Test target connectivity"
R=$(curl -s -b "$MC" -X POST "$BASE/api/targets/$TARGET_ID/test")
echo "$R" | python3 -m json.tool
echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('ok') else 1)" || fail "Target test failed"
ok "Target connected"

# ── 5. Create creator (auto-provisions mirror account) ────────────────────────
step "5. Create creator @$HANDLE (auto-provision mirror)"
R=$(curl -s -b "$MC" "$BASE/api/creators" \
  -H 'Content-Type: application/json' \
  -d "{\"handle\":\"$HANDLE\",\"sourceId\":$SOURCE_ID,\"targetId\":$TARGET_ID,\"maxBacklog\":5,\"initialSyncWindowDays\":30}")
echo "$R" | python3 -m json.tool
CREATOR_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
MIRROR_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mirrorTargetId','null'))")
ok "Creator id=$CREATOR_ID  mirrorTargetId=$MIRROR_ID"
[[ "$MIRROR_ID" != "null" && "$MIRROR_ID" != "None" ]] || fail "Mirror was not provisioned during creator creation"

# ── 6. PATCH guard: re-provisioning should 409 ───────────────────────────────
step "6. PATCH guard (re-provision should return 409)"
R=$(curl -s -b "$MC" -X PATCH "$BASE/api/creators/$CREATOR_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"targetId\":$TARGET_ID}")
echo "$R" | python3 -m json.tool
echo "$R" | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert 'already has a mirror' in d.get('error',''), f'Expected 409 guard, got: {d}'
" || fail "Expected 409 guard to fire"
ok "409 guard correct — cannot re-provision existing mirror"

# ── 7. Final state ────────────────────────────────────────────────────────────
step "7. Final creator state (list)"
curl -s -b "$MC" "$BASE/api/creators" | python3 -m json.tool

# ── 8. Confirm on Loops (DB check hint) ───────────────────────────────────────
MIRROR_USERNAME="${HANDLE:0:17}.tiktok"
echo ""
echo -e "${YELLOW}Expected Loops username: $MIRROR_USERNAME${NC}"
echo "Verify with:"
echo "  docker exec loops_dev_db mysql -uloops_admin -pdev_password loops_dev -e \"SELECT id,username,email FROM users WHERE username='$MIRROR_USERNAME';\""

echo -e "\n${GREEN}✓ E2E complete for @$HANDLE${NC}"
