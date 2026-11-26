import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Configuration centralisée — tout est surchargeable par variables d'environnement.
// Aucun chemin propre à une machine n'est codé en dur.

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src
export const REPO_ROOT = resolve(HERE, "..");

/** Racines autorisées pour les workspaces (séparées par ":"). Défaut : cwd + /tmp. */
export function workspaceRoots(): string[] {
  const roots = new Set<string>();
  const raw = process.env.OMP_BRIDGE_ROOTS;
  if (raw && raw.trim()) {
    for (const p of raw.split(":")) {
      const t = p.trim();
      if (t) roots.add(resolve(t));
    }
  } else {
    roots.add(resolve(process.cwd()));
    roots.add(resolve("/tmp"));
  }
  // Le workspace par défaut est toujours autorisé.
  const def = process.env.OMP_BRIDGE_WORKSPACE;
  if (def && def.trim()) roots.add(resolve(def));
  return [...roots];
}

/** Binaire OMP (résolu via PATH par défaut). */
export const OMP_BIN = process.env.OMP_BIN || "omp";

/** Workspace par défaut quand l'appelant n'en fournit pas. */
export function defaultWorkspace(): string {
  const env = process.env.OMP_BRIDGE_WORKSPACE;
  if (env && env.trim()) return resolve(env);
  return workspaceRoots()[0] ?? resolve(process.cwd());
}

/** TTL d'inactivité avant arrêt automatique d'une session (secondes). */
export const SESSION_TTL_MS =
  Number(process.env.OMP_BRIDGE_SESSION_TTL ?? 1800) * 1000;

/** Base SQLite de l'historique (lue à l'ouverture, surchargeable à chaud). */
export function dbPath(): string {
  return process.env.OMP_BRIDGE_DB || join(REPO_ROOT, "data", "bridge.db");
}

/** Serveur HTTP du panneau : bind localhost par défaut (jamais exposé au LAN). */
export const HTTP_PORT = Number(process.env.OMP_BRIDGE_HTTP ?? 3210);
export const HTTP_HOST = process.env.OMP_BRIDGE_HTTP_HOST ?? "127.0.0.1";

/** Rétention de l'historique (nombre max d'événements conservés). */
export const EVENTS_MAX =
  Number(process.env.OMP_BRIDGE_EVENTS_MAX ?? 20000) || 20000;
