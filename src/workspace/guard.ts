import { toolsFor, type Role } from "../core/roles.js";
import { defaultWorkspace, workspaceRoots, SESSION_TTL_MS } from "../config.js";
import { realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

// WorkspaceGuard : allowlist de racines + single-writer par workspace.
// - developer = seul writer, un seul à la fois par workspace
// - architect / researcher / reviewer = read-only, parallèle autorisé

function inside(root: string, path: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Résout les symlinks du plus long préfixe existant, puis ré-applique le reste.
 * Nécessaire car realpathSync échoue sur un chemin inexistant : /tmp/lien/x
 * (où /tmp/lien -> /etc) ne doit pas être accepté tel quel.
 */
function realish(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // racine inaccessible : on garde le chemin normalisé
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

// Les racines sont stables pendant la vie du process : on mémoïse leur realpath
// (économie de 2-3 syscalls par validation, chemin chaud).
const rootRealCache = new Map<string, string>();

function rootReal(root: string): string {
  const hit = rootRealCache.get(root);
  if (hit) return hit;
  const real = realish(root);
  rootRealCache.set(root, real);
  return real;
}

/** Valide et normalise un workspace (rejette hors allowlist). */
export function safeWorkspace(ws: unknown): string {
  const raw = String(ws ?? defaultWorkspace());
  if (!raw.trim()) throw new Error("workspace vide");
  const n = realish(resolve(raw)); // normalise + symlinks
  for (const root of workspaceRoots()) {
    if (inside(rootReal(root), n)) return n;
  }
  throw new Error(
    `workspace refusé: ${n} (autorisé: ${workspaceRoots().join(", ")})`,
  );
}

export function isReadOnly(role: Role): boolean {
  return role !== "developer";
}

const writerLocks = new Map<string, string>();

// --- Verrou fichier : protège contre DEUX processus bridge en parallèle ---
// (ex. Goose CLI + Goose Desktop spawment chacun leur stdio bridge).
// Sans lui, la Map mémoire ne voit pas l'autre instance et deux developers
// mutent le même workspace. Création atomique via flag "wx".

/** Dossier des verrous (surchargeable pour les tests). */
function locksRoot(): string {
  return resolve(
    process.env.OMP_BRIDGE_LOCKS_DIR ??
      join(homedir(), ".local", "share", "omp-bridge", "locks"),
  );
}

function lockPath(workspace: string): string {
  const h = createHash("sha256").update(workspace).digest("hex").slice(0, 32);
  return join(locksRoot(), h + ".lock");
}

function readLockFile(workspace: string): { holder: string; ts: number } | null {
  try {
    const lines = readFileSync(lockPath(workspace), "utf8").split("\n");
    if (!lines[0]) return null;
    return { holder: lines[0], ts: Number(lines[1]) || 0 };
  } catch {
    return null;
  }
}

function removeLockFile(workspace: string): void {
  try {
    rmSync(lockPath(workspace), { force: true });
  } catch {}
}

function lockStale(ts: number): boolean {
  return Date.now() - ts > SESSION_TTL_MS;
}

export function tryAcquireWriter(workspace: string, sessionId: string): void {
  const mem = writerLocks.get(workspace);
  if (mem && mem !== sessionId) {
    throw new Error(
      `workspace ${workspace} déjà verrouillé par ${mem} (single-writer)`,
    );
  }
  try {
    mkdirSync(locksRoot(), { recursive: true });
    writeFileSync(lockPath(workspace), `${sessionId}\n${Date.now()}\n`, { flag: "wx" });
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    const cur = readLockFile(workspace);
    if (cur && cur.holder !== sessionId && !lockStale(cur.ts)) {
      throw new Error(
        `workspace ${workspace} déjà verrouillé par ${cur.holder} (single-writer)`,
      );
    }
    // Ré-entrant (même session) ou verrou périmé/orphelin : on (ré)écrit.
    writeFileSync(lockPath(workspace), `${sessionId}\n${Date.now()}\n`);
  }
  writerLocks.set(workspace, sessionId);
}

export function releaseWriter(workspace: string, sessionId: string): void {
  if (writerLocks.get(workspace) === sessionId) writerLocks.delete(workspace);
  const cur = readLockFile(workspace);
  if (cur && cur.holder === sessionId) removeLockFile(workspace);
}

export function writerHolder(workspace: string): string | null {
  const mem = writerLocks.get(workspace);
  if (mem) return mem;
  const cur = readLockFile(workspace);
  if (!cur) return null;
  // Un verrou périmé ne bloque personne (crash d'une autre instance).
  if (lockStale(cur.ts)) {
    removeLockFile(workspace);
    return null;
  }
  return cur.holder;
}

export function rpcArgsForRole(role: Role): string[] {
  if (role === "developer") return [];
  return ["--no-tools", "--tools", toolsFor(role)];
}

/** Racine dédiée aux dossiers de session OMP. */
export function sessionsRoot(): string {
  return resolve(
    process.env.OMP_BRIDGE_SESSIONS_DIR ??
      join(homedir(), ".local", "share", "omp-bridge", "sessions"),
  );
}

/**
 * Valide un dossier/fichier de session : doit être sous une racine autorisée
 * ou sous la racine de sessions. Empêche d'écrire/lire hors périmètre.
 */
export function safeSessionPath(p: unknown): string {
  const raw = String(p ?? "");
  if (!raw.trim()) throw new Error("chemin de session vide");
  const n = realish(resolve(raw));
  const roots = [...workspaceRoots(), sessionsRoot()];
  for (const r of roots) {
    if (inside(rootReal(r), n)) return n;
  }
  throw new Error(`chemin de session refusé: ${n} (autorisé: ${roots.join(", ")})`);
}

/** Test-only : remet les verrous à zéro. */
export function _resetLocksForTests(): void {
  writerLocks.clear();
}
