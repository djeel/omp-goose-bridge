#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OmpRpc } from "../rpc/client.js";
import { ROLE_SYSTEM, REVIEW_GATE, gitDiff, gitDiffParts, type Role } from "../core/roles.js";
import {
  sessionCreate,
  sessionGet,
  sessionList,
  sessionNewTurn,
  sessionResume,
  sessionStop,
  sessionStopAll,
  acquireReadOnly,
  releaseReadOnly,
} from "../core/session-manager.js";
import { devStatusMarkdown } from "../core/status.js";
import { routeTask } from "../core/router.js";
import { eventList, eventAppend } from "../events/store.js";
import {
  rpcArgsForRole,
  safeSessionPath,
  safeWorkspace,
  writerHolder,
} from "../workspace/guard.js";
import {
  HTTP_PORT,
  MAX_OUTPUT,
  SESSION_TTL_MS,
  defaultWorkspace,
  ompBin,
  ompSupported,
  ompVersion,
  dbPath,
  workspaceRoots,
} from "../config.js";
import pkg from "../../package.json";

// Pilotage OMP en RPC : Goose -> MCP -> 1 process RPC par session.
// AUTORITE UNIQUE : seul developer mute. Tout le reste est read-only process.
// - session "default" (delegate/status/steer/review) = read-only --no-tools
// - developer = seul writer, single-writer par workspace (lock)
// - architect / researcher / reviewer = read-only parallele

const PANEL_URI = "ui://omp-bridge/dev-panel";

const server = new McpServer(
  { name: "omp-bridge", version: pkg.version },
  {
    capabilities: { resources: {} },
    instructions:
      "OMP Bridge : Goose orchestre, OMP execute en RPC. " +
      "omp_auto route seul (developer = seul writer, autres roles read-only). " +
      "omp_dev_panel affiche le panneau de suivi inline.",
  }
);

// MCP App : panneau suivi servi en ressource ui://, rendu inline dans le chat.
function panelHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(here, "..", "apps", "panel.html");
  if (!existsSync(p)) throw new Error("panel.html introuvable: " + p);
  return readFileSync(p, "utf8");
}

const PANEL_UI_META = {
  ui: {
    csp: { connectDomains: [`http://127.0.0.1:${HTTP_PORT}`] },
    prefersBorder: true,
  },
};

server.registerResource(
  "omp-dev-panel",
  PANEL_URI,
  {
    title: "OMP Bridge — panneau dev",
    description: "Sessions Bridge, branche, diff, lock writer (MCP App inline)",
    mimeType: "text/html;profile=mcp-app",
    _meta: PANEL_UI_META,
  },
  async () => ({
    contents: [
      {
        uri: PANEL_URI,
        mimeType: "text/html;profile=mcp-app",
        text: panelHtml(),
        _meta: PANEL_UI_META,
      },
    ],
  })
);
let rpc: OmpRpc | null = null;
let rpcStarting: Promise<OmpRpc> | null = null;
let workspace: string = defaultWorkspace();

function ws(): string {
  return safeWorkspace(workspace);
}

// Single-flight : deux appels concurrents ne doivent pas spawner deux process OMP.
async function ensureRpc(): Promise<OmpRpc> {
  if (rpc) return rpc;
  if (rpcStarting) return rpcStarting;
  rpcStarting = (async () => {
    const r = new OmpRpc();
    r.setBridgeSessionId("default");
    // AUTORITE UNIQUE : default = read-only (pas de edit/write/bash).
    // Seul developer via session dediee peut muter.
    await r.start({ cwd: ws(), extraArgs: rpcArgsForRole("reviewer") });
    rpc = r;
    return r;
  })();
  try {
    return await rpcStarting;
  } finally {
    rpcStarting = null;
  }
}

// --- Pilotage rapide (session default) ---

server.tool(
  "omp_delegate",
  "Delegue une tache a OMP en RPC (prompt non-bloquant, retour request id)",
  { objective: z.string(), workspace: z.string().optional() },
  async ({ objective, workspace: w }) => {
    if (w) workspace = safeWorkspace(w);
    const r = await ensureRpc();
    const res: any = await r.prompt(objective);
    return {
      content: [{ type: "text", text: "delegated id=" + (res?.id ?? "?") + " ws=" + ws() }],
    };
  }
);

server.tool(
  "omp_dev_panel",
  "Affiche le panneau OMP Bridge inline dans le chat (sessions, branche, diff, writer)",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text:
          "Panneau OMP Bridge affiché ci-dessus. " +
          `Si rien ne s'affiche (client sans MCP Apps), fallback : http://127.0.0.1:${HTTP_PORT}/`,
      },
    ],
    _meta: { ui: { resourceUri: PANEL_URI } },
  })
);

server.tool(
  "omp_health",
  "Diagnostic : version, binaire OMP, workspace, racines, verrou writer, sessions, DB",
  {},
  async () => {
    const omp = ompVersion();
    const info = {
      ok: true,
      name: "omp-bridge",
      version: pkg.version,
      workspace_default: defaultWorkspace(),
      workspace_current: ws(),
      workspace_roots: workspaceRoots(),
      workspace_writer: writerHolder(ws()),
      omp_bin: ompBin(),
      omp_version: omp,
      omp_supported: ompSupported(omp),
      db: dbPath(),
      session_ttl_s: Math.round(SESSION_TTL_MS / 1000),
      sessions: sessionList().length,
      panel_url: `http://127.0.0.1:${HTTP_PORT}/`,
    };
    return { content: [{ type: "text", text: JSON.stringify(info, null, 1) }] };
  }
);

server.tool("omp_status", "Etat session OMP (get_state RPC)", {}, async () => {
  const r = await ensureRpc();
  const s: any = await r.getState();
  const model = s?.data?.model?.id ?? "?";
  const sess = s?.data?.sessionId ?? "?";
  return { content: [{ type: "text", text: "model=" + model + " session=" + sess + " ws=" + ws() }] };
});

server.tool(
  "omp_steer",
  "Interrompt et reoriente OMP (abort + prompt)",
  { message: z.string() },
  async ({ message }) => {
    const r = await ensureRpc();
    await r.abort();
    const res: any = await r.prompt(message);
    return { content: [{ type: "text", text: "steered id=" + (res?.id ?? "?") }] };
  }
);

server.tool("omp_cancel", "Annule le run OMP en cours (abort RPC)", {}, async () => {
  const r = await ensureRpc();
  await r.abort();
  return { content: [{ type: "text", text: "cancelled" }] };
});

server.tool("omp_agents_list", "Liste les subagents OMP", {}, async () => {
  const r = await ensureRpc();
  const s: any = await r.getSubagents();
  return { content: [{ type: "text", text: JSON.stringify(s?.data ?? s).slice(0, Math.min(4000, MAX_OUTPUT)) }] };
});

// --- Preuves / gate ---

server.tool(
  "omp_get_diff",
  "Git diff du workspace (lecture seule, preuve avant gate)",
  { stat_only: z.boolean().optional() },
  async ({ stat_only }) => {
    try {
      const out = gitDiff(ws(), stat_only ?? false);
      return { content: [{ type: "text", text: out.slice(0, MAX_OUTPUT) || "(clean)" }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "diff error: " + e.message }] };
    }
  }
);

server.tool(
  "omp_review",
  "Reviewer lecture seule : audite le diff, rend bloquants/mineurs + verdict GO/FIX",
  { focus: z.string().optional() },
  async ({ focus }) => {
    const wsc = ws();
    // Budget explicite : le stat passe toujours, le diff est coupé avec marqueur.
    // Le marqueur force NEED-MORE (jamais de GO sur du partiel, cf. REVIEW_GATE).
    const parts = gitDiffParts(wsc, Math.max(4000, MAX_OUTPUT - 4000));
    const diffText = parts.error
      ? parts.error
      : !parts.stat && !parts.diff
        ? "(clean - rien a reviewer)"
        : `${parts.stat}\n---\n${parts.diff}` +
          (parts.truncated
            ? `\n[DIFF TRONQUÉ — ${parts.missing} chars manquants : verdict NEED-MORE obligatoire, lister les fichiers à auditer]`
            : "");
    const prompt =
      ROLE_SYSTEM.reviewer +
      "\n\n" +
      REVIEW_GATE +
      "\n\n" +
      (focus ? "Focus demande : " + focus + "\n\n" : "") +
      "DIFF a auditer :\n" +
      diffText;
    // Reviewer read-only : session chaude du pool, pas de spawn à froid.
    const s = await acquireReadOnly({ workspace: wsc, role: "reviewer", label: "review" });
    try {
      const text = await s.rpc.promptAndWait(prompt);
      return { content: [{ type: "text", text: String(text).slice(0, MAX_OUTPUT) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "review erreur: " + e.message }] };
    } finally {
      releaseReadOnly(s);
    }
  }
);

// --- Delegation auto (Goose decide seul via routeur) ---

server.tool(
  "omp_auto",
  "Routeur auto : decide seul si deleguer a OMP (role + session), sinon repond direct. Autorite unique writer respectee.",
  {
    task: z.string(),
    workspace: z.string(),
    session_dir: z.string().optional(),
    label: z.string().optional(),
    force_role: z.enum(["architect", "researcher", "developer", "reviewer"]).optional(),
    keep: z
      .boolean()
      .optional()
      .describe("Conserver la session après réponse (défaut: false, éphémère)"),
  },
  async ({ task, workspace: w, session_dir, label, force_role, keep }) => {
    const wsc = safeWorkspace(w);
    workspace = wsc;
    const dec = force_role
      ? { delegate: true, role: force_role as Role, reason: "force_role=" + force_role }
      : routeTask(task);
    eventAppend({ session_id: "auto", kind: "bridge_route", summary: "route delegate=" + dec.delegate + " role=" + dec.role + " (" + dec.reason + ")" });
    if (!dec.delegate || !dec.role) {
      return { content: [{ type: "text", text: "local : pas de delegation (" + dec.reason + "). Goose gere direct." }] };
    }
    const role: Role = dec.role;
    if (role === "developer") {
      const holder = writerHolder(wsc);
      if (holder) return { content: [{ type: "text", text: "refuse : writer deja actif " + holder + " sur " + wsc }] };
    }
    const prompt = ROLE_SYSTEM[role] + "\n\nTache : " + task;
    if (role === "developer") {
      const s = await sessionCreate({
        workspace: wsc,
        sessionDir: session_dir ? safeSessionPath(session_dir) : undefined,
        label: label ?? ("auto-" + role),
        role,
      });
      // Éphémère : libère le process ET le verrou writer.
      try {
        const text = await s.rpc.promptAndWait(prompt);
        return {
          content: [{ type: "text", text: "auto route=" + role + " session=" + s.id + "\n" + String(text).slice(0, MAX_OUTPUT) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: "auto route=" + role + " session=" + s.id + " erreur: " + e.message }] };
      } finally {
        if (!keep) {
          try {
            await sessionStop(s.id);
          } catch {}
        }
      }
    }
    // Read-only : session persistante explicite -> cycle create/stop classique ;
    // sinon pool (session chaude réutilisée, pas de spawn à froid).
    const s = session_dir
      ? await sessionCreate({
          workspace: wsc,
          sessionDir: safeSessionPath(session_dir),
          label: label ?? ("auto-" + role),
          role,
        })
      : await acquireReadOnly({ workspace: wsc, role, label: label ?? ("auto-" + role) });
    try {
      const text = await s.rpc.promptAndWait(prompt);
      return {
        content: [{ type: "text", text: "auto route=" + role + " session=" + s.id + "\n" + String(text).slice(0, MAX_OUTPUT) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: "auto route=" + role + " session=" + s.id + " erreur: " + e.message }] };
    } finally {
      // Persistante explicite -> on ne la mélange pas au pool (évite de
      // polluer le session_dir avec des appels éphémères).
      if (session_dir && !keep) {
        try {
          await sessionStop(s.id);
        } catch {}
      } else {
        releaseReadOnly(s);
      }
    }
  }
);

// --- Sessions avec role (vrai pilotage RPC) ---

server.tool(
  "omp_run_role",
  "Lance une session role : developer=writer single-writer, autres=read-only (--no-tools)",
  {
    role: z.enum(["architect", "researcher", "developer", "reviewer"]),
    objective: z.string(),
    workspace: z.string(),
    session_dir: z.string().optional(),
    label: z.string().optional(),
    keep: z
      .boolean()
      .optional()
      .describe("Conserver la session après réponse (défaut: false, éphémère)"),
  },
  async ({ role, objective, workspace: w, session_dir, label, keep }) => {
    const wsc = safeWorkspace(w);
    workspace = wsc;
    if (role === "developer") {
      const holder = writerHolder(wsc);
      if (holder) return { content: [{ type: "text", text: "refuse : writer deja actif " + holder + " sur " + wsc }] };
    }
    const prompt = ROLE_SYSTEM[role as Role] + "\n\nObjectif : " + objective;
    if (role === "developer") {
      const s = await sessionCreate({
        workspace: wsc,
        sessionDir: session_dir ? safeSessionPath(session_dir) : undefined,
        label: label ?? role,
        role: role as Role,
      });
      try {
        const text = await s.rpc.promptAndWait(prompt);
        return {
          content: [{ type: "text", text: "session=" + s.id + " role=" + role + "\n" + String(text).slice(0, MAX_OUTPUT) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: "session=" + s.id + " role=" + role + " erreur: " + e.message }] };
      } finally {
        if (!keep) {
          try {
            await sessionStop(s.id);
          } catch {}
        }
      }
    }
    // Read-only : pool sauf session persistante explicite (non mélangée).
    const s = session_dir
      ? await sessionCreate({
          workspace: wsc,
          sessionDir: safeSessionPath(session_dir),
          label: label ?? (role as string),
          role: role as Role,
        })
      : await acquireReadOnly({ workspace: wsc, role: role as Role, label: label ?? (role as string) });
    try {
      const text = await s.rpc.promptAndWait(prompt);
      return {
        content: [{ type: "text", text: "session=" + s.id + " role=" + role + "\n" + String(text).slice(0, MAX_OUTPUT) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: "session=" + s.id + " role=" + role + " erreur: " + e.message }] };
    } finally {
      if (session_dir && !keep) {
        try {
          await sessionStop(s.id);
        } catch {}
      } else {
        releaseReadOnly(s);
      }
    }
  }
);

server.tool(
  "omp_session_create",
  "Cree une session OMP pilotee en RPC (role + workspace gardes)",
  {
    workspace: z.string(),
    role: z.enum(["architect", "researcher", "developer", "reviewer"]).optional(),
    session_dir: z.string().optional(),
    label: z.string().optional(),
  },
  async ({ workspace: w, role, session_dir, label }) => {
    const wsc = safeWorkspace(w);
    workspace = wsc;
    const s = await sessionCreate({
      workspace: wsc,
      sessionDir: session_dir ? safeSessionPath(session_dir) : undefined,
      label,
      role: (role as Role) ?? "developer",
    });
    const st: any = await s.rpc.getState();
    return {
      content: [
        {
          type: "text",
          text:
            "created id=" + s.id + " role=" + s.role + " session=" + (st?.data?.sessionId ?? "?") + " model=" + (st?.data?.model?.id ?? "?"),
        },
      ],
    };
  }
);

server.tool("omp_sessions_list", "Liste les sessions Bridge vivantes (id, role, workspace)", {}, async () => {
  const list = sessionList();
  const txt = list.map((s) => s.id + " role=" + s.role + " ws=" + s.workspace + (s.label ? " label=" + s.label : "")).join("\n");
  return { content: [{ type: "text", text: txt || "(aucune)" }] };
});

server.tool(
  "omp_session_resume",
  "Reprend une session : open_session par dossier ou switch_session par fichier",
  {
    id: z.string(),
    session_dir: z.string().optional(),
    session_path: z.string().optional(),
  },
  async ({ id, session_dir, session_path }) => {
    try {
      const out = await sessionResume({
        id,
        sessionDir: session_dir ? safeSessionPath(session_dir) : undefined,
        sessionPath: session_path ? safeSessionPath(session_path) : undefined,
      });
      return { content: [{ type: "text", text: out.slice(0, Math.min(4000, MAX_OUTPUT)) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "resume impossible: " + e.message }] };
    }
  }
);

server.tool(
  "omp_session_new",
  "Nouveau tour session (new_session RPC, garde le process)",
  { id: z.string() },
  async ({ id }) => {
    try {
      const r = await sessionNewTurn(id);
      return { content: [{ type: "text", text: "new_session cancelled=" + r.cancelled }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "new_session impossible: " + e.message }] };
    }
  }
);

server.tool(
  "omp_session_stop",
  "Arrete une session pilotee (abort + kill, libere le lock writer)",
  { id: z.string() },
  async ({ id }) => {
    try {
      await sessionStop(id);
      return { content: [{ type: "text", text: "stopped " + id }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "stop impossible: " + e.message }] };
    }
  }
);

server.tool(
  "omp_session_prompt",
  "Envoie un prompt sur une session pilotee (refuse si role read-only : seul developer mute)",
  { id: z.string(), message: z.string() },
  async ({ id, message }) => {
    let s: ReturnType<typeof sessionGet>;
    try {
      s = sessionGet(id);
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }] };
    }
    if (s.role !== "developer") {
      return {
        content: [
          {
            type: "text",
            text: "refuse : session " + id + " role=" + s.role + " read-only. Cree une session developer pour muter.",
          },
        ],
      };
    }
    try {
      const text = await s.rpc.promptAndWait(message);
      return { content: [{ type: "text", text: String(text).slice(0, MAX_OUTPUT) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "prompt impossible: " + e.message }] };
    }
  }
);

server.tool(
  "omp_dev_status",
  "Panneau Goose Development : sessions, branche, diff, lock writer",
  { workspace: z.string().optional() },
  async ({ workspace: w }) => {
    if (w) workspace = safeWorkspace(w);
    const holder = writerHolder(ws());
    const base = devStatusMarkdown(ws());
    return { content: [{ type: "text", text: base + "\nWriter : " + (holder ?? "(libre)") }] };
  }
);

server.tool(
  "omp_events_list",
  "Historique des evenements Bridge/OMP (SQLite, filtre session/kind)",
  {
    session_id: z.string().optional(),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ session_id, kind, limit }) => {
    const evts = eventList({ session_id, kind, limit: limit ?? 50 });
    if (!evts.length) return { content: [{ type: "text", text: "(aucun evenement)" }] };
    const txt = evts.map((e) => e.id + " [" + e.ts + "] " + e.session_id + " " + e.kind + " - " + e.summary).join("\n");
    return { content: [{ type: "text", text: txt.slice(0, MAX_OUTPUT) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[omp-bridge] MCP up workspace=" + ws());

// Arrêt propre : tue les process OMP (aucun orphelin), libère les verrous.
let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[omp-bridge] arrêt (${sig})`);
  try {
    await sessionStopAll();
  } catch {}
  try {
    await rpc?.stop();
  } catch {}
  rpc = null;
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("beforeExit", () => void shutdown("beforeExit"));

// Filet de sécurité : une erreur non gérée laisserait le protocole stdio
// dans un état inconnu (Goose attendrait indéfiniment). On sort proprement.
process.on("uncaughtException", (e) => {
  console.error("[omp-bridge] uncaughtException:", e?.stack ?? e);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (e: any) => {
  console.error("[omp-bridge] unhandledRejection:", e?.stack ?? e);
  void shutdown("unhandledRejection");
});
