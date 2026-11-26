#!/usr/bin/env bash
# Installe recipes + agents aux emplacements Goose, puis affiche le snippet d'extension.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_GOOSE="${HOME}/.config/goose"
RECIPES_GLOBAL="${CONFIG_GOOSE}/recipes"
RECIPES_SHARE="${HOME}/.local/share/goose/recipes"
AGENTS_GLOBAL="${HOME}/.agents/agents"

echo "→ repo: ${ROOT}"

mkdir -p "${RECIPES_GLOBAL}" "${RECIPES_SHARE}" "${AGENTS_GLOBAL}"

cp "${ROOT}"/recipes/*.yaml "${RECIPES_GLOBAL}/"
cp "${ROOT}"/recipes/*.yaml "${RECIPES_SHARE}/"
cp "${ROOT}"/agents/*.md "${AGENTS_GLOBAL}/"

echo "✓ recipes → ${RECIPES_GLOBAL} et ${RECIPES_SHARE}"
echo "✓ agents  → ${AGENTS_GLOBAL}"

cat <<EOF

────────────────────────────────────────────────────────────
Ajoute ce bloc à ${CONFIG_GOOSE}/config.yaml (section extensions) :

  omp-bridge:
    enabled: true
    type: stdio
    name: OMP Bridge
    cmd: bun
    args: ["${ROOT}/src/mcp/server.ts"]
    envs:
      OMP_BRIDGE_ROOTS: "${HOME}/projets:/tmp"
    timeout: 300

(Desktop Flatpak : cmd: flatpak-spawn, args: ["--host","bun","${ROOT}/src/mcp/server.ts"])

Slash commands (optionnel, même fichier) :

  slash_commands:
    - command: "omp-auto"
      recipe_path: "${RECIPES_SHARE}/omp-auto.yaml"
    - command: "omp-review"
      recipe_path: "${RECIPES_SHARE}/omp-review.yaml"
    - command: "omp-develop"
      recipe_path: "${RECIPES_SHARE}/omp-develop.yaml"

Redémarre Goose, puis vérifie : bun run panel && open http://127.0.0.1:3210/
────────────────────────────────────────────────────────────
EOF
