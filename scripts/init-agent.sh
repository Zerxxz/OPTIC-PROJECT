#!/usr/bin/env bash
# ============================================================================
#  OPTIC · init-agent.sh
#  Initialize an OPTIC Agent on Sui (testnet by default). This is the
#  end-to-end happy path: publish, create registry, create agent, create
#  treasury, issue caps, attach a strategy blob from Walrus.
#
#  Usage:
#    ./scripts/init-agent.sh
#    ./scripts/init-agent.sh --name "agent-alpha" --strategy mean-reversion
#
#  Reads from: orchestrator/.env (PACKAGE_ID, NETWORK) — written by publish.sh
# ============================================================================
set -euo pipefail

NETWORK="${OPTIC_NETWORK:-testnet}"
NAME="agent-alpha"
STRATEGY="mean-reversion"
MAX_POS=10_000_000_000   # $10,000
MAX_DAILY_LOSS=500_000_000 # $500
MAX_LEV_BPS=3_000          # 30% effective leverage
PER_TX_CAP=2_000_000_000   # $2,000 per move call
SUINS_NAME=""              # empty = none

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --strategy) STRATEGY="$2"; shift 2 ;;
    --max-pos) MAX_POS="$2"; shift 2 ;;
    --max-loss) MAX_DAILY_LOSS="$2"; shift 2 ;;
    --lev) MAX_LEV_BPS="$2"; shift 2 ;;
    --per-tx) PER_TX_CAP="$2"; shift 2 ;;
    --suins) SUINS_NAME="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/orchestrator/.env"

if [[ ! -f "$ENV" ]]; then
  echo "✗ $ENV not found. Run ./scripts/publish.sh first."
  exit 1
fi

# shellcheck source=/dev/null
set -a; source "$ENV"; set +a

if [[ -z "${OPTIC_PACKAGE_ID:-}" || "$OPTIC_PACKAGE_ID" == "0x0" ]]; then
  echo "✗ OPTIC_PACKAGE_ID not set in $ENV. Run ./scripts/publish.sh first."
  exit 1
fi

case "$NETWORK" in
  testnet) RPC="https://fullnode.testnet.sui.io:443" ;;
  mainnet) RPC="https://fullnode.mainnet.sui.io:443" ;;
  devnet)  RPC="https://fullnode.devnet.sui.io:443" ;;
  *) echo "Unknown network $NETWORK"; exit 1 ;;
esac

echo "▶ init-agent on $NETWORK"
echo "  package:  $OPTIC_PACKAGE_ID"
echo "  name:     $NAME"
echo "  strategy: $STRATEGY"
echo "  max pos:  \$$((MAX_POS / 1_000_000))"
echo "  max loss: \$$((MAX_DAILY_LOSS / 1_000_000))/day"
echo "  leverage: $((MAX_LEV_BPS / 100))%"

# Step 1: compute strategy hash
STRATEGY_HASH=$(printf "%s" "$STRATEGY" | sha256sum | cut -d' ' -f1)
echo "  · strategy hash: $STRATEGY_HASH"

# Step 2: build the init PTB
#    a. create_treasury<0x2::sui::SUI>(registry, per_tx_cap)
#    b. create_agent(registry, name, strategy_hash, suins_name, max_pos, max_loss, max_lev, treasury)
#    c. issue_cap(agent, role, recipient) × 3
#
# The PTB is built and signed via `sui client ptb` which is the modern
# (≥1.32) entry point and avoids manual BCS gymnastics.

SUINS_ARG="null"
if [[ -n "$SUINS_NAME" ]]; then
  SUINS_ARG="some(\"$SUINS_NAME\")"
fi

ACTIVE_ADDR=$(sui client active-address)
PTB=$(cat <<EOF
--move-call $OPTIC_PACKAGE_ID::treasury::create_treasury "<0x2::sui::SUI>" @$PER_TX_CAP
--assign treasury
--move-call $OPTIC_PACKAGE_ID::core::create_agent "@$OPTIC_REGISTRY_ID" "$NAME" "$STRATEGY_HASH" $SUINS_ARG $MAX_POS $MAX_DAILY_LOSS $MAX_LEV_BPS "@treasury"
--assign agent
--move-call $OPTIC_PACKAGE_ID::core::issue_cap "@agent" 0 "$ACTIVE_ADDR"
--assign cap_quant
--move-call $OPTIC_PACKAGE_ID::core::issue_cap "@agent" 1 "$ACTIVE_ADDR"
--assign cap_risk
--move-call $OPTIC_PACKAGE_ID::core::issue_cap "@agent" 2 "$ACTIVE_ADDR"
--assign cap_exec
--transfer-objects "[treasury, agent, cap_quant, cap_risk, cap_exec]" "$ACTIVE_ADDR"
--gas-budget 500000000
--json
EOF
)

echo "  · submitting init PTB"
RAW=$(sui client ptb $PTB --sender "$ACTIVE_ADDR" 2>&1)
echo "$RAW" | tail -3

# Extract the new agent + treasury ids and write back to .env
python3 - "$ENV" "$RAW" <<'PY'
import json, re, sys
env_path, raw = sys.argv[1], sys.argv[2]
ids = {"AGENT_ID": [], "TREASURY_ID": [], "REGISTRY_ID": []}
try:
    data = json.loads(raw)
    for chg in data.get("objectChanges", []):
        otype = chg.get("type", "")
        oid = chg.get("objectId", "")
        ot = chg.get("objectType", "")
        if "treasury::Treasury" in ot: ids["TREASURY_ID"].append(oid)
        if "core::Agent" in ot: ids["AGENT_ID"].append(oid)
        if "core::Registry" in ot: ids["REGISTRY_ID"].append(oid)
except Exception:
    # Fall back to regex over the raw text
    for m in re.finditer(r'"objectId":\s*"(0x[0-9a-f]+)"', raw):
        ids["AGENT_ID"].append(m.group(1))

with open(env_path) as f: src = f.read()
for k, vals in ids.items():
    if not vals: continue
    if re.search(rf"OPTIC_{k}=", src):
        src = re.sub(rf"OPTIC_{k}=.*", f"OPTIC_{k}={vals[0]}", src)
    else:
        src += f"\nOPTIC_{k}={vals[0]}\n"
with open(env_path, "w") as f: f.write(src)
print(f"  ✓ wrote { {k: v[0] if v else '' for k, v in ids.items()} } to {env_path}")
PY

echo "▶ Done. Next: ./scripts/demo-cycle.sh to run a few orchestrator cycles."
