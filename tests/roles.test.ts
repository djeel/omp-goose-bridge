import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const { toolsFor, gitDiff, gitDiffParts, REVIEW_GATE } = await import("../src/core/roles.js");

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
  test("NEED-MORE devient le 4e verdict du gate", () => {
    expect(REVIEW_GATE).toContain("NEED-MORE");
  });

  test("gros diff -> tronqué avec compteur de manquants", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-bigdiff-"));
    try {
      // Identité explicite : les runners CI (et certaines machines) n'ont pas de
      // user.name/user.email global — sans ça le commit échoue et le test casse.
      execSync(
        'git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init',
        { cwd: dir },
      );
      writeFileSync(join(dir, "big.txt"), "x".repeat(20000));
      execSync("git add -N big.txt", { cwd: dir }); // intent-to-add : visible dans git diff sans stager
      const parts = gitDiffParts(dir, 1000);
      expect(parts.stat.length).toBeGreaterThan(0);
      expect(parts.truncated).toBe(true);
      expect(parts.missing).toBeGreaterThan(0);
      expect(parts.diff.length).toBeLessThanOrEqual(1000);
      expect(gitDiff(dir)).toContain("NEED-MORE");
      expect(gitDiff(dir)).toContain("[DIFF TRONQUÉ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("dépôt propre -> (clean)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-diff-"));
    try {
      // Identité explicite : les runners CI (et certaines machines) n'ont pas de
      // user.name/user.email global — sans ça le commit échoue et le test casse.
      execSync(
        'git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init',
        { cwd: dir },
      );
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
