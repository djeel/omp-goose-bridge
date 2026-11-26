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
const { createPanelServer } = await import("../src/apps/serve.js");

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
});
