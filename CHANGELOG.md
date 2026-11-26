# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) · [SemVer](https://semver.org/lang/fr/).

## [1.2.0] — 2026-11-26

### Ajouté
- Outil `omp_health` (diagnostic complet : version, racines, writer, bin OMP, DB, sessions).
- Ressource MCP App `ui://omp-bridge/dev-panel` + outil `omp_dev_panel` (panneau inline dans Goose).
- Panneau HTTP autonome (`src/apps/serve.ts`) + service systemd utilisateur.
- Recipes `omp-auto`, `omp-review`, `omp-develop` et agents `omp-architect/researcher/developer/reviewer`.
- `tests/fixtures/fake-omp.ts` : faux serveur RPC → tests du client sans binaire OMP.
- `scripts/bench.ts` : micro-benchmarks des chemins chauds.
- `ARCHITECTURE.md`, `examples/`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`.
- CI : typecheck + lint (Biome) + tests ; Dependabot.

### Sécurité
- Vérification de l'`Origin` sur les POST du panneau (anti-CSRF) et token optionnel à comparaison constante.
- Bind par défaut sur `127.0.0.1` (jamais le LAN).
- `safeSessionPath` : les chemins de session sont validés contre l'allowlist.
- Résolution des symlinks sur le plus long préfixe existant : `/tmp/lien/x` (→ `/etc`) est refusé même quand `x` n'existe pas.

### Corrigé
- Logs d'événements écrits sur `stdout` → corrompaient le protocole MCP stdio (désormais `stderr`).
- Course sur `promptAndWait` : le waiter est enregistré avant l'envoi, `abort`/crash le rejettent immédiatement.
- Fuite de verrou writer quand `omp_auto`/`omp_run_role` échouaient (fermeture en `finally`).
- `message_update` persisté pour chaque token (bruit SQLite).
- Chemins machine codés en dur (`/home/djeel/...`) → configuration 100 % par env.

### Performance
- `routeTask` : une regex précompilée par catégorie → **~15× plus rapide** (6,4 µs pour 5 prompts).
- `safeWorkspace` : realpath des racines mémoïsé → **~1,5× plus rapide**.
- `gitSummary` : un seul appel `git` au lieu de trois.

## [1.1.0] — 2026-11-26

### Ajouté
- Sessions pilotées en RPC (création, prompt, reprise, arrêt), balayeur TTL.
- Autorité single-writer par workspace, rôles read-only avec whitelist d'outils.
- Journal SQLite avec rétention, diagnostic dev (`omp_dev_status`, `omp_get_diff`).

## [1.0.0] — 2026-11-26

- Première version publique : bridge MCP Goose ↔ OMP, 19 outils, tests unitaires.
