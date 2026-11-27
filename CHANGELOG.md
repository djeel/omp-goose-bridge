# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) · [SemVer](https://semver.org/lang/fr/).

## [1.4.0] — 2026-11-27

### Ajouté
- **Panneau live** : timeline temps réel de l'activité Goose → OMP (route → session → prompt → résultat → durée → stop), KPI (sessions, writer, pool hits/misses, branche, version OMP).
- `GET /stream` (SSE : `snapshot`, `event`, `ping`) et `GET /activity` (snapshot JSON) sur le panneau.
- Snapshot **SSR** injecté dans le HTML : le panneau est rempli au premier rendu, avant même la connexion SSE (plus de « Clique Refresh »).
- Événements `prompt_sent` / `prompt_done` (durée) + rôle étiqueté dans la timeline.
- `devStatus` expose `writer` (verrou courant).

### Corrigé
- **Régression 1.3.0** : `lsp` n'existe pas comme outil OMP (le process sort en `code=2`) → les rôles `architect` et `reviewer` ne démarraient plus (`omp_review` cassé). `toolsFor` filtre désormais sur une liste blanche `KNOWN_TOOLS` validée contre OMP 19.2.1, et un test interdit tout nom inconnu.

## [1.3.0] — 2026-11-27

### Ajouté
- Pool de sessions read-only (`acquireReadOnly`/`releaseReadOnly`) : `omp_review`, `omp_auto` et `omp_run_role` non-developer réutilisent une session chaude (fraîcheur 300 s via `OMP_BRIDGE_POOL_IDLE`) au lieu d'un spawn à froid par appel. `developer` reste éphémère.
- Verrou writer multi-processus : `tryAcquireWriter`/`releaseWriter`/`writerHolder` doublent la Map mémoire d'un verrou fichier atomique (`~/.local/share/omp-bridge/locks/`, `OMP_BRIDGE_LOCKS_DIR` pour les tests, vol après `SESSION_TTL_MS` si crash).
- `researcher` reçoit `web_search`, `architect`/`reviewer` reçoivent `lsp` (toujours sans edit/write/bash/task).
- `omp_dev_panel` annonce l'URL fallback locale quand le client ne rend pas les MCP Apps inline.
- Tests `roles` (whitelist, `gitDiff` propre/hors-dépôt) et `pool` (réutilisation, isolation workspaces, refus developer).
- Pool borné : cap 4 sessions au repos (`OMP_BRIDGE_POOL_MAX`), stop dès 300 s d'inactivité, rotation à 1800 s d'âge (`OMP_BRIDGE_POOL_ROTATE`), compteurs hit/miss exposés dans `omp_dev_status`.
- `gitDiffParts` : stat + diff + troncature explicite ; `omp_review` construit un prompt budgété et impose **NEED-MORE** sur diff partiel (plus de GO aveugle).
- `omp_health`/`healthz` exposent `omp_version` (`OMP_BIN --version`) + `omp_supported` (19.x testé : alerte, pas panne).
- Rate-limit des POST du panneau sans token : `OMP_BRIDGE_HTTP_RATE` par IP/minute (429 au-delà, inactif si token défini).

### Corrigé
- Prompt long sans mot-clé routé en `architect` (lecture seule) au lieu de `developer` : plus de spawn writer à froid par défaut.
- Routeur : "test"/"tester"/"build" sortis de DEV — "ce test échoue, pourquoi ?" va en `architect` (diagnostic), "ajoute un test" reste `developer` via le verbe.
- `gitDiff` en un seul spawn (stat + diff dans le même shell) ; dépôt propre retourne `(clean)` au lieu de `"---"`.
- Comptes docs : 19 outils (plus 20), 74 tests (plus 41/52).
- Tests `roles` : identité git explicite (`-c user.name/-c user.email`) — les dépôts temporaires échouaient sur une machine sans identité globale (et sur les runners CI).

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
