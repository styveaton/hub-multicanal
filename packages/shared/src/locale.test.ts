import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage, resolveLocale } from "./locale.js";

describe("localeFromAcceptLanguage", () => {
  it("prend la première langue gérée", () => {
    expect(localeFromAcceptLanguage("fr-CA,fr;q=0.9,en;q=0.8")).toBe("fr");
    expect(localeFromAcceptLanguage("en-US,en;q=0.9,fr;q=0.8")).toBe("en");
  });
  it("saute les langues non gérées", () => {
    expect(localeFromAcceptLanguage("de-DE,de;q=0.9,fr;q=0.7,en;q=0.5")).toBe("fr");
  });
  it("respecte les poids q, pas seulement l'ordre", () => {
    expect(localeFromAcceptLanguage("en;q=0.5,fr")).toBe("fr");
  });
  it("renvoie null sans langue gérée", () => {
    expect(localeFromAcceptLanguage("de,es")).toBeNull();
    expect(localeFromAcceptLanguage("")).toBeNull();
    expect(localeFromAcceptLanguage(undefined)).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("le choix de l'utilisateur prime sur le navigateur", () => {
    expect(resolveLocale({ cookie: "en", acceptLanguage: "fr-FR" })).toBe("en");
  });
  it("ignore un cookie invalide", () => {
    expect(resolveLocale({ cookie: "xx", acceptLanguage: "fr-FR" })).toBe("fr");
  });
  it("anglais par défaut", () => {
    expect(resolveLocale({ acceptLanguage: "ja-JP" })).toBe("en");
    expect(resolveLocale({})).toBe("en");
  });
});
