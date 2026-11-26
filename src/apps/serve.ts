import { sessionList } from "../core/session-manager.js";
import { devStatusMarkdown } from "../core/status.js";
import { gitDiff } from "../core/roles.js";
import { eventList } from "../events/store.js";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";

// Mini HTTP local : alimente panel.html sans réécrire Goose Desktop.
// GET  /            -> panel.html
// POST /mcp/<tool>  -> { workspace?, ... } JSON, retour texte
// Outils supportés : omp_dev_status, omp_get_diff, omp_sessions_list.
// Les tools avec LLM (review/run_role/session_prompt) restent dans le MCP Goose.

const PORT = Number(process.env.OMP_BRIDGE_HTTP ?? 3210);

function json(res: any, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

function text(res: any, code: number, body: string) {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function safeWorkspace(ws: unknown): string {
  const s = String(ws ?? "/tmp");
  const n = normalize(s);
  if (!n.startsWith("/home/djeel/Projets") && n !== "/tmp") {
    throw new Error(`workspace refusé: ${n} (autorisé: /home/djeel/Projets/* ou /tmp)`);
  }
  return n;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/panel")) {
      const p = join(import.meta.dir, "panel.html");
      if (!existsSync(p)) return new Response("panel manquant", { status: 500 });
      return new Response(readFileSync(p), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "POST" && url.pathname.startsWith("/mcp/")) {
      const tool = url.pathname.slice(5);
      let body: any = {};
      try {
        body = await req.json();
      } catch {}
      try {
        if (tool === "omp_dev_status") {
          const ws = safeWorkspace(body.workspace);
          return new Response(devStatusMarkdown(ws), {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }
        if (tool === "omp_get_diff") {
          const ws = safeWorkspace(body.workspace);
          return new Response(gitDiff(ws, false).slice(0, 12000), {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }
        if (tool === "omp_sessions_list") {
          const list = sessionList();
          const txt = list.map((s) => `${s.id} ws=${s.workspace} label=${s.label ?? ""}`).join("\n") || "(aucune)";
          return new Response(txt, {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }
        if (tool === "omp_events_list") {
          const evts = eventList({
            session_id: typeof body.session_id === "string" ? body.session_id : undefined,
            kind: typeof body.kind === "string" ? body.kind : undefined,
            limit: typeof body.limit === "number" ? Math.min(body.limit, 200) : 50,
          });
          const txt = evts.map((e) => `${e.id} [${e.ts}] ${e.session_id} ${e.kind} — ${e.summary}`).join("\n") || "(aucun événement)";
          return new Response(txt, {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }
        return new Response(`outil non exposé en HTTP: ${tool}`, { status: 404 });
      } catch (e: any) {
        return new Response(String(e.message), { status: 400 });
      }
    }
    return new Response("omp-bridge http: GET / | POST /mcp/omp_dev_status", { status: 404 });
  },
});

console.log(`[omp-bridge] http http://127.0.0.1:${PORT}/`);
