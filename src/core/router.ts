import type { Role } from "../core/roles.js";

// Routeur auto : decide seul si Goose doit deleguer a OMP et vers quel role.
// Deterministe, sans LLM (rapide, auditable, testable).

const DEV = [
  "edit", "write", "modifie", "cree", "implemente",
  "refactor", "corrige", "fix", "ajoute", "supprime", "migre", "ecris",
  "patch", "commit", "test", "build",
];
const ARCHI = ["architect", "plan", "conception", "structure", "dependan", "design", "schema"];
const SEARCH = ["cherche", "documentation", "quelle lib", "compare", "exemple", "comment faire"];
const REVIEW = ["relis", "review", "audit", "verdict", "gate", "bloquant", "diff"];

export interface RouteDecision {
  delegate: boolean;
  role: Role;
  reason: string;
}

export function routeTask(text: string): RouteDecision {
  const t = text.toLowerCase();
  const has = (ks: string[]) => ks.some((k) => t.includes(k));
  if (has(REVIEW)) return { delegate: true, role: "reviewer", reason: "mot-cle review/audit" };
  if (has(ARCHI)) return { delegate: true, role: "architect", reason: "mot-cle architecture/plan" };
  if (has(SEARCH)) return { delegate: true, role: "researcher", reason: "mot-cle recherche/docs" };
  if (has(DEV)) return { delegate: true, role: "developer", reason: "mot-cle mutation" };
  if (t.length > 400) return { delegate: true, role: "developer", reason: "long prompt, delegation par defaut" };
  return { delegate: false, role: "researcher", reason: "petit, Goose direct" };
}
