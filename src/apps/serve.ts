import { sessionList } from "../core/session-manager.js";
import { eventList } from "../events/store.js";
import { gitDiff } from "../core/roles.js";
import { devStatus, devStatusMarkdown } from "../core/status.js";
import {
  HTTP_HOST,
  HTTP_PORT,
  MAX_OUTPUT,
  OMP_BIN,
  dbPath,
  defaultWorkspace,
  workspaceRoots,
} from "../config.js";
import { safeWorkspace, writerHolder } from "../workspace/guard.js";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";

// Mini serveur HTTP local qui alimente panel.html (page web + fallback standalone).
// GET  /            -> panneau HTML
// GET  /healthz     -> diagnostic JSON
// POST /mcp/<tool>  -> outils SANS LLM : statut, diff, sessions, events, health.
// Les outils nécessitant le process OMP (auto/review/run_role) restent côté MCP.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};

const startedAt = Date.now();

function txt(body: string, code = 200, type = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status: code, headers: { "Content-Type": type, ...CORS } });
}

function json(obj: unknown, code = 200): Response {
  return txt(JSON.stringify(obj, null, 1), code, "application/json; charset=utf-8");
}

function pickWorkspace(body: any): string {
  return safeWorkspace(
    typeof body?.workspace === "string" && body.workspace.trim()
      ? body.workspace
      : defaultWorkspace(),
  );
}

/** Anti-CSRF : refuse les POST venant d'une origine web non locale. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // curl / CLI / même origine
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

// Cache mémoire du panneau (invalidé par mtime) : évite une lecture disque par requête.
let panelCache: { mtimeMs: number; body: string } | null = null;

function panelResponse(): Response {
  const p = join(import.meta.dir, "panel.html");
  try {
    const st = statSync(p);
    if (!panelCache || panelCache.mtimeMs !== st.mtimeMs) {
      panelCache = { mtimeMs: st.mtimeMs, body: readFileSync(p, "utf8") };
    }
    return txt(panelCache.body, 200, "text/html; charset=utf-8");
  } catch {
    return txt("panel.html manquant", 500);
  }
}

function health() {
  let db = "?";
  try {
    db = dbPath();
  } catch {}
  return {
    ok: true,
    name: "omp-bridge",
    version: pkg.version,
    pid: process.pid,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    workspace_default: defaultWorkspace(),
    workspace_roots: workspaceRoots(),
    workspace_writer: writerHolder(defaultWorkspace()),
    omp_bin: OMP_BIN,
    db,
    sessions: sessionList().length,
    events: eventList({ limit: 1 }).length > 0,
  };
}

/** Fabrique du serveur (testable : port 0 = aléatoire). */
export function createPanelServer(opts: { port?: number; hostname?: string } = {}) {
  return Bun.serve({
  port: opts.port ?? HTTP_PORT,
  hostname: opts.hostname ?? HTTP_HOST,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      if (!originAllowed(req)) return txt("origine refusée", 403);
      return new Response(null, { headers: CORS });
    }

    if (req.method === "GET" && url.pathname === "/healthz") return json(health());

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/panel")) {
      return panelResponse();
    }

    if (req.method === "POST" && url.pathname.startsWith("/mcp/")) {
      if (!originAllowed(req)) return txt("origine refusée", 403);
      const tool = url.pathname.slice("/mcp/".length);
      let body: any = {};
      try {
        body = await req.json();
      } catch {}
      try {
        switch (tool) {
          case "omp_health":
            return json(health());
          case "omp_dev_status":
            return txt(devStatusMarkdown(pickWorkspace(body)));
          case "omp_dev_status_json":
            return json(devStatus(pickWorkspace(body)));
          case "omp_get_diff":
            return txt(gitDiff(pickWorkspace(body), body?.stat_only === true).slice(0, MAX_OUTPUT));
          case "omp_sessions_list": {
            const list = sessionList();
            return txt(
              list
                .map((s) => `${s.id} role=${s.role} ws=${s.workspace} label=${s.label ?? ""}`)
                .join("\n") || "(aucune)",
            );
          }
          case "omp_events_list": {
            const evts = eventList({
              session_id: typeof body.session_id === "string" ? body.session_id : undefined,
              kind: typeof body.kind === "string" ? body.kind : undefined,
              limit: typeof body.limit === "number" ? body.limit : 50,
            });
            return txt(
              evts.map((e) => `${e.id} [${e.ts}] ${e.session_id} ${e.kind} — ${e.summary}`).join("\n") ||
                "(aucun événement)",
            );
          }
          default:
            return txt(`outil non exposé en HTTP: ${tool}`, 404);
        }
      } catch (e: any) {
        return txt(String(e?.message ?? e), 400);
      }
    }

    return txt("omp-bridge http: GET / | GET /healthz | POST /mcp/<tool>", 404);
  },
  });
}

// Démarre uniquement en exécution directe (pas à l'import dans les tests).
const server = import.meta.main ? createPanelServer() : null;
if (server) console.error(`[omp-bridge] http http://${server.hostname}:${server.port}/`);

export { server, health };
