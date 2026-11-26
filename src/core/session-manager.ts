import { OmpRpc } from "../rpc/client.js";
import type { Role } from "./roles.js";
import { SESSION_TTL_MS } from "../config.js";
import {
  rpcArgsForRole,
  safeWorkspace,
  tryAcquireWriter,
  releaseWriter,
} from "../workspace/guard.js";

// SessionManager Phase 2/3 : 1 process RPC = 1 session OMP vivante.
// - create : spawn frais sur workspace (+ --session-dir optionnel pour persistance)
// - resume : open_session (par dossier) ou switch_session (par fichier session)
// - stop : abort + kill process, retire du registre
// Persistance disque : sessionDir OMP natif, pas de réimplémentation.

export interface ManagedSession {
  id: string;
  workspace: string;
  rpc: OmpRpc;
  createdAt: number;
  lastUsed: number;
  label?: string;
  role: Role;
}

const sessions = new Map<string, ManagedSession>();
let seq = 0;

function sid(prefix = "omp"): string {
  return `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

export async function sessionCreate(opts: {
  workspace: string;
  sessionDir?: string;
  label?: string;
  role?: Role;
}): Promise<ManagedSession> {
  const ws = safeWorkspace(opts.workspace);
  const role: Role = opts.role ?? "developer";
  const id = sid();
  // single-writer : seul developer prend le lock écriture (vrai id, pas "pending")
  if (role === "developer") tryAcquireWriter(ws, id);
  const rpc = new OmpRpc();
  // persistant si sessionDir fourni, éphémère sinon
  // read-only : overlay --no-tools --tools whitelist (vrai verrou process)
  try {
    await rpc.start({ cwd: ws, sessionDir: opts.sessionDir, extraArgs: rpcArgsForRole(role) });
  } catch (e) {
    if (role === "developer") releaseWriter(ws, id);
    throw e;
  }
  rpc.setBridgeSessionId(id);
  const s: ManagedSession = {
    id,
    workspace: ws,
    rpc,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    label: opts.label,
    role,
  };
  sessions.set(id, s);
  // ping événement création (traçabilité panneau)
  try {
    const { eventAppend } = await import("../events/store.js");
    eventAppend({
      session_id: id,
      kind: "bridge_session_create",
      summary: `create ws=${ws} role=${role} label=${opts.label ?? ""}`,
    });
  } catch {}
  return s;
}

export function sessionGet(id: string): ManagedSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`session inconnue: ${id} (list: ${[...sessions.keys()].join(", ") || "vide"})`);
  s.lastUsed = Date.now();
  return s;
}

export function sessionList(): Array<{
  id: string;
  workspace: string;
  label?: string;
  role: Role;
  createdAt: number;
}> {
  return [...sessions.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => ({
      id: s.id,
      workspace: s.workspace,
      label: s.label,
      role: s.role,
      createdAt: s.createdAt,
    }));
}

export async function sessionNewTurn(id: string): Promise<{ cancelled: boolean }> {
  const s = sessionGet(id);
  const r: any = await s.rpc.send({ type: "new_session" });
  return r?.data ?? { cancelled: false };
}

export async function sessionResume(opts: {
  id: string;
  sessionDir?: string;
  sessionPath?: string;
}): Promise<string> {
  const s = sessionGet(opts.id);
  if (opts.sessionDir) {
    const r: any = await s.rpc.send({
      type: "open_session",
      sessionDir: opts.sessionDir,
    });
    return JSON.stringify(r?.data ?? r).slice(0, 2000);
  }
  if (opts.sessionPath) {
    const r: any = await s.rpc.send({
      type: "switch_session",
      sessionPath: opts.sessionPath,
    });
    return JSON.stringify(r?.data ?? r).slice(0, 2000);
  }
  throw new Error("resume exige sessionDir ou sessionPath");
}

export async function sessionStop(id: string): Promise<void> {
  const s = sessionGet(id);
  try {
    await s.rpc.abort();
  } catch {}
  try {
    await s.rpc.stop();
  } catch {}
  sessions.delete(id);
  poolIds.delete(id);
  if (s.role === "developer") releaseWriter(s.workspace, id);
  try {
    const { eventAppend } = await import("../events/store.js");
    eventAppend({ session_id: id, kind: "bridge_session_stop", summary: `stop role=${s.role}` });
  } catch {}
}

export async function sessionStopAll(): Promise<number> {
  const ids = [...sessions.keys()];
  for (const id of ids) {
    try {
      await sessionStop(id);
    } catch {}
  }
  return ids.length;
}

// --- Pool de sessions READ-ONLY : évite un spawn à froid par review/auto ---
// Developer reste TOUJOURS éphémère (sécurité > perf) : jamais poolé.
// Le pool est un simple index sur le registre `sessions` : list/sweep/stopAll
// continuent de voir les sessions au repos (réutilisables si fraîches).

const poolIds = new Set<string>();

/** Fraîcheur max d'une session au repos pour être réutilisée (défaut 300 s). */
export function poolIdleMs(): number {
  return (Number(process.env.OMP_BRIDGE_POOL_IDLE ?? 300) || 300) * 1000;
}

/**
 * Récupère une session read-only chaude, ou en crée une.
 * `developer` est refusé : l'écriture reste éphémère (sessionCreate + stop).
 */
export async function acquireReadOnly(opts: {
  workspace: string;
  role?: Role;
  label?: string;
}): Promise<ManagedSession> {
  const role = opts.role ?? "reviewer";
  if (role === "developer") {
    throw new Error("developer n'est jamais poolé : session éphémère via sessionCreate");
  }
  const ws = safeWorkspace(opts.workspace);
  const now = Date.now();
  // Réclamation synchrone : pas d'await dans le scan, deux acquire
  // concurrents ne peuvent pas récupérer la même session.
  for (const s of sessions.values()) {
    if (
      poolIds.has(s.id) &&
      s.role === role &&
      s.workspace === ws &&
      s.rpc.isRunning() &&
      now - s.lastUsed < poolIdleMs()
    ) {
      poolIds.delete(s.id);
      s.lastUsed = now;
      if (opts.label) s.label = opts.label;
      return s;
    }
  }
  return sessionCreate({ workspace: ws, role, label: opts.label ?? role });
}

/** Rend une session read-only au pool (reste vivante pour le prochain appel). */
export function releaseReadOnly(s: ManagedSession): void {
  if (!sessions.has(s.id)) return;
  if (s.role === "developer") return;
  s.lastUsed = Date.now();
  poolIds.add(s.id);
}

// Balayeur d'inactivité : évite les sessions/verrous fantômes si l'appelant a oublié stop.
async function sweepIdle(): Promise<void> {
  const now = Date.now();
  for (const [id, s] of [...sessions]) {
    if (now - s.lastUsed > SESSION_TTL_MS) {
      try {
        await sessionStop(id);
      } catch {}
    }
  }
}

const sweeper = setInterval(() => void sweepIdle(), 60_000);
sweeper.unref?.();
