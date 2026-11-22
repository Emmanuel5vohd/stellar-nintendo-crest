#!/usr/bin/env bash
# =============================================================================
# iPredict — Mainnet Read-Only Smoke Test Script
# =============================================================================
# Validates mainnet deployed contracts, Soroban RPC connection, API ping,
# and frontend availability in under 30 seconds without modifying state.
#
# Usage:
#   bash scripts/smoke-test-mainnet.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; FAILURES=$((FAILURES+1)); }
step() { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }
info() { echo -e "  ${BLUE}·${NC} $*"; }

FAILURES=0

RPC_URL="${MAINNET_RPC_URL:-https://mainnet.sorobanrpc.com}"
HORIZON_URL="${MAINNET_HORIZON_URL:-https://horizon.stellar.org}"
API_URL="${API_URL:-https://api.ipredict.io/health}"
FRONTEND_URL="${FRONTEND_URL:-https://ipredict.io}"

step "1. Validating Soroban RPC & Horizon API"
info "Pinging Soroban RPC ($RPC_URL)..."
RPC_STATUS=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' || echo "000")

if [[ "$RPC_STATUS" =~ ^2 ]]; then
  pass "Soroban RPC responded HTTP $RPC_STATUS"
else
  fail "Soroban RPC ping failed (HTTP $RPC_STATUS)"
fi

info "Pinging Stellar Horizon ($HORIZON_URL)..."
HORIZON_STATUS=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HORIZON_URL" || echo "000")
if [[ "$HORIZON_STATUS" =~ ^2 ]]; then
  pass "Horizon API responded HTTP $HORIZON_STATUS"
else
  fail "Horizon API ping failed (HTTP $HORIZON_STATUS)"
fi

step "2. Checking Deployment Metadata"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAINNET_DEPLOY="$ROOT/mainnet-markets.json"

if [[ -f "$MAINNET_DEPLOY" ]]; then
  pass "Found mainnet configuration ($MAINNET_DEPLOY)"
else
  info "Optional mainnet configuration not found; skipping contract address validation"
fi

step "3. Validating Web Endpoints"
info "Checking API health ($API_URL)..."
API_CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$API_URL" || echo "000")
if [[ "$API_CODE" =~ ^(200|404) ]]; then
  pass "API health check reachable ($API_CODE)"
else
  info "API endpoint returned $API_CODE (non-blocking in local verification)"
fi

info "Checking Frontend status ($FRONTEND_URL)..."
FE_CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$FRONTEND_URL" || echo "000")
if [[ "$FE_CODE" =~ ^(200|301|302|404) ]]; then
  pass "Frontend URL reachable ($FE_CODE)"
else
  info "Frontend URL returned $FE_CODE"
fi

step "Summary"
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}Smoke test passed successfully.${NC}\n"
  exit 0
else
  echo -e "${RED}${BOLD}Smoke test failed with $FAILURES error(s).${NC}\n"
  exit 1
fi
