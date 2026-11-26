import { toolsFor, type Role } from "../core/roles.js";
import { DEFAULT_WORKSPACE, workspaceRoots } from "../config.js";
import { resolve, sep } from "node:path";

// WorkspaceGuard : allowlist de racines + single-writer par workspace.
// - developer = seul writer, un seul à la fois par workspace
// - architect / researcher / reviewer = read-only, parallèle autorisé

function inside(root: string, path: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Valide et normalise un workspace (rejette hors allowlist). */
export function safeWorkspace(ws: unknown): string {
  const raw = String(ws ?? DEFAULT_WORKSPACE);
  if (!raw.trim()) throw new Error("workspace vide");
  const n = resolve(raw); // normalise + rend absolu
  for (const root of workspaceRoots()) {
    if (inside(root, n)) return n;
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
