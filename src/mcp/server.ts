import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OmpRpc } from "../rpc/client.js";
import { ROLE_SYSTEM, REVIEW_GATE, gitDiff, type Role } from "../core/roles.js";
import {
  sessionCreate,
  sessionGet,
  sessionList,
  sessionNewTurn,
  sessionResume,
  sessionStop,
} from "../core/session-manager.js";
import { devStatusMarkdown } from "../core/status.js";
import { routeTask } from "../core/router.js";
import { eventList, eventAppend } from "../events/store.js";
import { safeWorkspace, writerHolder, rpcArgsForRole } from "../workspace/guard.js";

// Pilotage OMP en RPC : Goose -> MCP -> 1 process RPC par session.
// AUTORITE UNIQUE : seul developer mute. Tout le reste est read-only process.
// - session "default" (delegate/status/steer/review) = read-only --no-tools
// - developer = seul writer, single-writer par workspace (lock)
// - architect / researcher / reviewer = read-only parallele

const PANEL_URI = "ui://omp-bridge/dev-panel";

const server = new McpServer(
  { name: "omp-bridge", version: "0.1.0" },
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
    csp: { connectDomains: ["http://127.0.0.1:3210"] },
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
let workspace: string = process.env.OMP_BRIDGE_WORKSPACE ?? "/tmp";

function ws(): string {
  return safeWorkspace(workspace);
}

async function ensureRpc(): Promise<OmpRpc> {
  if (rpc) return rpc;
  rpc = new OmpRpc();
  rpc.setBridgeSessionId("default");
  // AUTORITE UNIQUE : default = read-only (pas de edit/write/bash).
  // Seul developer via session dediee peut muter.
  await rpc.start({ cwd: ws(), extraArgs: rpcArgsForRole("reviewer") });
  return rpc;
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
    content: [{ type: "text", text: "Panneau OMP Bridge affiché ci-dessus." }],
    _meta: { ui: { resourceUri: PANEL_URI } },
  })
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
  return { content: [{ type: "text", text: JSON.stringify(s?.data ?? s).slice(0, 4000) }] };
});

// --- Preuves / gate ---

server.tool(
  "omp_get_diff",
  "Git diff du workspace (lecture seule, preuve avant gate)",
  { stat_only: z.boolean().optional() },
  async ({ stat_only }) => {
    try {
      const out = gitDiff(ws(), stat_only ?? false);
      return { content: [{ type: "text", text: out.slice(0, 12000) || "(clean)" }] };
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
    const diff = gitDiff(ws(), false).slice(0, 10000);
    const r = await ensureRpc();
    const prompt =
      ROLE_SYSTEM.reviewer +
      "\n\n" +
      REVIEW_GATE +
      "\n\n" +
      (focus ? "Focus demande : " + focus + "\n\n" : "") +
      "DIFF a auditer :\n" +
      (diff || "(clean - rien a reviewer)");
    const text = await (r as any).promptAndWait(prompt);
    return { content: [{ type: "text", text: String(text).slice(0, 12000) }] };
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
  },
  async ({ task, workspace: w, session_dir, label, force_role }) => {
    const wsc = safeWorkspace(w);
    workspace = wsc;
    const dec = force_role
      ? { delegate: true, role: force_role as Role, reason: "force_role=" + force_role }
      : routeTask(task);
    eventAppend({ session_id: "auto", kind: "bridge_route", summary: "route delegate=" + dec.delegate + " role=" + dec.role + " (" + dec.reason + ")" });
    if (!dec.delegate) {
      return { content: [{ type: "text", text: "local : pas de delegation (" + dec.reason + "). Goose gere direct." }] };
    }
    if (dec.role === "developer") {
      const holder = writerHolder(wsc);
      if (holder) return { content: [{ type: "text", text: "refuse : writer deja actif " + holder + " sur " + wsc }] };
    }
    const s = await sessionCreate({
      workspace: wsc,
      sessionDir: session_dir,
      label: label ?? ("auto-" + dec.role),
      role: dec.role,
    });
    const prompt = ROLE_SYSTEM[dec.role] + "\n\nTache : " + task;
    try {
      const text = await s.rpc.promptAndWait(prompt);
      return {
        content: [{ type: "text", text: "auto route=" + dec.role + " session=" + s.id + "\n" + String(text).slice(0, 11000) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: "auto route=" + dec.role + " session=" + s.id + " erreur: " + e.message }] };
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
  },
  async ({ role, objective, workspace: w, session_dir, label }) => {
    const wsc = safeWorkspace(w);
    workspace = wsc;
    if (role === "developer") {
      const holder = writerHolder(wsc);
      if (holder) return { content: [{ type: "text", text: "refuse : writer deja actif " + holder + " sur " + wsc }] };
    }
    const s = await sessionCreate({
      workspace: wsc,
      sessionDir: session_dir,
      label: label ?? role,
      role: role as Role,
    });
    const prompt = ROLE_SYSTEM[role as Role] + "\n\nObjectif : " + objective;
    try {
      const text = await s.rpc.promptAndWait(prompt);
      return {
        content: [{ type: "text", text: "session=" + s.id + " role=" + role + "\n" + String(text).slice(0, 11000) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: "session=" + s.id + " role=" + role + " erreur: " + e.message }] };
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
      sessionDir: session_dir,
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
    const out = await sessionResume({ id, sessionDir: session_dir, sessionPath: session_path });
    return { content: [{ type: "text", text: out.slice(0, 4000) }] };
  }
);

server.tool(
  "omp_session_new",
  "Nouveau tour session (new_session RPC, garde le process)",
  { id: z.string() },
  async ({ id }) => {
    const r = await sessionNewTurn(id);
    return { content: [{ type: "text", text: "new_session cancelled=" + r.cancelled }] };
  }
);

server.tool(
  "omp_session_stop",
  "Arrete une session pilotee (abort + kill, libere le lock writer)",
  { id: z.string() },
  async ({ id }) => {
    await sessionStop(id);
    return { content: [{ type: "text", text: "stopped " + id }] };
  }
);

server.tool(
  "omp_session_prompt",
  "Envoie un prompt sur une session pilotee (refuse si role read-only : seul developer mute)",
  { id: z.string(), message: z.string() },
  async ({ id, message }) => {
    const s = sessionGet(id);
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
    const text = await s.rpc.promptAndWait(message);
    return { content: [{ type: "text", text: String(text).slice(0, 12000) }] };
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
    return { content: [{ type: "text", text: txt.slice(0, 12000) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[omp-bridge] MCP up workspace=" + ws());
