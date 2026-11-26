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

/**
 * Compile une catégorie en UNE regex (bornes de mot partagées) : "edit" ne
 * matche pas "editor", et on évite de construire N regex par appel.
 */
function compile(keys: string[]): RegExp {
  const alt = keys.map(escapeRe).join("|");
  return new RegExp(`(?:^|[^a-z0-9])(?:${alt})(?:[^a-z0-9]|$)`, "i");
}

const RX_REVIEW = compile(REVIEW);
const RX_ARCHI = compile(ARCHI);
const RX_SEARCH = compile(SEARCH);
const RX_DEV = compile(DEV);

export function routeTask(text: string): RouteDecision {
  const t = normalizeText(String(text ?? ""));
  if (RX_REVIEW.test(t))
    return { delegate: true, role: "reviewer", reason: "mot-clé review/audit" };
  if (RX_ARCHI.test(t))
    return { delegate: true, role: "architect", reason: "mot-clé architecture/plan" };
  if (RX_SEARCH.test(t))
    return { delegate: true, role: "researcher", reason: "mot-clé recherche/docs" };
  if (RX_DEV.test(t))
    return { delegate: true, role: "developer", reason: "mot-clé mutation" };
  if (t.length > 400)
    // Long sans mot-clé de mutation : plan lecture seule plutôt que writer.
    // Un spawn developer à froid coûte cher ; l'architecte peut demander
    // la délégation écriture ensuite si besoin.
    return { delegate: true, role: "architect", reason: "prompt long, plan lecture seule par défaut" };
  return { delegate: false, role: null, reason: "petit, Goose direct" };
}
