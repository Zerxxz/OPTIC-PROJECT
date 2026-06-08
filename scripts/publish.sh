#!/usr/bin/env bash
# ============================================================================
#  OPTIC · publish.sh
#  Publish the OPTIC Move package to Sui (testnet by default) and dump
#  the resulting PACKAGE_ID. Updates sdk/src/constants.ts and
#  orchestrator/.env with the new package id.
#
#  Usage:
#    ./scripts/publish.sh                  # testnet
#    ./scripts/publish.sh --network mainnet
#    ./scripts/publish.sh --network devnet --gas-budget 500000000
#
#  Requires: sui CLI in PATH and an active wallet with gas.
# ============================================================================
set -euo pipefail

NETWORK="testnet"
GAS_BUDGET=200_000_000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --gas-budget) GAS_BUDGET="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_DIR="$ROOT/contracts/optic"
SDK_CONSTANTS="$ROOT/sdk/src/constants.ts"
ORCH_ENV="$ROOT/orchestrator/.env"

echo "▶ Publishing OPTIC to $NETWORK (gas budget $GAS_BUDGET)"

cd "$CONTRACT_DIR"

# Build first so we fail fast on compile errors.
echo "  · sui move build"
sui move build --skip-fetch-latest-git-deps

# Publish; the --json flag is supported by sui CLI ≥1.30 and gives us
# the published-packages array deterministically.
echo "  · sui client publish"
RAW=$(sui client publish --json --gas-budget "$GAS_BUDGET" 2>&1)
echo "$RAW" | tail -3

# Extract PACKAGE_ID from the JSON. Different sui versions emit the
# package id under different keys; we try a few.
PACKAGE_ID=$(echo "$RAW" | python3 -c '
import json, sys, re
text = sys.stdin.read()
# Try parsing as JSON first
try:
    data = json.loads(text)
except Exception:
    # Older CLI prints a JSON object inside other text — find the first
    # top-level "packageId" or "package_id" or "published-at".
    m = re.search(r"\""(packageId|package_id|publishedAt|published_at)"\s*:\s*\""(0x[0-9a-f]+)\"", text)
    if m: print(m.group(2)); sys.exit(0)
    sys.exit(1)

# Walk common paths
def find_pkg(d):
    if isinstance(d, dict):
        for k, v in d.items():
            if k in ("packageId", "package_id", "publishedAt", "published_at") and isinstance(v, str) and v.startswith("0x"):
                return v
            r = find_pkg(v)
            if r: return r
    elif isinstance(d, list):
        for v in d:
            r = find_pkg(v)
            if r: return r
    return None

pkg = find_pkg(data)
if not pkg: sys.exit(2)
print(pkg)
' | tail -1)

if [[ -z "$PACKAGE_ID" || "$PACKAGE_ID" == "0x0" ]]; then
  echo "✗ Failed to extract PACKAGE_ID from publish output. Saving raw log."
  echo "$RAW" > "$ROOT/.publish.log"
  exit 1
fi

echo "  ✓ PACKAGE_ID=$PACKAGE_ID"

# Patch sdk constants
if [[ -f "$SDK_CONSTANTS" ]]; then
  python3 - "$SDK_CONSTANTS" "$PACKAGE_ID" <<'PY'
import sys, re
path, pkg = sys.argv[1], sys.argv[2]
with open(path) as f: src = f.read()
src = re.sub(r"export const PACKAGE_ID = \"[^\"]*\"", f'export const PACKAGE_ID = "{pkg}"', src)
with open(path, "w") as f: f.write(src)
print(f"  ✓ patched {path}")
PY
fi

# Patch orchestrator .env
mkdir -p "$(dirname "$ORCH_ENV")"
if [[ ! -f "$ORCH_ENV" ]]; then
  cat > "$ORCH_ENV" <<EOF
OPTIC_PACKAGE_ID=$PACKAGE_ID
OPTIC_NETWORK=$NETWORK
OPTIC_REGISTRY_ID=
OPTIC_AGENT_ID=
OPTIC_TREASURY_ID=
EOF
else
  python3 - "$ORCH_ENV" "$PACKAGE_ID" "$NETWORK" <<'PY'
import sys
path, pkg, net = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
have_pkg = have_net = False
out = []
for ln in lines:
    if ln.startswith("OPTIC_PACKAGE_ID="): out.append(f"OPTIC_PACKAGE_ID={pkg}"); have_pkg = True
    elif ln.startswith("OPTIC_NETWORK="): out.append(f"OPTIC_NETWORK={net}"); have_net = True
    else: out.append(ln)
if not have_pkg: out.append(f"OPTIC_PACKAGE_ID={pkg}")
if not have_net: out.append(f"OPTIC_NETWORK={net}")
with open(path, "w") as f: f.write("\n".join(out) + "\n")
print(f"  ✓ patched {path}")
PY
fi

echo "▶ Done. Append-only record:"
echo "  PACKAGE_ID=$PACKAGE_ID  NETWORK=$NETWORK" >> "$ROOT/.publish.log"
echo "  $(date -Iseconds)" >> "$ROOT/.publish.log"
echo "  --" >> "$ROOT/.publish.log"
cat "$ROOT/.publish.log" | tail -6
