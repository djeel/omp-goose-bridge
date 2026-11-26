import { toolsFor, type Role } from "../core/roles.js";
import { defaultWorkspace, workspaceRoots } from "../config.js";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

// WorkspaceGuard : allowlist de racines + single-writer par workspace.
// - developer = seul writer, un seul à la fois par workspace
// - architect / researcher / reviewer = read-only, parallèle autorisé

function inside(root: string, path: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Résout les symlinks quand le chemin existe (empêche l'évasion /tmp/lien -> /etc). */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Valide et normalise un workspace (rejette hors allowlist). */
export function safeWorkspace(ws: unknown): string {
  const raw = String(ws ?? defaultWorkspace());
  if (!raw.trim()) throw new Error("workspace vide");
  const n = realish(resolve(raw)); // normalise + symlinks
  for (const root of workspaceRoots()) {
    if (inside(realish(root), n)) return n;
  }
  throw new Error(
    `workspace refusé: ${n} (autorisé: ${workspaceRoots().join(", ")})`,
  );
}

export function isReadOnly(role: Role): boolean {
  return role !== "developer";
}

const writerLocks = new Map<string, string>();

export function tryAcquireWriter(workspace: string, sessionId: string): void {
  const holder = writerLocks.get(workspace);
  if (holder && holder !== sessionId) {
    throw new Error(
      `workspace ${workspace} déjà verrouillé par ${holder} (single-writer)`,
    );
  }
  writerLocks.set(workspace, sessionId);
}

export function releaseWriter(workspace: string, sessionId: string): void {
  if (writerLocks.get(workspace) === sessionId) writerLocks.delete(workspace);
}

export function writerHolder(workspace: string): string | null {
  return writerLocks.get(workspace) ?? null;
}

export function rpcArgsForRole(role: Role): string[] {
  if (role === "developer") return [];
  return ["--no-tools", "--tools", toolsFor(role)];
}

/** Test-only : remet les verrous à zéro. */
export function _resetLocksForTests(): void {
  writerLocks.clear();
}
