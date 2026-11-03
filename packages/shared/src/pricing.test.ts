import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  CHANNEL_INTEGRATION,
  CHANNEL_LABEL,
  CHANNEL_TITLE_MAX,
  FEE_NOTES,
  INDICATIVE_FEES,
  applyPriceRule,
  feePreview,
  formatMoney,
} from "./pricing.js";

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
    const rates = { EBAY: { percentBps: 1000, fixedCents: 0 } };
    expect(feePreview(5000, "EBAY", rates).netCents).toBe(4500);
    // Canal absent des taux personnalisés : taux indicatif.
    expect(feePreview(10000, "AMAZON", rates).feeCents).toBe(1500);
  });

  it("Poshmark : forfait 2,95 $ sous 15 $, puis 20 %", () => {
    expect(feePreview(1499, "POSHMARK").feeCents).toBe(295);
    expect(feePreview(1500, "POSHMARK").feeCents).toBe(300);
    expect(feePreview(5000, "POSHMARK").feeCents).toBe(1000);
  });

  it("Facebook Marketplace : 10 % avec 0,80 $ minimum", () => {
    expect(feePreview(500, "FACEBOOK_MARKETPLACE").feeCents).toBe(80);
    expect(feePreview(5000, "FACEBOOK_MARKETPLACE").feeCents).toBe(500);
  });

  it("Etsy, Depop et Vinted", () => {
    expect(feePreview(10000, "ETSY").feeCents).toBe(995); // 9,5 % + 0,45 $
    expect(feePreview(10000, "DEPOP").feeCents).toBe(375); // 3,3 % + 0,45 $
    expect(feePreview(10000, "VINTED")).toEqual({ priceCents: 10000, feeCents: 0, netCents: 10000 });
  });

  it("les frais ne dépassent jamais le prix", () => {
    expect(feePreview(30, "EBAY")).toEqual({ priceCents: 30, feeCents: 30, netCents: 0 });
  });
});

describe("liste des canaux", () => {
  it("chaque canal a un nom, une limite de titre, des frais et un type de connexion", () => {
    for (const c of CHANNELS) {
      expect(CHANNEL_LABEL[c]).toBeTruthy();
      expect(CHANNEL_TITLE_MAX[c]).toBeGreaterThan(0);
      expect(INDICATIVE_FEES[c]).toBeDefined();
      expect(FEE_NOTES[c].fr && FEE_NOTES[c].en).toBeTruthy();
      expect(["api", "assisted"]).toContain(CHANNEL_INTEGRATION[c]);
    }
  });
});

describe("formatMoney", () => {
  it("formate en dollars", () => {
    expect(formatMoney(1999).replace(/\s/g, " ")).toBe("19,99 $US");
  });
});
