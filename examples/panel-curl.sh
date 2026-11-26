#!/usr/bin/env bash
# Diagnostic du panneau HTTP sans navigateur.
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:3210}"
TOKEN="${OMP_BRIDGE_TOKEN:-}"
H=(-H "Content-Type: application/json")
[[ -n "$TOKEN" ]] && H+=(-H "x-omp-bridge-token: $TOKEN")

echo "--- santé ---------------------------------------------------"
curl -fsS "$BASE/healthz" | jq .

echo "--- statut dev ----------------------------------------------"
curl -fsS "${H[@]}" -X POST "$BASE/mcp/omp_dev_status_json" \
  -d '{"workspace":"'"${OMP_BRIDGE_WORKSPACE:-$PWD}"'"}' | jq .

echo "--- sessions -------------------------------------------------"
curl -fsS "${H[@]}" -X POST "$BASE/mcp/omp_sessions_list" -d '{}' | jq .
