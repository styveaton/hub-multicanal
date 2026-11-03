import { describe, expect, it } from "vitest";
import { depopIssues } from "@hub/shared";
import { MediaSigner, TokenCipher, pkceChallenge, randomToken } from "./crypto.js";
import { DepopApiError, DepopClient } from "./depop/client.js";
import { FAKE_DEPOP_CLIENT_ID, FAKE_DEPOP_CLIENT_SECRET, FakeDepop } from "./depop/fake.js";
import { buildDepopBody } from "./depop/mapping.js";

describe("chiffrement des jetons", () => {
  const cipher = TokenCipher.fromSecret("test");

  it("chiffre puis déchiffre ; deux chiffrements diffèrent", () => {
    const a = cipher.encrypt("pat_secret");
    expect(a).not.toContain("pat_secret");
    expect(a).not.toBe(cipher.encrypt("pat_secret"));
    expect(cipher.decrypt(a)).toBe("pat_secret");
  });

  it("refuse un jeton modifié ou chiffré avec une autre clé", () => {
    const a = cipher.encrypt("pat_secret");
    const [v, iv, tag, data] = a.split(".");
    const flipped = `${v}.${iv}.${tag}.${data!.slice(0, -2)}AA`;
    expect(() => cipher.decrypt(flipped)).toThrow();
    expect(() => TokenCipher.fromSecret("autre").decrypt(a)).toThrow();
  });

  it("exige une clé de 32 octets", () => {
    expect(() => TokenCipher.fromBase64(Buffer.alloc(16).toString("base64"))).toThrow();
  });
});

describe("liens publics des photos", () => {
  const signer = new MediaSigner("secret", "https://app.test/api");
  const now = Date.UTC(2026, 10, 3);

  it("lien valide jusqu'à expiration", () => {
    const url = new URL(signer.url("ph1", 3600, now));
    expect(url.pathname).toBe("/api/public/photos/ph1");
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    expect(signer.verify("ph1", exp, sig, now)).toBe(true);
    expect(signer.verify("ph1", exp, sig, now + 3601_000)).toBe(false);
    expect(signer.verify("ph2", exp, sig, now)).toBe(false);
    expect(new MediaSigner("autre", "x").verify("ph1", exp, sig, now)).toBe(false);
  });
});

describe("client Depop (contre le faux Depop)", () => {
  const fake = new FakeDepop();
  const client = new DepopClient({ baseUrl: "https://depop.test", clientId: FAKE_DEPOP_CLIENT_ID, clientSecret: FAKE_DEPOP_CLIENT_SECRET, fetch: fake.fetch });
  const redirectUri = "https://app.test/api/channels/depop/callback";

  async function connect() {
    const verifier = randomToken();
    const back = new URL(
      fake.authorize(
        new URLSearchParams({
          response_type: "code",
          client_id: FAKE_DEPOP_CLIENT_ID,
          redirect_uri: redirectUri,
          state: "s1",
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: "S256",
        }),
      ),
    );
    return { code: back.searchParams.get("code")!, verifier, state: back.searchParams.get("state") };
  }

  it("OAuth avec PKCE : code → jetons → boutique", async () => {
    const { code, verifier, state } = await connect();
    expect(state).toBe("s1");
    const tokens = await client.exchangeCode(code, redirectUri, verifier);
    expect(tokens.access_token).toMatch(/^pat_/);
    expect((await client.getShop(tokens.access_token)).username).toBe("omnilist_demo");
    // Un code ne sert qu'une fois.
    await expect(client.exchangeCode(code, redirectUri, verifier)).rejects.toMatchObject({ code: "invalid_grant", retryable: false });
  });

  it("refuse un mauvais vérificateur PKCE", async () => {
    const { code } = await connect();
    await expect(client.exchangeCode(code, redirectUri, randomToken())).rejects.toBeInstanceOf(DepopApiError);
  });

  it("rafraîchit le jeton ; l'ancien jeton de rafraîchissement ne sert plus", async () => {
    const { code, verifier } = await connect();
    const first = await client.exchangeCode(code, redirectUri, verifier);
    const second = await client.refresh(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    await expect(client.refresh(first.refresh_token)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("annonce : création, mise à jour par SKU, vente, suppression ; 401 sans jeton", async () => {
    const { code, verifier } = await connect();
    const { access_token } = await client.exchangeCode(code, redirectUri, verifier);
    const body = buildDepopBody({
      product: { title: "Veste en jean", description: "Très bon état.", brand: "Levi's", condition: "USED_GOOD", currency: "USD" },
      details: { department: "menswear", productType: "jackets", sizeId: 4, shippingCents: 599 },
      item: { sku: "VESTE-1", priceCents: 4500, quantity: 1 },
      pictureUrls: ["https://app.test/p1"],
      shipFromState: "CA",
    });
    const created = await client.putProduct(access_token, "VESTE-1", body);
    const updated = await client.putProduct(access_token, "VESTE-1", { ...body, price_amount: "40.00" });
    expect(updated.product_id).toBe(created.product_id);
    expect(fake.products.get("VESTE-1")?.body.price_amount).toBe("40.00");
    await client.markSold(access_token, "VESTE-1");
    expect(fake.products.get("VESTE-1")?.status).toBe("sold");
    await client.deleteProduct(access_token, "VESTE-1");
    await client.deleteProduct(access_token, "VESTE-1"); // idempotent
    expect(fake.products.has("VESTE-1")).toBe(false);
    await expect(client.getShop("pat_inconnu")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("erreurs : 422 définitive, 429 à relancer", async () => {
    const { code, verifier } = await connect();
    const { access_token } = await client.exchangeCode(code, redirectUri, verifier);
    fake.failNextPut = { status: 422, body: { errors: [{ code: "invalid_brand", message: "Invalid brand" }] } };
    await expect(client.putProduct(access_token, "X", {} as never)).rejects.toMatchObject({ code: "invalid_brand", retryable: false });
    fake.failNextPut = { status: 429, body: { error: "TOO_MANY_REQUESTS", error_description: "Too many requests" } };
    await expect(client.putProduct(access_token, "X", {} as never)).rejects.toMatchObject({ status: 429, retryable: true });
  });
});

describe("fiche → annonce Depop", () => {
  const product = { title: "Veste en jean", description: "Années 90.", brand: "Levi's", condition: "USED_GOOD" as const, currency: "USD" };

  it("article unique : description = titre + texte, taille, état, prix et port", () => {
    const body = buildDepopBody({
      product,
      details: { department: "menswear", productType: "jackets", sizeId: 4, shippingCents: 0 },
      item: { sku: "V1", priceCents: 4550, quantity: 1 },
      pictureUrls: Array.from({ length: 10 }, (_, i) => `https://app.test/p${i}`),
      shipFromState: "NY",
    });
    expect(body).toMatchObject({
      address: { country_code: "US", state: "NY" },
      description: "Veste en jean\n\nAnnées 90.",
      price_currency: "USD",
      price_amount: "45.50",
      quantity: 1,
      department: "menswear",
      product_type: "jackets",
      size_set_id: 95,
      size_id: 4,
      condition: "used_excellent",
      brand_name: "Levi's",
      national_shipping_cost: "0.00",
    });
    expect(body.pictures).toHaveLength(8);
  });

  it("variante : la taille vient de l'option Taille", () => {
    const body = buildDepopBody({
      product,
      details: { department: "menswear", productType: "tshirts", shippingCents: 500 },
      item: { sku: "TS-L", priceCents: 2000, quantity: 3, attributes: { Taille: "L", Couleur: "Noir" } },
      pictureUrls: ["https://app.test/p"],
      shipFromState: "TX",
    });
    expect(body).toMatchObject({ size_set_id: 54, size_id: 5, quantity: 3 });
  });

  it("contrôles avant publication", () => {
    const issues = depopIssues({
      mode: "VARIANTS",
      title: "T-shirt #a #b #c",
      description: "#d #e #f contact moi@exemple.com",
      brand: null,
      details: { department: "menswear", productType: "tshirts" },
      items: [
        { sku: "TS-M", priceCents: 2000, attributes: { Taille: "M" } },
        { sku: "TS-X", priceCents: 50, attributes: { Taille: "Énorme" } },
      ],
    });
    expect(issues).toEqual([
      { code: "size_unmatched", sku: "TS-X" },
      { code: "brand_missing" },
      { code: "shipping_missing" },
      { code: "too_many_hashtags" },
      { code: "email_in_description" },
      { code: "price_too_low", sku: "TS-X" },
    ]);
    expect(
      depopIssues({ mode: "SINGLE", title: "Veste", description: "Bon état", brand: "Levi's", details: { department: "menswear", productType: "jackets", sizeId: 4, shippingCents: 0 }, items: [{ sku: "V", priceCents: 4500 }] }),
    ).toEqual([]);
  });
});
