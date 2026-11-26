# Architecture

```
Goose (Desktop / CLI)               OMP Bridge                         OMP
┌───────────────────────┐   stdio   ┌──────────────────────────┐  RPC   ┌──────────┐
│ MCP client            │◄─────────►│ src/mcp/server.ts        │◄──────►│ omp      │
│  • 20 outils          │           │  • ensureRpc (1 process) │  ndjson│ (--mode  │
│  • ressource ui://    │           │  • garde workspace/writer│        │  rpc)    │
│  • MCP App (panneau)  │           │  • sessions éphémères    │        └──────────┘
└───────────────────────┘           └───────────┬──────────────┘
                                                │
   HTTP 127.0.0.1:3210                          │
┌───────────────────────┐                       ▼
│ src/apps/serve.ts     │            ┌──────────────────────────┐
│  panneau + /mcp/<tool>│            │ SQLite (WAL) events      │
└───────────────────────┘            │ src/events/store.ts      │
                                     └──────────────────────────┘
```

## Modules

| Module | Rôle |
|---|---|
| `src/config.ts` | Toute la configuration par env, zéro chemin machine. Fonctions (pas constantes) pour rester testable dans un même process Bun. |
| `src/workspace/guard.ts` | Allowlist de racines (realpath du plus long préfixe existant), verrou single-writer par workspace, validation des chemins de session. |
| `src/rpc/client.ts` | Client RPC OMP : handshake `ready` + `negotiate_protocol` v2, waiters par `id` enregistrés **avant** l'envoi, abort/exit qui rejettent proprement. Logs sur **stderr** uniquement (stdout = protocole MCP). |
| `src/core/router.ts` | Routage déterministe sans LLM (review > archi > recherche > mutation), bornes de mot, accents normalisés, regex précompilées. |
| `src/core/roles.ts` | Prompts système par rôle, `toolsFor(role)`, gate de review, `gitDiff`. |
| `src/core/session-manager.ts` | Sessions pilotées + balayeur TTL (60 s, `unref`). |
| `src/core/status.ts` | Diagnostic dev : `git status --porcelain=v2 --branch` en un appel, sessions, writer. |
| `src/events/store.ts` | Journal SQLite (WAL, `synchronous=NORMAL`, `busy_timeout`), rétention par prune tous les 200 inserts. |
| `src/mcp/server.ts` | Serveur MCP : 20 outils, ressource `ui://omp-bridge/dev-panel`, arrêt propre (SIGINT/SIGTERM/beforeExit/uncaught). |
| `src/apps/serve.ts` | Panneau HTTP local : anti-CSRF (Origin), token à temps constant, CSP, endpoints JSON. |
| `src/apps/panel.html` | Client MCP App (thème, resize, send-to-chat) avec fallback standalone. |

## Modèle d'autorité (invariant central)

1. **Un seul writer par workspace.** `tryAcquireWriter` refuse un second `developer` ; `architect`/`researcher`/`reviewer` sont read-only (`--no-tools --tools <whitelist>`).
2. **Sessions éphémères par défaut.** `omp_auto`/`omp_run_role`/`omp_review` ferment leur session en `finally` → pas de verrou orphelin. `keep: true` pour persister.
3. **Aucune écriture hors allowlist.** Tout workspace et tout chemin de session passe par `safeWorkspace`/`safeSessionPath`.

## Flux d'un `omp_auto`

```
routeTask(task) → role
  ├─ role null      → réponse directe (Goose garde la main)
  └─ role != null   → sessionCreate(role)
                      ├─ developer  : verrou writer + tools complets
                      └─ read-only  : --no-tools --tools <whitelist>
                    → promptAndWait (timeout configurable)
                    → eventAppend(prompt_result)
                    → sessionStop (finally, sauf keep=true)
```

## Décisions de conception

- **RPC plutôt que CLI par appel** : un process OMP par session, pas un cold start par prompt.
- **Événements typés en SQLite** : auditable et requêtable, sans dépendance externe.
- **Pas de `message_update` persisté** : un token = une ligne saturerait la base ; seul le résultat compte.
- **Router sans LLM** : coût nul, comportement déterministe et testable (52 tests).
- **MCP App natif** : le panneau est une ressource `ui://` rendue inline dans Goose, pas une iframe externe.
