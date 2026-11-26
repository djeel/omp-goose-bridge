import { toolsFor, type Role } from "../core/roles.js";
import { normalize } from "node:path";

// WorkspaceGuard : single-writer par workspace partage.
// developer = seul writer, 1 seul a la fois par workspace.
// architect / researcher / reviewer = read-only, parallele OK.

export function safeWorkspace(ws: unknown): string {
  const raw = String(ws ?? "/tmp");
  const n = normalize(raw);
  if (n.includes("..")) throw new Error("workspace refuse: " + n);
  if (n === "/tmp") return n;
  if (n.startsWith("/tmp/")) return n;
  if (n.startsWith("/home/djeel/Projets")) return n;
  throw new Error("workspace refuse: " + n + " (autorise: /home/djeel/Projets/* ou /tmp)");
}

export function isReadOnly(role: Role): boolean {
  return role !== "developer";
}

const writerLocks = new Map<string, string>();

export function tryAcquireWriter(workspace: string, sessionId: string): void {
  const holder = writerLocks.get(workspace);
  if (holder && holder !== sessionId) {
    throw new Error(
      "workspace " + workspace + " deja verrouille par " + holder + " (single-writer)"
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
