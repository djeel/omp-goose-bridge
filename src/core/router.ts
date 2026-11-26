import type { Role } from "./roles.js";

// Routeur auto : décide si Goose doit déléguer à OMP et vers quel rôle.
// Déterministe, sans LLM (rapide, auditable, testable).

const DEV = [
  "edit", "write", "modifie", "modifier", "cree", "creer", "implemente",
  "implementer", "refactor", "refactorise", "corrige", "corriger", "fix",
  "ajoute", "ajouter", "supprime", "supprimer", "migre", "migrer", "ecris",
  "ecrire", "patch", "commit", "test", "tester", "build",
];
const ARCHI = [
  "architect", "architecture", "plan", "planifie", "planifier", "planification",
  "conception", "concevoir", "structure", "dependance", "dependances", "design",
  "schema",
];
const SEARCH = [
  "cherche", "chercher", "documentation", "doc", "quelle lib", "compare",
  "comparer", "exemple", "comment faire",
];
const REVIEW = [
  "relis", "relire", "review", "audit", "audite", "auditer", "verdict", "gate",
  "bloquant", "bloquants", "diff",
];

export interface RouteDecision {
  delegate: boolean;
  role: Role | null;
  reason: string;
}

/** Normalise : minuscules + suppression des accents. */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matching par mot/expression entière : "edit" ne matche pas "editor". */
function hasKeyword(text: string, keys: string[]): boolean {
  return keys.some((k) =>
    new RegExp(`(^|[^a-z0-9])${escapeRe(k)}([^a-z0-9]|$)`, "i").test(text),
  );
}

export function routeTask(text: string): RouteDecision {
  const t = normalizeText(String(text ?? ""));
  if (hasKeyword(t, REVIEW))
    return { delegate: true, role: "reviewer", reason: "mot-clé review/audit" };
  if (hasKeyword(t, ARCHI))
    return { delegate: true, role: "architect", reason: "mot-clé architecture/plan" };
  if (hasKeyword(t, SEARCH))
    return { delegate: true, role: "researcher", reason: "mot-clé recherche/docs" };
  if (hasKeyword(t, DEV))
    return { delegate: true, role: "developer", reason: "mot-clé mutation" };
  if (t.length > 400)
    return { delegate: true, role: "developer", reason: "prompt long, délégation par défaut" };
  return { delegate: false, role: null, reason: "petit, Goose direct" };
}
