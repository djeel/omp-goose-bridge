#!/usr/bin/env bun
/**
 * Micro-benchmarks OMP Bridge (aucune dépendance).
 * Usage : bun run bench [--json]
 *
 * Mesure les chemins chauds, pas le RPC OMP (dominé par le modèle) :
 *   - routeTask   : routage d'un prompt (regex + normalisation)
 *   - safeWorkspace / safeSessionPath : garde d'accès
 *   - eventAppend : écriture SQLite (WAL)
 *   - summarizeEvent / gitSummary : formatage + git
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "omp-bench-"));
process.env.OMP_BRIDGE_DB = join(dir, "bench.db");
process.env.OMP_BRIDGE_ROOTS = "/tmp";

const { routeTask } = await import("../src/core/router.js");
const { safeWorkspace, safeSessionPath } = await import("../src/workspace/guard.js");
const store = await import("../src/events/store.js");
const { gitSummary } = await import("../src/core/status.js");

type Bench = { name: string; iters: number; ms: number; perOpUs: number; opsPerSec: number };
const results: Bench[] = [];

function bench(name: string, iters: number, fn: () => void): void {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  const perOpUs = (ms * 1000) / iters;
  results.push({ name, iters, ms, perOpUs, opsPerSec: Math.round(1_000_000 / perOpUs) });
}

const prompts = [
  "relis le diff et donne un verdict",
  "implémente la pagination dans src/api.ts",
  "quelle lib pour parser du YAML ?",
  "planifie la migration vers Bun",
  "bonjour, ça va ?",
];

bench("routeTask", 20_000, () => {
  for (const p of prompts) routeTask(p);
});
bench("safeWorkspace", 10_000, () => safeWorkspace("/tmp/projet"));
bench("safeSessionPath", 10_000, () => safeSessionPath("/tmp/sessions/s1"));
bench("eventAppend", 2_000, () => {
  store.eventAppend({ session_id: "bench", kind: "prompt_result", summary: "x".repeat(64) });
});
bench("gitSummary", 20, () => gitSummary("/tmp"));

store._resetDbForTests();
rmSync(dir, { recursive: true, force: true });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("OMP Bridge — micro-benchmarks\n");
  for (const r of results) {
    const per = r.perOpUs.toFixed(2).padStart(9);
    const ops = r.opsPerSec.toLocaleString("en-US").padStart(12);
    console.log(`${r.name.padEnd(18)} ${String(r.iters).padStart(6)} iters  ${per} µs/op ${ops} ops/s`);
  }
}
