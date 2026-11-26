# Contribuer

## Setup

```bash
git clone https://github.com/djeel/omp-goose-bridge.git
cd omp-goose-bridge
bun install
bun run check     # typecheck
bun test          # 41 tests
```

## Boucle de dev

| Commande | Effet |
|---|---|
| `bun run mcp` | lance le serveur MCP (stdio) |
| `bun run panel` | panneau sur http://127.0.0.1:3210 |
| `bun run probe` | handshake RPC réel avec OMP |
| `bun run check` | `tsc --noEmit` |
| `bun test` | suite complète |

## Règles

- **stdout est réservé au protocole MCP** : tout log va sur `stderr`.
- Aucun chemin machine en dur → passe par `src/config.ts` (env).
- Toute nouvelle règle de sécurité (allowlist, verrou, origine HTTP) doit venir avec un test.
- Sessions : éphémères par défaut (`stop()` en `finally`), sinon fuite de process et de verrou.
- Tests : `bun:test`, fichiers `tests/*.test.ts`, pas de réseau ni de binaire OMP requis.

## PR

1. `bun run check && bun test` verts
2. message de commit au format `type: résumé` (feat/fix/chore/docs/test)
3. décrire l'impact sécurité/perf s'il y en a
