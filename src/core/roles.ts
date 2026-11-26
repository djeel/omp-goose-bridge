import { OmpRpc } from "../rpc/client.js";
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
    "Tu es OMP Researcher en lecture seule. Docs, libs, solutions. " +
    "INTERDIT : edit, write, bash avec mutation. Lecture uniquement.",
  developer:
    "Tu es OMP Developer, seul writer autorisé du workspace. " +
    "Modifie via edit/write/bash, puis résume fichiers changés + tests.",
  reviewer:
    "Tu es OMP Reviewer en lecture seule. Audite le diff, liste bloquants/mineurs " +
    "avec fichier:ligne + preuve, sans modifier. INTERDIT : edit, write, bash avec mutation.",
};

// Overlay --tools : whitelist par rôle (noms exacts vus via get_state).
export function toolsFor(role: Role): string {
  switch (role) {
    case "developer":
      return "read,bash,edit,glob,grep,find,task,wait,todo,write";
    default:
      // architect / researcher / reviewer : pas de edit/write, pas de task (spawn), pas de bash libre
      return "read,glob,grep,find,wait,todo";
  }
}

export function gitDiff(cwd: string, statOnly = false): string {
  try {
    const cmd = statOnly ? "git diff --stat" : "git diff --stat\n---\ngit diff";
    // stat d'abord, diff complet ensuite si demandé
    if (statOnly) return execSync("git diff --stat", { cwd, encoding: "utf8", timeout: 15000 }) || "(clean)";
    const stat = execSync("git diff --stat", { cwd, encoding: "utf8", timeout: 15000 });
    const diff = execSync("git diff", { cwd, encoding: "utf8", timeout: 15000 });
    return `${stat}\n---\n${diff.slice(0, 12000)}` || "(clean)";
  } catch (e: any) {
    return `diff error: ${e.message}`;
  }
}

export const REVIEW_GATE = `Gate review obligatoire :
1. git diff --stat + contenu
2. Bloquants (fichier:ligne + preuve) vs mineurs
3. Verdict : GO / FIX (liste précise) / RE-DESIGN
4. Jamais de modification par le reviewer.`;
