import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath, EVENTS_MAX } from "../config.js";

export interface BridgeEvent {
  id?: number;
  ts: string;
  session_id: string;
  kind: string;
  summary: string;
  data?: string;
}

let db: Database | null = null;
let inserts = 0;

export function eventsDb(): Database {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    data TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, id)`);
  return db;
}

export function eventAppend(e: Omit<BridgeEvent, "id" | "ts"> & { ts?: string }): number {
  const d = eventsDb();
  const r = d
    .query(`INSERT INTO events (ts, session_id, kind, summary, data) VALUES (?,?,?,?,?)`)
    .run(e.ts ?? new Date().toISOString(), e.session_id, e.kind, e.summary, e.data ?? null);
  // Rétention : purge périodique (tous les 200 inserts) pour éviter la croissance infinie.
  if (++inserts % 200 === 0) pruneEvents(EVENTS_MAX);
  return Number(r.lastInsertRowid);
}

/** Conserve les `keep` événements les plus récents. Retourne le nombre supprimé. */
export function pruneEvents(keep: number): number {
  const d = eventsDb();
  const row = d.query(`SELECT MIN(id) AS minId FROM (SELECT id FROM events ORDER BY id DESC LIMIT ?)`).get(keep) as
    | { minId: number | null }
    | undefined;
  const minId = row?.minId;
  if (minId == null || minId <= 1) return 0;
  const r = d.query(`DELETE FROM events WHERE id < ?`).run(minId);
  return Number(r.changes ?? 0);
}

export function eventList(opts: {
  session_id?: string;
  kind?: string;
  limit?: number;
}): BridgeEvent[] {
  const d = eventsDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.session_id && opts.kind) {
    return d
      .query(`SELECT * FROM events WHERE session_id=? AND kind=? ORDER BY id DESC LIMIT ?`)
      .all(opts.session_id, opts.kind, limit) as BridgeEvent[];
  }
  if (opts.session_id) {
    return d
      .query(`SELECT * FROM events WHERE session_id=? ORDER BY id DESC LIMIT ?`)
      .all(opts.session_id, limit) as BridgeEvent[];
  }
  if (opts.kind) {
    return d
      .query(`SELECT * FROM events WHERE kind=? ORDER BY id DESC LIMIT ?`)
      .all(opts.kind, limit) as BridgeEvent[];
  }
  return d.query(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit) as BridgeEvent[];
}

// Résumé compact pour logs console + Event Router.
export function summarizeEvent(msg: any): string {
  const k = msg?.type ?? "?";
  if (k === "prompt_result")
    return `prompt_result status=${msg.status} settled=${msg.sessionSettled} id=${msg.id ?? "?"}`;
  if (k === "session_settled") return `session_settled`;
  if (k === "subagent_progress")
    return `subagent_progress ${JSON.stringify(msg.payload ?? {}).slice(0, 200)}`;
  if (k === "subagent_lifecycle")
    return `subagent_lifecycle ${JSON.stringify(msg.payload ?? {}).slice(0, 200)}`;
  if (k === "message_update")
    return `message_update ${(msg?.message?.text ?? msg?.text ?? "").slice(0, 120)}`;
  return `${k}`;
}

/** Test-only : ferme la base et réinitialise le singleton. */
export function _resetDbForTests(): void {
  try {
    db?.close();
  } catch {}
  db = null;
  inserts = 0;
}
