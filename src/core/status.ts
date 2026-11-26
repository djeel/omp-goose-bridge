import { sessionList, poolStats } from "./session-manager.js";
import { execSync } from "node:child_process";

export function sh(cwd: string, cmd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

export interface GitSummary {
  isRepo: boolean;
  branch: string;
  dirty: number;
}

/** Un seul appel git (porcelain v2) au lieu de 3 : branche + nb de fichiers modifiés. */
export function gitSummary(cwd: string): GitSummary {
  const out = sh(cwd, "git status --porcelain=v2 --branch");
  if (!out.trim()) return { isRepo: false, branch: "?", dirty: 0 };
  let branch = "?";
  let dirty = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
    else if (!line.startsWith("#")) dirty++;
  }
  return { isRepo: true, branch, dirty };
}

// Statut agrégé pour le panneau "Goose Development".
export function devStatus(workspace: string) {
  const sessions = sessionList();
  const g = gitSummary(workspace);
  const stat = !g.isRepo
    ? "(pas un dépôt git)"
    : g.dirty === 0
      ? "(clean)"
      : sh(workspace, "git diff --stat").trim() || `${g.dirty} fichier(s) modifié(s)`;
  return {
    connected: true,
    workspace,
    branch: g.branch,
    isRepo: g.isRepo,
    dirty: g.dirty,
    sessions: sessions.map((s) => ({
      id: s.id,
      label: s.label ?? "",
      role: s.role,
      workspace: s.workspace,
      age_s: Math.round((Date.now() - s.createdAt) / 1000),
    })),
    git: { stat },
    pool: poolStats(),
    updatedAt: new Date().toISOString(),
  };
}

export function devStatusMarkdown(workspace: string): string {
  const d = devStatus(workspace);
  const sess = d.sessions.length
    ? d.sessions
        .map(
          (s) =>
            `- ${s.id} (${s.label || "sans label"}) role=${s.role} ws=${s.workspace} age=${s.age_s}s`,
        )
        .join("\n")
    : "- (aucune session Bridge vivante)";
  return [
    `**Goose Development** — Connected`,
    ``,
    `Workspace : \`${d.workspace}\` — branche \`${d.branch}\`${d.isRepo ? "" : " (pas un dépôt git)"}`,
    ``,
    `Sessions (${d.sessions.length}) :`,
    sess,
    ``,
    `Pool read-only : ${d.pool.pooled} au repos — ${d.pool.hits} hits / ${d.pool.misses} misses`,
    ``,
    `Diff :`,
    "```",
    d.git.stat.slice(0, 3000),
    "```",
  ].join("\n");
}
