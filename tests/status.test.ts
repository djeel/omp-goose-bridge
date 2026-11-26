import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gitSummary, devStatus, devStatusMarkdown } from "../src/core/status.js";

const repoRoot = resolve(import.meta.dir, "..");
const plain = mkdtempSync(join(tmpdir(), "omp-nogit-"));

describe("gitSummary", () => {
  test("détecte un dépôt et sa branche", () => {
    const g = gitSummary(repoRoot);
    expect(g.isRepo).toBe(true);
    expect(g.branch.length).toBeGreaterThan(0);
    expect(g.dirty).toBeGreaterThanOrEqual(0);
  });

  test("hors dépôt : isRepo=false, pas de crash", () => {
    const g = gitSummary(plain);
    expect(g.isRepo).toBe(false);
    expect(g.branch).toBe("?");
    expect(g.dirty).toBe(0);
  });

  test("cwd inexistant : pas de crash", () => {
    const g = gitSummary("/chemin/qui/n/existe/pas");
    expect(g.isRepo).toBe(false);
  });
});

describe("devStatus", () => {
  test("agrège sessions + git", () => {
    const d = devStatus(repoRoot);
    expect(d.connected).toBe(true);
    expect(Array.isArray(d.sessions)).toBe(true);
    expect(d.git.stat.length).toBeGreaterThan(0);
  });

  test("markdown contient workspace et sessions", () => {
    const md = devStatusMarkdown(repoRoot);
    expect(md).toContain("Workspace");
    expect(md).toContain("Sessions (");
  });

  test("hors dépôt : mention explicite", () => {
    const md = devStatusMarkdown(plain);
    expect(md).toContain("pas un dépôt git");
  });
});
