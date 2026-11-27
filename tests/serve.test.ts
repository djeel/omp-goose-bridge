import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Env AVANT import (dbPath/roots sont lus dynamiquement).
const dir = mkdtempSync(join(tmpdir(), "omp-http-"));
process.env.OMP_BRIDGE_DB = join(dir, "http.db");
process.env.OMP_BRIDGE_ROOTS = "/tmp";

const store = await import("../src/events/store.js");
store._resetDbForTests();
const { createPanelServer, _resetPostHitsForTests } = await import("../src/apps/serve.js");
const cfg = await import("../src/config.js");

let server: any;
let base = "";

beforeAll(() => {
  server = createPanelServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try {
    server?.stop(true);
  } catch {}
  try {
    store._resetDbForTests();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("panneau HTTP", () => {
  test("GET /healthz renvoie un diagnostic JSON", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.ok).toBe(true);
    expect(j.name).toBe("omp-bridge");
    expect(typeof j.version).toBe("string");
    expect(Array.isArray(j.workspace_roots)).toBe(true);
  });

  test("GET / sert le panneau HTML", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("<html");
  });

  test("POST sans Origin (curl) accepté", async () => {
    const r = await fetch(`${base}/mcp/omp_sessions_list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
  });

  test("POST d'origine distante refusé (anti-CSRF)", async () => {
    const r = await fetch(`${base}/mcp/omp_sessions_list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("refusée");
  });

  test("workspace hors allowlist refusé", async () => {
    const r = await fetch(`${base}/mcp/omp_dev_status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/etc" }),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("refusé");
  });

  test("outil inconnu -> 404", async () => {
    const r = await fetch(`${base}/mcp/omp_nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(404);
  });

  test("token requis quand OMP_BRIDGE_TOKEN est défini", async () => {
    process.env.OMP_BRIDGE_TOKEN = "s3cret";
    try {
      const sans = await fetch(`${base}/mcp/omp_dev_status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp" }),
      });
      expect(sans.status).toBe(401);
      expect(await sans.text()).toContain("token");

      const avec = await fetch(`${base}/mcp/omp_dev_status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-omp-bridge-token": "s3cret" },
        body: JSON.stringify({ workspace: "/tmp" }),
      });
      expect(avec.status).toBe(200);
    } finally {
      delete process.env.OMP_BRIDGE_TOKEN;
    }
  });

  test("omp_dev_status_json renvoie du JSON structuré", async () => {
    const r = await fetch(`${base}/mcp/omp_dev_status_json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/tmp" }),
    });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.connected).toBe(true);
    expect(Array.isArray(j.sessions)).toBe(true);
  });

  test("healthz expose la version OMP et son support", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect("omp_version" in j).toBe(true);
    expect(typeof j.omp_supported).toBe("boolean");
    expect(cfg.ompSupported("omp/19.2.1")).toBe(true);
    expect(cfg.ompSupported("omp/18.0.0")).toBe(false);
    expect(cfg.ompSupported(null)).toBe(false);
  });

  test("rate-limit des POST sans token (429 au-delà du plafond)", async () => {
    process.env.OMP_BRIDGE_HTTP_RATE = "3";
    _resetPostHitsForTests();
    try {
      const post = () =>
        fetch(`${base}/mcp/omp_sessions_list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      const limited = await post();
      expect(limited.status).toBe(429);
      expect(await limited.text()).toContain("requêtes");
    } finally {
      delete process.env.OMP_BRIDGE_HTTP_RATE;
      _resetPostHitsForTests();
    }
  });

  test("pas de rate-limit quand un token est configuré", async () => {
    process.env.OMP_BRIDGE_TOKEN = "s3cret";
    process.env.OMP_BRIDGE_HTTP_RATE = "1";
    _resetPostHitsForTests();
    try {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${base}/mcp/omp_sessions_list`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-omp-bridge-token": "s3cret" },
          body: "{}",
        });
        expect(r.status).toBe(200);
      }
    } finally {
      delete process.env.OMP_BRIDGE_TOKEN;
      delete process.env.OMP_BRIDGE_HTTP_RATE;
      _resetPostHitsForTests();
    }
  });
});
