import { sessionList } from "./session-manager.js";
import { execSync } from "node:child_process";

export function sh(cwd: string, cmd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", timeout: 10000 });
  } catch {
    return "";
  }
}

// Statut agrégé pour le panneau "Goose Development".
export function devStatus(workspace: string) {
  const sessions = sessionList();
  const branch = sh(workspace, "git branch --show-current").trim() || "?";
  const stat = sh(workspace, "git diff --stat").trim() || "(clean)";
  const statusShort = sh(workspace, "git status --short").trim() || "(clean)";
  return {
    connected: true,
    workspace,
    branch,
    sessions: sessions.map((s) => ({
      id: s.id,
      label: s.label ?? "",
      workspace: s.workspace,
      age_s: Math.round((Date.now() - s.createdAt) / 1000),
    })),
    git: { stat, statusShort },
    updatedAt: new Date().toISOString(),
  };
}

export function devStatusMarkdown(workspace: string): string {
  const d = devStatus(workspace);
  const sess = d.sessions.length
    ? d.sessions.map((s) => `- ${s.id} (${s.label || "sans label"}) ws=${s.workspace} age=${s.age_s}s`).join("\n")
    : "- (aucune session Bridge vivante)";
  return [
    `**Goose Development** — Connected`,
    ``,
    `Workspace : \`${d.workspace}\` — branche \`${d.branch}\``,
    ``,
    `Sessions (${d.sessions.length}) :`,
    sess,
    ``,
    `Diff :`,
    "```",
    d.git.stat.slice(0, 3000),
    "```",
  ].join("\n");
}
