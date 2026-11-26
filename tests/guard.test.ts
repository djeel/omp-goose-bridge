import { describe, expect, test, beforeEach } from "bun:test";
import { resolve } from "node:path";
import { symlinkSync, rmSync } from "node:fs";

// Les racines autorisées sont lues au chargement du module : on fixe l'env avant l'import.
process.env.OMP_BRIDGE_ROOTS = "/tmp:/home/test/work";
const { safeWorkspace, tryAcquireWriter, releaseWriter, writerHolder, safeSessionPath, _resetLocksForTests } =
  await import("../src/workspace/guard.js");
beforeEach(() => _resetLocksForTests());

describe("safeWorkspace", () => {
  test("accepte une racine autorisée", () => {
    expect(safeWorkspace("/tmp")).toBe("/tmp");
    expect(safeWorkspace("/tmp/projet")).toBe("/tmp/projet");
  });

  test("normalise les chemins relatifs et ..", () => {
    expect(safeWorkspace("/tmp/a/../b")).toBe("/tmp/b");
  });

  test("rejette un chemin hors allowlist", () => {
    expect(() => safeWorkspace("/etc")).toThrow(/refusé/);
    expect(() => safeWorkspace("/home/test/other")).toThrow(/refusé/);
  });

  test("rejette l'évasion par préfixe", () => {
    expect(() => safeWorkspace("/home/test/work-evil")).toThrow(/refusé/);
  });

  test("rejette un workspace vide", () => {
    expect(() => safeWorkspace("")).toThrow(/vide/);
  });

  test("workspace par défaut = première racine autorisée", () => {
    expect(safeWorkspace(undefined)).toBe("/tmp");
  });

  test("rejette l'évasion par symlink", () => {
    const link = `/tmp/omp-bridge-evil-${process.pid}`;
    try {
      rmSync(link, { force: true });
    } catch {}
    symlinkSync("/etc", link);
    try {
      expect(() => safeWorkspace(link)).toThrow(/refusé/);
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe("single-writer lock", () => {
  const ws = resolve("/tmp/projet-lock");

  test("un seul writer par workspace", () => {
    tryAcquireWriter(ws, "s1");
    expect(writerHolder(ws)).toBe("s1");
    expect(() => tryAcquireWriter(ws, "s2")).toThrow(/verrouillé/);
  });

  test("le même writer peut ré-acquérir", () => {
    tryAcquireWriter(ws, "s1");
    expect(() => tryAcquireWriter(ws, "s1")).not.toThrow();
  });

  test("release libère pour un autre writer", () => {
    tryAcquireWriter(ws, "s1");
    releaseWriter(ws, "s1");
    expect(writerHolder(ws)).toBeNull();
    expect(() => tryAcquireWriter(ws, "s2")).not.toThrow();
  });

  test("release par un non-holder est sans effet", () => {
    tryAcquireWriter(ws, "s1");
    releaseWriter(ws, "s2");
    expect(writerHolder(ws)).toBe("s1");
  });
});

describe("safeSessionPath", () => {
  test("accepte un chemin sous une racine autorisée", () => {
    expect(safeSessionPath("/tmp/sessions/s1")).toBe("/tmp/sessions/s1");
  });

  test("accepte un chemin sous le dossier de sessions", () => {
    const root = resolve(process.env.HOME ?? "/root", ".local", "share", "omp-bridge", "sessions");
    expect(safeSessionPath(`${root}/abc.session`)).toBe(`${root}/abc.session`);
  });

  test("refuse un chemin hors périmètre", () => {
    expect(() => safeSessionPath("/etc/passwd")).toThrow(/refusé/);
  });

  test("refuse un chemin vide", () => {
    expect(() => safeSessionPath("")).toThrow(/vide/);
  });

  test("refuse l'évasion par symlink", () => {
    const link = `/tmp/omp-bridge-sess-${process.pid}`;
    try {
      rmSync(link, { force: true });
    } catch {}
    symlinkSync("/etc", link);
    try {
      expect(() => safeSessionPath(`${link}/x.session`)).toThrow(/refusé/);
    } finally {
      rmSync(link, { force: true });
    }
  });
});
