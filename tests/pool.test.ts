import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Faux OMP + DB/locks isolés, AVANT import du manager.
const fake = resolve(import.meta.dir, "fixtures", "fake-omp.ts");
chmodSync(fake, 0o755);
const dir = mkdtempSync(join(tmpdir(), "omp-pool-"));
process.env.OMP_BIN = fake;
process.env.OMP_BRIDGE_DB = join(dir, "p.db");
process.env.OMP_BRIDGE_LOCKS_DIR = join(dir, "locks");
process.env.OMP_BRIDGE_ROOTS = "/tmp:" + tmpdir();

const store = await import("../src/events/store.js");
store._resetDbForTests();
const mgr = await import("../src/core/session-manager.js");

afterAll(async () => {
  await mgr.sessionStopAll().catch(() => {});
  store._resetDbForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("pool read-only", () => {
  test("acquire deux fois -> même session chaude réutilisée", async () => {
    const a = await mgr.acquireReadOnly({ workspace: "/tmp", role: "reviewer", label: "r1" });
    expect(a.role).toBe("reviewer");
    mgr.releaseReadOnly(a);
    const b = await mgr.acquireReadOnly({ workspace: "/tmp", role: "reviewer", label: "r2" });
    expect(b.id).toBe(a.id);
    mgr.releaseReadOnly(b);
    await mgr.sessionStop(b.id);
  });

  test("workspaces différents -> sessions distinctes", async () => {
    const other = mkdtempSync(join(tmpdir(), "omp-ws-"));
    try {
      const a = await mgr.acquireReadOnly({ workspace: "/tmp", role: "reviewer" });
      const b = await mgr.acquireReadOnly({ workspace: other, role: "reviewer" });
      expect(b.id).not.toBe(a.id);
      await mgr.sessionStop(a.id);
      await mgr.sessionStop(b.id);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("developer refusé dans le pool", async () => {
    await expect(mgr.acquireReadOnly({ workspace: "/tmp", role: "developer" })).rejects.toThrow(/jamais poolé/);
  });

  test("release d'une session stoppée = sans effet", async () => {
    const a = await mgr.acquireReadOnly({ workspace: "/tmp", role: "architect" });
    await mgr.sessionStop(a.id);
    expect(() => mgr.releaseReadOnly(a)).not.toThrow();
  });

  test("cap : pool plein -> la session en trop est stoppée, pas empilée", async () => {
    process.env.OMP_BRIDGE_POOL_MAX = "1";
    try {
      const a = await mgr.acquireReadOnly({ workspace: "/tmp", role: "reviewer" });
      mgr.releaseReadOnly(a);
      expect(mgr.poolStats().pooled).toBe(1);
      const b = await mgr.acquireReadOnly({ workspace: "/tmp", role: "architect" });
      mgr.releaseReadOnly(b); // pool plein -> stop
      await new Promise((r) => setTimeout(r, 50));
      expect(mgr.poolStats().pooled).toBe(1);
      // La 2e session n'est plus acquérable : le prochain acquire crée du neuf.
      const c = await mgr.acquireReadOnly({ workspace: "/tmp", role: "architect" });
      expect(c.id).not.toBe(b.id);
      await mgr.sessionStop(c.id);
      await mgr.sessionStop(a.id);
    } finally {
      delete process.env.OMP_BRIDGE_POOL_MAX;
    }
  });

  test("stats hit/miss et parsing des knobs", async () => {
    const before = mgr.poolStats();
    const a = await mgr.acquireReadOnly({ workspace: "/tmp", role: "reviewer" });
    mgr.releaseReadOnly(a);
    const b = await mgr.acquireReadOnly({ workspace: "/tmp", role: "reviewer" });
    expect(b.id).toBe(a.id);
    const after = mgr.poolStats();
    expect(after.misses).toBeGreaterThan(before.misses);
    expect(after.hits).toBeGreaterThan(before.hits);
    await mgr.sessionStop(a.id);
    // Knobs invalides -> défauts sains, jamais NaN/0.
    process.env.OMP_BRIDGE_POOL_MAX = "nawak";
    process.env.OMP_BRIDGE_POOL_IDLE = "-5";
    process.env.OMP_BRIDGE_POOL_ROTATE = "0";
    expect(mgr.poolMax()).toBe(4);
    expect(mgr.poolIdleMs()).toBe(300_000);
    expect(mgr.poolRotateMs()).toBe(1_800_000);
    delete process.env.OMP_BRIDGE_POOL_MAX;
    delete process.env.OMP_BRIDGE_POOL_IDLE;
    delete process.env.OMP_BRIDGE_POOL_ROTATE;
  });
});
