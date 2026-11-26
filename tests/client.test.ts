import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Faux binaire OMP + DB isolée, AVANT import du client.
const fake = resolve(import.meta.dir, "fixtures", "fake-omp.ts");
chmodSync(fake, 0o755);
const dir = mkdtempSync(join(tmpdir(), "omp-client-"));
process.env.OMP_BIN = fake;
process.env.OMP_BRIDGE_DB = join(dir, "c.db");

const store = await import("../src/events/store.js");
store._resetDbForTests();
const { OmpRpc } = await import("../src/rpc/client.js");

afterAll(() => {
  store._resetDbForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("OmpRpc (faux OMP)", () => {
  test("handshake + prompt aller-retour", async () => {
    const rpc = new OmpRpc();
    await rpc.start({ cwd: "/tmp" });
    const state: any = await rpc.getState();
    expect(state.data.model.id).toBe("fake-model");

    const text = await rpc.promptAndWait("bonjour");
    expect(text).toContain("echo: bonjour");
    await rpc.stop();
  });

  test("les événements sont journalisés (prompt_result)", async () => {
    const rpc = new OmpRpc();
    rpc.setBridgeSessionId("test-events");
    await rpc.start({ cwd: "/tmp" });
    await rpc.promptAndWait("x");
    const { eventList } = store;
    const kinds = eventList({ session_id: "test-events" }).map((e) => e.kind);
    expect(kinds).toContain("prompt_result");
    // message_update ne doit JAMAIS être persisté (bruit SQLite)
    expect(kinds).not.toContain("message_update");
    await rpc.stop();
  });

  test("abort rejette immédiatement l'attente", async () => {
    process.env.FAKE_OMP_SLOW = "1";
    const rpc = new OmpRpc();
    await rpc.start({ cwd: "/tmp" });
    const p = rpc.promptAndWait("lent");
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    await rpc.abort();
    await expect(p).rejects.toThrow(/aborted/);
    await rpc.stop();
    delete process.env.FAKE_OMP_SLOW;
  }, 15000);

  test("crash du process pendant un prompt -> rejet rapide", async () => {
    process.env.FAKE_OMP_CRASH = "1";
    const rpc = new OmpRpc();
    await rpc.start({ cwd: "/tmp" });
    const p = rpc.promptAndWait("boom");
    p.catch(() => {});
    await expect(p).rejects.toThrow(/terminé|code=/);
    await rpc.stop();
    delete process.env.FAKE_OMP_CRASH;
  }, 15000);

  test("binaire introuvable -> message explicite", async () => {
    const saved = process.env.OMP_BIN;
    process.env.OMP_BIN = "/nonexistent/omp-binary";
    const rpc = new OmpRpc();
    await expect(rpc.start({ cwd: "/tmp" })).rejects.toThrow(/introuvable/);
    process.env.OMP_BIN = saved;
  });
});
