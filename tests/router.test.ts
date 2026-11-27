import { describe, expect, test } from "bun:test";
import { routeTask } from "../src/core/router.js";

describe("routeTask", () => {
  test("review prioritaire", () => {
    expect(routeTask("audite le diff").role).toBe("reviewer");
    expect(routeTask("relis ce patch").role).toBe("reviewer");
  });

  test("architecture", () => {
    expect(routeTask("planifie le refactor").role).toBe("architect");
    expect(routeTask("quelle structure pour ce module").role).toBe("architect");
  });

  test("recherche", () => {
    expect(routeTask("cherche la doc de zod").role).toBe("researcher");
    expect(routeTask("donne un exemple d'import").role).toBe("researcher");
  });

  test("mutation", () => {
    expect(routeTask("corrige le bug du router").role).toBe("developer");
    expect(routeTask("ajoute un test unitaire").role).toBe("developer");
  });

  test("accents normalisés", () => {
    expect(routeTask("corrigé le bug").role).toBe("developer");
    expect(routeTask("crée le fichier").role).toBe("developer");
  });

  test("pas de faux positif sous-chaîne", () => {
    // "editor" contient "edit" mais ne doit pas déclencher developer
    const d = routeTask("ouvre editor");
    expect(d.delegate).toBe(false);
  });

  test("noms d'artefacts seuls -> pas de spawn writer", () => {
    // Diagnostic ("ce test échoue, pourquoi ?") : architect, pas developer.
    expect(routeTask("ce test echoue, pourquoi ? " + "x".repeat(380)).role).toBe("architect");
    // Ordre d'écrire explicite : developer via le verbe, pas via "test".
    expect(routeTask("ajoute un test unitaire").role).toBe("developer");
  });

  test("petit prompt non délégué -> rôle null", () => {
    const d = routeTask("bonjour");
    expect(d.delegate).toBe(false);
    expect(d.role).toBeNull();
  });

  test("prompt long sans mutation -> architect lecture seule (pas de spawn writer)", () => {
    const d = routeTask("x".repeat(401));
    expect(d.delegate).toBe(true);
    expect(d.role).toBe("architect");
  });

  test("raison toujours fournie", () => {
    expect(routeTask("bonjour").reason.length).toBeGreaterThan(0);
  });

  test("entrée vide ou non-string ne casse pas", () => {
    expect(routeTask("").delegate).toBe(false);
    expect(routeTask(undefined as any).delegate).toBe(false);
  });

  test("review prioritaire sur mutation", () => {
    expect(routeTask("audite ce fix et corrige le diff").role).toBe("reviewer");
  });

  test("recherche prioritaire sur mutation", () => {
    expect(routeTask("cherche un exemple pour corriger ce bug").role).toBe("researcher");
  });
});
