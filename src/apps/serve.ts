import { sessionList } from "../core/session-manager.js";
import { eventList } from "../events/store.js";
import { gitDiff } from "../core/roles.js";
import { devStatusMarkdown } from "../core/status.js";
import {
  HTTP_HOST,
  HTTP_PORT,
  defaultWorkspace,
} from "../config.js";
import { safeWorkspace } from "../workspace/guard.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Mini serveur HTTP local qui alimente panel.html (page web + fallback standalone).
// GET  /            -> panneau HTML
// GET  /healthz     -> ok
// POST /mcp/<tool>  -> outils SANS LLM : statut, diff, sessions, events.
// Les outils nécessitant le process OMP (auto/review/run_role) restent côté MCP.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};

function txt(body: string, code = 200): Response {
  return new Response(body, {
    status: code,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS },
  });
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

const server = Bun.serve({
  port: HTTP_PORT,
  hostname: HTTP_HOST,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      if (!originAllowed(req)) return txt("origine refusée", 403);
      return new Response(null, { headers: CORS });
    }

    if (req.method === "GET" && url.pathname === "/healthz") return txt("ok");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/panel")) {
      const p = join(import.meta.dir, "panel.html");
      if (!existsSync(p)) return txt("panel.html manquant", 500);
      return new Response(readFileSync(p), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
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
          case "omp_dev_status":
            return txt(devStatusMarkdown(pickWorkspace(body)));
          case "omp_get_diff":
            return txt(gitDiff(pickWorkspace(body), false).slice(0, 12000));
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

console.error(`[omp-bridge] http http://${server.hostname}:${server.port}/`);

export { server };
