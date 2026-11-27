import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const fake = resolve(import.meta.dir, "fixtures", "fake-omp.ts");
const cfg = await import("../src/config.js");

describe("ompVersion / ompSupported", () => {
  test("faux OMP 19.x -> version lue, supportée", () => {
    process.env.OMP_BIN = fake;
    delete process.env.FAKE_OMP_VERSION;
    cfg._resetOmpVersionForTests();
    const v = cfg.ompVersion();
    expect(typeof v).toBe("string");
    expect(v).toContain("19.2.1");
    expect(cfg.ompSupported(v)).toBe(true);
  });

  test("faux OMP 18.x -> version lue, non supportée (alerte, pas panne)", () => {
    process.env.OMP_BIN = fake;
    process.env.FAKE_OMP_VERSION = "omp/18.0.0";
    cfg._resetOmpVersionForTests();
    try {
      const v = cfg.ompVersion();
      expect(v).toContain("18.0.0");
      expect(cfg.ompSupported(v)).toBe(false);
    } finally {
      delete process.env.FAKE_OMP_VERSION;
      delete process.env.OMP_BIN;
      cfg._resetOmpVersionForTests();
    }
  });

  test("binaire absent -> null, non supporté, pas d'exception", () => {
    process.env.OMP_BIN = "/inexistant/omp-xyz";
    cfg._resetOmpVersionForTests();
    try {
      expect(cfg.ompVersion()).toBeNull();
      expect(cfg.ompSupported(null)).toBe(false);
    } finally {
      delete process.env.OMP_BIN;
      cfg._resetOmpVersionForTests();
    }
  });

  test("httpRatePerMin : défaut 60, invalide -> 60", () => {
    delete process.env.OMP_BRIDGE_HTTP_RATE;
    expect(cfg.httpRatePerMin()).toBe(60);
    process.env.OMP_BRIDGE_HTTP_RATE = "nawak";
    expect(cfg.httpRatePerMin()).toBe(60);
    process.env.OMP_BRIDGE_HTTP_RATE = "10";
    expect(cfg.httpRatePerMin()).toBe(10);
    delete process.env.OMP_BRIDGE_HTTP_RATE;
  });
});
