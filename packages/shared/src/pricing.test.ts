import { describe, expect, it } from "vitest";
import { applyPriceRule, feePreview, formatMoney } from "./pricing.js";

describe("prix par canal (US5)", () => {
  it("BASE reprend le prix maître", () => {
    expect(applyPriceRule(2500, { mode: "BASE" })).toBe(2500);
  });

  it("FIXED impose un prix", () => {
    expect(applyPriceRule(2500, { mode: "FIXED", priceCents: 2999 })).toBe(2999);
  });

  it("PERCENT applique une hausse ou une baisse, arrondie au centime", () => {
    expect(applyPriceRule(2500, { mode: "PERCENT", percentBps: 1000 })).toBe(2750); // +10 %
    expect(applyPriceRule(2500, { mode: "PERCENT", percentBps: -500 })).toBe(2375); // -5 %
    expect(applyPriceRule(999, { mode: "PERCENT", percentBps: 1550 })).toBe(1154); // 11,538… → 11,54
  });

  it("le prix ne descend jamais sous 1 centime", () => {
    expect(applyPriceRule(1, { mode: "PERCENT", percentBps: -9000 })).toBe(1);
  });
});

describe("aperçu des frais (US5)", () => {
  it("eBay : pourcentage + frais fixes", () => {
    // 100,00 $ : 13,25 $ + 0,40 $ = 13,65 $ de frais
    expect(feePreview(10000, "EBAY")).toEqual({ priceCents: 10000, feeCents: 1365, netCents: 8635 });
  });

  it("Amazon et TikTok Shop : pourcentage seul", () => {
    expect(feePreview(10000, "AMAZON").feeCents).toBe(1500);
    expect(feePreview(10000, "TIKTOK_SHOP").feeCents).toBe(800);
  });

  it("accepte des taux personnalisés", () => {
    const rates = {
      EBAY: { percentBps: 1000, fixedCents: 0, note: "" },
      AMAZON: { percentBps: 0, fixedCents: 0, note: "" },
      TIKTOK_SHOP: { percentBps: 0, fixedCents: 0, note: "" },
    };
    expect(feePreview(5000, "EBAY", rates).netCents).toBe(4500);
  });
});

describe("formatMoney", () => {
  it("formate en dollars", () => {
    expect(formatMoney(1999).replace(/\s/g, " ")).toBe("19,99 $US");
  });
});
