import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FAKE_ETSY_SHOP_ID } from "@hub/channels";
import { JPEG, TEST_WEB_URL, createTestApp, multipartFile, prisma, resetDatabase, sessionCookie } from "./test/helpers.js";

/** Etsy (Open API v3) contre le faux Etsy : connexion PKCE, annonce, photos, inventaire, stock, commandes. */

const { app, queue, fakeEtsy, config, channelDeps } = createTestApp();
type Cookies = Record<string, string>;
let owner: Cookies;

async function signup(email: string, organizationName: string) {
  const res = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password: "motdepasse-test", name: "Test", organizationName } });
  return sessionCookie(res);
}

const uploadPhoto = async (cookies: Cookies) => (await app.inject({ method: "POST", url: "/photos", cookies, ...multipartFile(JPEG) })).json().id as string;

async function createSingle(cookies: Cookies, sku = "VESTE-001") {
  const res = await app.inject({
    method: "POST",
    url: "/products",
    cookies,
    payload: {
      mode: "SINGLE",
      title: "Vintage denim jacket",
      description: "Années 90.\n\nTrès bon état.",
      brand: "Levi's",
      condition: "USED_GOOD",
      sku,
      priceCents: 4500,
      photoIds: [await uploadPhoto(cookies), await uploadPhoto(cookies)],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function createTshirts(cookies: Cookies, stock: Record<string, number>) {
  const res = await app.inject({
    method: "POST",
    url: "/products",
    cookies,
    payload: {
      mode: "VARIANTS",
      title: "Organic cotton T-shirt",
      description: "Coton bio.",
      brand: "Nike",
      condition: "NEW",
      photoIds: [await uploadPhoto(cookies)],
      variants: Object.entries(stock).map(([sku, quantity], i) => ({ sku, attributes: { Size: ["M", "L", "XL"][i]! }, priceCents: 2000 + i * 100, quantity })),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const DETAILS = { whoMade: "someone_else", whenMade: "1990s" };
const stockOf = async (code: string) => (await prisma.sku.findFirstOrThrow({ where: { code } })).quantity;
const listings = () => prisma.channelListing.findMany({ where: { channel: "ETSY" }, orderBy: { skuCode: "asc" } });
const connection = () => prisma.channelConnection.findFirstOrThrow({ where: { channel: "ETSY" } });

/** OmniList → page d'accord (fausse) → retour avec le code (PKCE). */
async function connectEtsy(cookies: Cookies) {
  const start = await app.inject({ method: "POST", url: "/channels/etsy/connect", cookies });
  expect(start.statusCode).toBe(200);
  const authorize = new URL(start.json().url);
  const consent = await app.inject({ method: "GET", url: `${authorize.pathname.replace(/^\/api/, "")}${authorize.search}` });
  expect(consent.statusCode).toBe(302);
  const back = new URL(consent.headers.location as string);
  const res = await app.inject({ method: "GET", url: `/channels/etsy/callback${back.search}`, cookies });
  return { res, authorize };
}

async function publishOnEtsy(cookies: Cookies, productId: string, body: Record<string, unknown> = {}) {
  const put = await app.inject({
    method: "PUT",
    url: `/products/${productId}/channels/ETSY`,
    cookies,
    payload: { enabled: true, price: { mode: "BASE" }, details: DETAILS, ...body },
  });
  expect(put.statusCode).toBe(200);
  const res = await app.inject({ method: "POST", url: `/products/${productId}/channels/ETSY/publish`, cookies });
  expect(res.statusCode).toBe(200);
  await queue.drain(channelDeps);
}

const poll = async () => {
  await queue.add({ name: "orders:poll", data: {} });
  await queue.drain(channelDeps);
};

beforeEach(async () => {
  await resetDatabase();
  queue.jobs.length = 0;
  fakeEtsy.listings.clear();
  fakeEtsy.receipts.length = 0;
  fakeEtsy.processingProfiles.length = 0;
  fakeEtsy.noShippingProfile = false;
  fakeEtsy.noShop = false;
  owner = await signup("proprio@exemple.fr", "Boutique A");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("Etsy : connexion", () => {
  it("Etsy branché et disponible en mode test", async () => {
    const items = (await app.inject({ method: "GET", url: "/channels", cookies: owner })).json().items as Array<{ channel: string }>;
    expect(items.find((c) => c.channel === "ETSY")).toMatchObject({ supported: true, available: true, testMode: true, connection: null });
  });

  it("accord du vendeur (PKCE) : jetons chiffrés, boutique Etsy reliée", async () => {
    const { res, authorize } = await connectEtsy(owner);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toContain("listings_w");
    expect(authorize.searchParams.get("redirect_uri")).toBe(config.etsy.redirectUri);
    expect(res.headers.location).toBe(`${TEST_WEB_URL}/channels?connected=etsy`);
    const c = await connection();
    expect(c).toMatchObject({ status: "CONNECTED", externalAccountId: String(FAKE_ETSY_SHOP_ID), externalUsername: "OmniListVintage" });
    expect(c.settings).toMatchObject({ shopId: FAKE_ETSY_SHOP_ID, shopName: "OmniListVintage", currency: "USD" });
    expect(c.accessTokenEnc).not.toContain("fake_");
  });

  it("compte Etsy sans boutique (404 d'Etsy) : message clair, pas de connexion", async () => {
    fakeEtsy.noShop = true;
    const { res } = await connectEtsy(owner);
    expect(res.headers.location).toBe(`${TEST_WEB_URL}/channels?error=etsy_no_shop&channel=etsy`);
    expect(await prisma.channelConnection.count()).toBe(0);
  });

  it("retour falsifié : pas de connexion", async () => {
    const forged = await app.inject({ method: "GET", url: "/channels/etsy/callback?code=x&state=faux", cookies: owner });
    expect(forged.headers.location).toBe(`${TEST_WEB_URL}/channels?error=invalid_state&channel=etsy`);
    expect(await prisma.channelConnection.count()).toBe(0);
  });
});

describe("Etsy : annonces", () => {
  it("champs Etsy obligatoires : publication refusée tant qu'ils manquent, valeurs vérifiées", async () => {
    await connectEtsy(owner);
    const p = await createSingle(owner);
    await app.inject({ method: "PUT", url: `/products/${p.id}/channels/ETSY`, cookies: owner, payload: { enabled: true, price: { mode: "BASE" } } });
    const refused = await app.inject({ method: "POST", url: `/products/${p.id}/channels/ETSY/publish`, cookies: owner });
    expect(refused.json()).toMatchObject({ error: "listing_incomplete" });
    expect(refused.json().warnings.map((w: { code: string }) => w.code)).toEqual(["etsy_who_made_missing", "etsy_when_made_missing"]);
    const bad = await app.inject({
      method: "PUT",
      url: `/products/${p.id}/channels/ETSY`,
      cookies: owner,
      payload: { enabled: true, price: { mode: "BASE" }, details: { whoMade: "robot" } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("article unique : brouillon, photos envoyées, inventaire, annonce activée ; profils gardés", async () => {
    await connectEtsy(owner);
    const p = await createSingle(owner);
    await publishOnEtsy(owner, p.id);

    const [l] = await listings();
    expect(l).toMatchObject({ status: "LISTED", errorCode: null, externalUrl: `https://www.etsy.com/listing/${l!.externalId}` });
    const listing = fakeEtsy.listings.get(Number(l!.externalId))!;
    expect(listing.state).toBe("active");
    expect(listing.fields).toMatchObject({
      title: "Vintage denim jacket",
      who_made: "someone_else",
      when_made: "1990s",
      taxonomy_id: "448",
      shipping_profile_id: "900001",
      is_supply: "false",
      type: "physical",
    });
    expect(listing.images).toHaveLength(2);
    expect(listing.inventory!.products).toEqual([
      { sku: "VESTE-001", property_values: [], offerings: [{ price: 45, quantity: 1, is_enabled: true, readiness_state_id: expect.any(Number) }] },
    ]);
    // Profil de préparation créé une fois (la boutique n'en avait pas), puis gardé avec le profil d'expédition.
    expect(fakeEtsy.processingProfiles).toHaveLength(1);
    expect((await connection()).settings).toMatchObject({ shippingProfileId: 900001, readinessStateId: fakeEtsy.processingProfiles[0]!.readiness_state_id });

    // Mise à jour sans changement de photos : elles ne sont pas renvoyées.
    await publishOnEtsy(owner, p.id, { title: "Vintage Levi's denim jacket" });
    expect(listing.fields.title).toBe("Vintage Levi's denim jacket");
    expect(listing.images).toHaveLength(2);
    expect(fakeEtsy.listings.size).toBe(1);
  });

  it("variantes : une annonce, une variation « Size », prix et stock par SKU", async () => {
    await connectEtsy(owner);
    const p = await createTshirts(owner, { "TS-M": 2, "TS-L": 0, "TS-XL": 1 });
    await publishOnEtsy(owner, p.id, { category: "559" });

    const all = await listings();
    expect(all.map((l) => l.status)).toEqual(["LISTED", "LISTED", "LISTED"]);
    expect(new Set(all.map((l) => l.externalId)).size).toBe(1);
    const inv = fakeEtsy.listings.get(Number(all[0]!.externalId))!.inventory!;
    expect(inv.quantity_on_property).toEqual([513]);
    expect(inv.products.map((x) => [x.sku, x.property_values[0]!.values[0], x.offerings[0]!.price, x.offerings[0]!.quantity, x.offerings[0]!.is_enabled])).toEqual([
      ["TS-M", "M", 20, 2, true],
      ["TS-L", "L", 21, 0, false],
      ["TS-XL", "XL", 22, 1, true],
    ]);

    await app.inject({ method: "POST", url: "/stock/TS-L/adjust", cookies: owner, payload: { set: 3 } });
    await queue.drain(channelDeps);
    expect(fakeEtsy.bySku("TS-L")!.product.offerings[0]).toMatchObject({ quantity: 3, is_enabled: true });
  });

  it("sans profil d'expédition : erreur claire ; sans catégorie trouvée : fiche incomplète", async () => {
    await connectEtsy(owner);
    fakeEtsy.noShippingProfile = true;
    const p = await createSingle(owner);
    await publishOnEtsy(owner, p.id);
    expect((await listings())[0]).toMatchObject({ status: "ERROR", errorCode: "etsy_shipping_profile_missing" });

    fakeEtsy.noShippingProfile = false;
    await publishOnEtsy(owner, p.id, { category: "machin introuvable" });
    expect((await listings())[0]).toMatchObject({ status: "ERROR", errorCode: "listing_incomplete", errorMessage: "category_missing" });
    expect(fakeEtsy.listings.size).toBe(0);
  });

  it("rupture : annonce désactivée ; réassort : réactivée ; désactiver cache ; supprimer efface", async () => {
    await connectEtsy(owner);
    const p = await createSingle(owner);
    await publishOnEtsy(owner, p.id);
    const id = Number((await listings())[0]!.externalId);

    await app.inject({ method: "POST", url: "/orders", cookies: owner, payload: { lines: [{ sku: "VESTE-001", quantity: 1, unitPriceCents: 4500 }] } });
    await queue.drain(channelDeps);
    expect(fakeEtsy.listings.get(id)!.state).toBe("inactive");
    expect((await listings())[0]).toMatchObject({ status: "REMOVED", errorCode: "out_of_stock" });

    await app.inject({ method: "POST", url: "/stock/VESTE-001/adjust", cookies: owner, payload: { set: 1 } });
    await queue.drain(channelDeps);
    expect(fakeEtsy.listings.get(id)!.state).toBe("active");
    expect((await listings())[0]).toMatchObject({ status: "LISTED", externalId: String(id) });

    await app.inject({ method: "PUT", url: `/products/${p.id}/channels/ETSY`, cookies: owner, payload: { enabled: false, price: { mode: "BASE" }, details: DETAILS } });
    await queue.drain(channelDeps);
    expect(fakeEtsy.listings.get(id)!.state).toBe("inactive");

    await app.inject({ method: "DELETE", url: `/products/${p.id}`, cookies: owner });
    await queue.drain(channelDeps);
    expect(fakeEtsy.listings.size).toBe(0);
  });

  it("jeton expiré : rafraîchi (nouveau jeton de rafraîchissement) ; accès retiré : à reconnecter", async () => {
    await connectEtsy(owner);
    const before = await connection();
    await prisma.channelConnection.update({ where: { id: before.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    fakeEtsy.expireAccessTokens();
    const p = await createSingle(owner);
    await publishOnEtsy(owner, p.id);
    expect((await listings())[0]).toMatchObject({ status: "LISTED" });
    const after = await connection();
    expect(after.refreshTokenEnc).not.toBe(before.refreshTokenEnc);

    fakeEtsy.revokeAll();
    await prisma.channelConnection.update({ where: { id: before.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    await app.inject({ method: "POST", url: "/stock/VESTE-001/adjust", cookies: owner, payload: { set: 3 } });
    await queue.drain(channelDeps);
    expect((await connection()).status).toBe("NEEDS_REAUTH");
  });
});

describe("Etsy : commandes", () => {
  it("relevé : vente importée une fois, stock décompté ; annulation → stock remis", async () => {
    await connectEtsy(owner);
    const p = await createTshirts(owner, { "TS-M": 1, "TS-L": 2 });
    await publishOnEtsy(owner, p.id);

    const receipt = fakeEtsy.simulateSale("TS-L", { quantity: 2 });
    await poll();
    await poll();
    expect(await stockOf("TS-L")).toBe(0);
    const orders = (await app.inject({ method: "GET", url: "/orders?channel=ETSY", cookies: owner })).json();
    expect(orders.items).toHaveLength(1);
    expect(orders.items[0]).toMatchObject({
      channel: "ETSY",
      externalOrderId: String(receipt.receipt_id),
      status: "PAID",
      buyerName: "Casey Buyer",
      totalCents: 4200,
      lines: [expect.objectContaining({ sku: "TS-L", quantity: 2, unitPriceCents: 2100 })],
    });

    fakeEtsy.updateReceipt(receipt.receipt_id, { status: "canceled" });
    await poll();
    expect(await stockOf("TS-L")).toBe(2);
    expect((await prisma.order.findFirstOrThrow()).status).toBe("CANCELLED");
    expect(fakeEtsy.bySku("TS-L")!.product.offerings[0]).toMatchObject({ quantity: 2, is_enabled: true });
  });

  it("paiement en cours : pas encore une vente ; payée puis remboursée : stock remis", async () => {
    await connectEtsy(owner);
    const p = await createSingle(owner);
    await publishOnEtsy(owner, p.id);
    const receipt = fakeEtsy.simulateSale("VESTE-001", { paid: false });
    await poll();
    expect(await prisma.order.count()).toBe(0);

    fakeEtsy.updateReceipt(receipt.receipt_id, { status: "paid", is_paid: true });
    await poll();
    expect(await stockOf("VESTE-001")).toBe(0);
    fakeEtsy.updateReceipt(receipt.receipt_id, { status: "fully refunded" });
    await poll();
    expect(await stockOf("VESTE-001")).toBe(1);
    expect((await prisma.order.findFirstOrThrow()).status).toBe("REFUNDED");
  });
});
