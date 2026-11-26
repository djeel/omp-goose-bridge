import { execSync } from "node:child_process";

// Rôles Phase 3 : séparation lecture / écriture sur workspace partagé.
// Reviewer/Architect/Researcher : read-only (pas edit/write/bash mutateur).
// Developer : seul writer, sérialisé par WorkspaceGuard (Phase 3 suite).

export type Role = "architect" | "researcher" | "developer" | "reviewer";

export const ROLE_SYSTEM: Record<Role, string> = {
  architect:
    "Tu es OMP Architect en lecture seule. Analyse architecture, dépendances, plan. " +
    "INTERDIT : edit, write, bash avec mutation, task avec écriture. Lecture via read/glob/grep/find uniquement.",
  researcher:
    "Tu es OMP Researcher en lecture seule. Docs, libs, solutions (web_search + lecture locale). " +
    "INTERDIT : edit, write, bash avec mutation. Lecture uniquement.",
  developer:
    "Tu es OMP Developer, seul writer autorisé du workspace. " +
    "Modifie via edit/write/bash, puis résume fichiers changés + tests.",
  reviewer:
    "Tu es OMP Reviewer en lecture seule. Audite le diff, liste bloquants/mineurs " +
    "avec fichier:ligne + preuve, sans modifier. INTERDIT : edit, write, bash avec mutation.",
};

// Overlay --tools : whitelist par rôle (noms exacts vus via get_state).
// researcher a web_search (docs, libs, solutions) mais ni edit/write ni task ;
// architect/reviewer ont lsp (navigation code) sans mutation.
export function toolsFor(role: Role): string {
  switch (role) {
    case "developer":
      return "read,bash,edit,glob,grep,find,task,wait,todo,write";
    case "researcher":
      return "read,glob,grep,find,web_search,wait,todo";
    case "architect":
    case "reviewer":
      return "read,glob,grep,find,lsp,wait,todo";
  }
}

export function gitDiff(cwd: string, statOnly = false): string {
  const opts = { cwd, encoding: "utf8" as const, timeout: 15000, stdio: ["ignore", "pipe", "pipe"] as any };
  try {
    if (statOnly) {
      return execSync("git diff --stat", opts) || "(clean)";
    }
    // UN SEUL spawn : stat + diff dans le même shell (cf. ARCHITECTURE.md).
    const raw: string =
      execSync("git diff --stat && printf '\n---DIFF---\n' && git diff", opts) || "";
    if (!raw.trim() || raw.trim() === "---DIFF---") return "(clean)";
    const idx = raw.indexOf("---DIFF---");
    const stat = idx >= 0 ? raw.slice(0, idx).trimEnd() : raw;
    const diff = idx >= 0 ? raw.slice(idx + "---DIFF---".length) : "";
    return `${stat}\n---\n${diff.slice(0, 12000)}`.trim();
  } catch (e: any) {
    return `(pas un dépôt git ou diff indisponible: ${String(e.message).split("\n")[0]})`;
  }
}

export const REVIEW_GATE = `Gate review obligatoire :
1. git diff --stat + contenu
2. Bloquants (fichier:ligne + preuve) vs mineurs
3. Verdict : GO / FIX (liste précise) / RE-DESIGN
4. Jamais de modification par le reviewer.`;
