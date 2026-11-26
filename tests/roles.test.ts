import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const { toolsFor, gitDiff } = await import("../src/core/roles.js");

describe("toolsFor", () => {
  test("developer = seul writer complet", () => {
    const t = toolsFor("developer").split(",");
    for (const tool of ["read", "bash", "edit", "glob", "grep", "find", "task", "wait", "todo", "write"]) {
      expect(t).toContain(tool);
    }
  });

  test("researcher peut chercher sur le web, sans mutation ni spawn", () => {
    const t = toolsFor("researcher").split(",");
    expect(t).toContain("web_search");
    for (const banned of ["edit", "write", "bash", "task"]) {
      expect(t).not.toContain(banned);
    }
  });

  test("architect/reviewer naviguent le code (lsp), sans mutation", () => {
    for (const role of ["architect", "reviewer"] as const) {
      const t = toolsFor(role).split(",");
      expect(t).toContain("lsp");
      for (const banned of ["edit", "write", "bash", "task"]) {
        expect(t).not.toContain(banned);
      }
    }
  });
});

describe("gitDiff", () => {
  test("dépôt propre -> (clean)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-diff-"));
    try {
      execSync("git init -q && git commit -q --allow-empty -m init", { cwd: dir });
      expect(gitDiff(dir, true)).toBe("(clean)");
      expect(gitDiff(dir, false)).toBe("(clean)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hors dépôt -> message explicite, pas d'exception", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-nogit-"));
    try {
      expect(gitDiff(dir, false)).toMatch(/pas un dépôt git/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
