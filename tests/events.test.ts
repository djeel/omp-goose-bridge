import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "omp-bridge-test-"));
process.env.OMP_BRIDGE_DB = join(dir, "events.db");

const { eventAppend, eventList, pruneEvents, summarizeEvent, _resetDbForTests } =
  await import("../src/events/store.js");

beforeAll(() => _resetDbForTests());

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("events store", () => {
  test("append + list", () => {
    const id = eventAppend({ session_id: "s1", kind: "test", summary: "hello" });
    expect(id).toBeGreaterThan(0);
    const rows = eventList({ limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("hello");
  });

  test("filtre par session et kind", () => {
    eventAppend({ session_id: "s2", kind: "bridge_route", summary: "route" });
    expect(eventList({ session_id: "s2" }).every((e) => e.session_id === "s2")).toBe(true);
    expect(eventList({ kind: "bridge_route" }).every((e) => e.kind === "bridge_route")).toBe(true);
  });

  test("limite bornée", () => {
    for (let i = 0; i < 5; i++) eventAppend({ session_id: "s3", kind: "x", summary: `e${i}` });
    expect(eventList({ limit: 3 }).length).toBe(3);
  });

  test("prune conserve les plus récents", () => {
    const before = eventList({ limit: 500 }).length;
    if (before > 3) {
      pruneEvents(3);
      expect(eventList({ limit: 500 }).length).toBeLessThanOrEqual(3);
    }
  });

  test("summarizeEvent", () => {
    expect(summarizeEvent({ type: "session_settled" })).toBe("session_settled");
    expect(summarizeEvent({ type: "prompt_result", status: "completed" })).toContain("completed");
  });
});
