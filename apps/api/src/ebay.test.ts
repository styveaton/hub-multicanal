import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ebayChallengeResponse } from "@hub/channels";
import { JPEG, TEST_PUBLIC_API_URL, TEST_WEB_URL, createTestApp, multipartFile, prisma, resetDatabase, sessionCookie } from "./test/helpers.js";

/** eBay (Inventory, Account, Fulfillment) contre le faux eBay : connexion, annonces, stock, commandes, RGPD. */

const { app, queue, fakeEbay, config, channelDeps } = createTestApp();
type Cookies = Record<string, string>;
let owner: Cookies;

async function signup(email: string, organizationName: string) {
  const res = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password: "motdepasse-test", name: "Test", organizationName } });
  return sessionCookie(res);
}

const uploadPhoto = async (cookies: Cookies) => (await app.inject({ method: "POST", url: "/photos", cookies, ...multipartFile(JPEG) })).json().id as string;

async function createSingle(cookies: Cookies, sku = "VESTE-001", extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/products",
    cookies,
    payload: {
      mode: "SINGLE",
      title: "Veste en jean Levi's",
      description: "Années 90.\n\nTrès bon état.",
      brand: "Levi's",
      condition: "USED_GOOD",
      sku,
      priceCents: 4500,
      photoIds: [await uploadPhoto(cookies)],
      ...extra,
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
      title: "T-shirt coton bio",
      description: "Coton bio.",
      brand: "Nike",
      condition: "NEW",
      photoIds: [await uploadPhoto(cookies)],
      variants: Object.entries(stock).map(([sku, quantity], i) => ({ sku, attributes: { Size: ["M", "L", "XL"][i]! }, priceCents: 2000, quantity })),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const stockOf = async (code: string) => (await prisma.sku.findFirstOrThrow({ where: { code } })).quantity;
const listings = () => prisma.channelListing.findMany({ where: { channel: "EBAY" }, orderBy: { skuCode: "asc" } });
const connection = () => prisma.channelConnection.findFirstOrThrow({ where: { channel: "EBAY" } });

/** OmniList → page d'accord (fausse) → retour avec le code. */
async function connectEbay(cookies: Cookies, postalCode: string | null = "10001") {
  const start = await app.inject({ method: "POST", url: "/channels/ebay/connect", cookies });
  expect(start.statusCode).toBe(200);
  const authorize = new URL(start.json().url);
  const consent = await app.inject({ method: "GET", url: `${authorize.pathname.replace(/^\/api/, "")}${authorize.search}` });
  expect(consent.statusCode).toBe(302);
  const back = new URL(consent.headers.location as string);
  const res = await app.inject({ method: "GET", url: `/channels/ebay/callback${back.search}`, cookies });
  if (postalCode) {
    const put = await app.inject({ method: "PUT", url: "/channels/ebay/settings", cookies, payload: { postalCode } });
    expect(put.statusCode).toBe(200);
  }
  return { res, authorize };
}

async function publishOnEbay(cookies: Cookies, productId: string, body: Record<string, unknown> = {}) {
  const put = await app.inject({ method: "PUT", url: `/products/${productId}/channels/EBAY`, cookies, payload: { enabled: true, price: { mode: "BASE" }, ...body } });
  expect(put.statusCode).toBe(200);
  const res = await app.inject({ method: "POST", url: `/products/${productId}/channels/EBAY/publish`, cookies });
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
  for (const m of [fakeEbay.items, fakeEbay.groups, fakeEbay.offers, fakeEbay.locations]) m.clear();
  fakeEbay.orders.length = 0;
  fakeEbay.noPolicies = false;
  fakeEbay.optedIn = false;
  owner = await signup("proprio@exemple.fr", "Boutique A");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("eBay : connexion", () => {
  it("eBay branché et disponible en mode test", async () => {
    const items = (await app.inject({ method: "GET", url: "/channels", cookies: owner })).json().items as Array<{ channel: string }>;
    expect(items.find((c) => c.channel === "EBAY")).toMatchObject({ supported: true, available: true, testMode: true, connection: null });
  });

  it("accord du vendeur : jetons chiffrés, pseudo eBay ; code postal obligatoire et vérifié", async () => {
    const { res, authorize } = await connectEbay(owner, null);
    expect(authorize.searchParams.get("scope")).toContain("sell.inventory");
    expect(authorize.searchParams.get("redirect_uri")).toBe(config.ebay.ruName);
    expect(res.headers.location).toBe(`${TEST_WEB_URL}/channels?connected=ebay`);
    const c = await connection();
    expect(c).toMatchObject({ status: "CONNECTED", externalAccountId: "fakeUser123", externalUsername: "omnilist_seller" });
    expect(c.accessTokenEnc).not.toContain("fake_");
    expect(c.refreshTokenEnc).toBeTruthy();

    const p = await createSingle(owner);
    await app.inject({ method: "PUT", url: `/products/${p.id}/channels/EBAY`, cookies: owner, payload: { enabled: true, price: { mode: "BASE" } } });
    expect((await app.inject({ method: "POST", url: `/products/${p.id}/channels/EBAY/publish`, cookies: owner })).json().error).toBe("ebay_location_missing");
    expect((await app.inject({ method: "PUT", url: "/channels/ebay/settings", cookies: owner, payload: { postalCode: "ABC" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/channels/ebay/settings", cookies: owner, payload: { postalCode: "94105" } })).json().settings).toMatchObject({
      postalCode: "94105",
      username: "omnilist_seller",
    });
  });

  it("retour falsifié ou refus du vendeur : pas de connexion", async () => {
    const forged = await app.inject({ method: "GET", url: "/channels/ebay/callback?code=x&state=faux", cookies: owner });
    expect(forged.headers.location).toBe(`${TEST_WEB_URL}/channels?error=invalid_state&channel=ebay`);
    const declined = await app.inject({ method: "GET", url: "/channels/ebay/callback?error=access_denied", cookies: owner });
    expect(declined.headers.location).toBe(`${TEST_WEB_URL}/channels?error=access_denied&channel=ebay`);
    expect(await prisma.channelConnection.count()).toBe(0);
  });
});

describe("eBay : annonces", () => {
  it("article unique : emplacement, règles de vente, catégorie suggérée, offre publiée", async () => {
    await connectEbay(owner);
    const p = await createSingle(owner);
    await publishOnEbay(owner, p.id);

    const [l] = await listings();
    expect(l).toMatchObject({ status: "LISTED", errorCode: null, externalParentId: null });
    expect(l!.externalUrl).toBe(`${config.ebay.siteUrl}/itm/${l!.externalId}`);
    expect(fakeEbay.locations.get("omnilist")).toEqual({ postalCode: "10001" });
    const item = fakeEbay.items.get("VESTE-001")!;
    expect(item).toMatchObject({ condition: "USED_GOOD", availability: { shipToLocationAvailability: { quantity: 1 } } });
    expect(item.product).toMatchObject({ title: "Veste en jean Levi's", aspects: { Brand: ["Levi's"] }, description: "<p>Années 90.</p><p>Très bon état.</p>" });
    expect(fakeEbay.offerBySku("VESTE-001")).toMatchObject({
      status: "PUBLISHED",
      categoryId: "57988",
      merchantLocationKey: "omnilist",
      pricingSummary: { price: { value: "45.00", currency: "USD" } },
      listingPolicies: { fulfillmentPolicyId: "fulfillment-6200", paymentPolicyId: "payment-6200", returnPolicyId: "return-6200" },
    });
    // Règles de vente gardées sur la connexion.
    expect((await connection()).settings).toMatchObject({ locationPostalCode: "10001", policies: { fulfillmentPolicyId: "fulfillment-6200" } });
  });

  it("variantes : une annonce à variantes, une offre par SKU ; une mise à jour ne republie pas", async () => {
    await connectEbay(owner);
    const p = await createTshirts(owner, { "TS-M": 2, "TS-L": 0, "TS-XL": 1 });
    await publishOnEbay(owner, p.id, { category: "15687" });

    const all = await listings();
    expect(all.map((l) => l.status)).toEqual(["LISTED", "LISTED", "LISTED"]);
    expect(new Set(all.map((l) => l.externalId)).size).toBe(1);
    expect(all[0]!.externalParentId).toBe(p.id);
    expect(fakeEbay.groups.get(p.id)).toMatchObject({
      variantSKUs: ["TS-M", "TS-L", "TS-XL"],
      variesBy: { specifications: [{ name: "Size", values: ["M", "L", "XL"] }] },
    });
    expect(fakeEbay.items.get("TS-L")!.product.aspects).toEqual({ Brand: ["Nike"], Size: ["L"] });
    expect(fakeEbay.offerBySku("TS-M")!.categoryId).toBe("15687");

    // Réassort : quantité eBay remise au stock central, même annonce.
    const listingId = all[0]!.externalId;
    await app.inject({ method: "POST", url: "/stock/TS-L/adjust", cookies: owner, payload: { set: 4 } });
    await queue.drain(channelDeps);
    expect(fakeEbay.offerBySku("TS-L")).toMatchObject({ availableQuantity: 4, listingId });
  });

  it("sans règles de vente chez eBay : erreur claire sur l'annonce", async () => {
    await connectEbay(owner);
    fakeEbay.noPolicies = true;
    const p = await createSingle(owner);
    await publishOnEbay(owner, p.id);
    expect((await listings())[0]).toMatchObject({ status: "ERROR", errorCode: "ebay_policies_missing" });
    expect(fakeEbay.offers.size).toBe(0);
  });

  it("rupture : l'annonce prend fin ; réassort : republiée ; désactiver retire ; supprimer efface", async () => {
    await connectEbay(owner);
    const p = await createSingle(owner);
    await publishOnEbay(owner, p.id);

    await app.inject({ method: "POST", url: "/orders", cookies: owner, payload: { lines: [{ sku: "VESTE-001", quantity: 1, unitPriceCents: 4500 }] } });
    await queue.drain(channelDeps);
    expect(fakeEbay.offerBySku("VESTE-001")!.status).toBe("UNPUBLISHED");
    expect((await listings())[0]).toMatchObject({ status: "REMOVED", errorCode: "out_of_stock" });

    await app.inject({ method: "POST", url: "/stock/VESTE-001/adjust", cookies: owner, payload: { set: 1 } });
    await queue.drain(channelDeps);
    expect(fakeEbay.offerBySku("VESTE-001")).toMatchObject({ status: "PUBLISHED", availableQuantity: 1 });
    expect((await listings())[0]).toMatchObject({ status: "LISTED" });

    await app.inject({ method: "PUT", url: `/products/${p.id}/channels/EBAY`, cookies: owner, payload: { enabled: false, price: { mode: "BASE" } } });
    await queue.drain(channelDeps);
    expect(fakeEbay.offerBySku("VESTE-001")!.status).toBe("UNPUBLISHED");
    expect((await listings())[0]).toMatchObject({ status: "REMOVED", errorCode: null });

    await app.inject({ method: "DELETE", url: `/products/${p.id}`, cookies: owner });
    await queue.drain(channelDeps);
    expect(fakeEbay.items.size).toBe(0);
    expect(fakeEbay.offers.size).toBe(0);
  });

  it("jeton expiré : rafraîchi sans reconnexion ; accès retiré : à reconnecter", async () => {
    await connectEbay(owner);
    const c = await connection();
    await prisma.channelConnection.update({ where: { id: c.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    fakeEbay.expireAccessTokens();
    const p = await createSingle(owner);
    await publishOnEbay(owner, p.id);
    expect((await listings())[0]).toMatchObject({ status: "LISTED" });
    expect((await connection()).accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    fakeEbay.revokeAll();
    await prisma.channelConnection.update({ where: { id: c.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    await app.inject({ method: "POST", url: "/stock/VESTE-001/adjust", cookies: owner, payload: { set: 3 } });
    await queue.drain(channelDeps);
    expect((await connection()).status).toBe("NEEDS_REAUTH");
    expect((await listings())[0]).toMatchObject({ status: "ERROR", errorCode: "needs_reauth" });
  });
});

describe("eBay : commandes", () => {
  it("relevé : vente importée une fois, stock décompté ; annulation → stock remis et annonce republiée", async () => {
    await connectEbay(owner);
    const p = await createTshirts(owner, { "TS-M": 1, "TS-L": 2 });
    await publishOnEbay(owner, p.id);

    const order = fakeEbay.simulateSale("TS-L", { quantity: 2 });
    await poll();
    await poll();
    expect(await stockOf("TS-L")).toBe(0);
    const orders = (await app.inject({ method: "GET", url: "/orders?channel=EBAY", cookies: owner })).json();
    expect(orders.items).toHaveLength(1);
    expect(orders.items[0]).toMatchObject({
      channel: "EBAY",
      externalOrderId: order.orderId,
      status: "PAID",
      buyerName: "Jordan Buyer",
      totalCents: 4000,
      lines: [expect.objectContaining({ sku: "TS-L", quantity: 2, unitPriceCents: 2000 })],
    });
    expect((await prisma.order.findFirstOrThrow()).buyerRef).toBe("jordan_buys");

    fakeEbay.updateOrder(order.orderId, { cancelStatus: { cancelState: "CANCELED" } });
    await poll();
    expect(await stockOf("TS-L")).toBe(2);
    expect((await prisma.order.findFirstOrThrow()).status).toBe("CANCELLED");
    expect(fakeEbay.offerBySku("TS-L")!.availableQuantity).toBe(2);
  });

  it("paiement en attente : pas encore une vente ; remboursement : stock remis", async () => {
    await connectEbay(owner);
    const p = await createSingle(owner);
    await publishOnEbay(owner, p.id);
    const order = fakeEbay.simulateSale("VESTE-001", { paymentStatus: "PENDING" });
    await poll();
    expect(await prisma.order.count()).toBe(0);
    expect(await stockOf("VESTE-001")).toBe(1);

    fakeEbay.updateOrder(order.orderId, { orderPaymentStatus: "PAID" });
    await poll();
    expect(await stockOf("VESTE-001")).toBe(0);
    fakeEbay.updateOrder(order.orderId, { orderPaymentStatus: "FULLY_REFUNDED" });
    await poll();
    expect(await stockOf("VESTE-001")).toBe(1);
    expect((await prisma.order.findFirstOrThrow()).status).toBe("REFUNDED");
  });
});

describe("eBay : avis de suppression de compte", () => {
  const endpoint = `${TEST_PUBLIC_API_URL}/webhooks/ebay/account-deletion`;

  it("répond au défi de validation de l'adresse", async () => {
    expect(config.ebay.deletionEndpoint).toBe(endpoint);
    const res = await app.inject({ method: "GET", url: "/webhooks/ebay/account-deletion?challenge_code=abc123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challengeResponse: ebayChallengeResponse("abc123", config.ebay.verificationToken, endpoint) });
  });

  it("avis signé : données de l'acheteur effacées, connexion du vendeur supprimée ; signature fausse : 412", async () => {
    await connectEbay(owner);
    const p = await createSingle(owner);
    await publishOnEbay(owner, p.id);
    fakeEbay.simulateSale("VESTE-001");
    await poll();

    const notice = (data: object) =>
      JSON.stringify({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0", deprecated: false },
        notification: { notificationId: "n-1", eventDate: new Date().toISOString(), publishDate: new Date().toISOString(), publishAttemptCount: 1, data },
      });
    const send = (body: string, signature: string) =>
      app.inject({
        method: "POST",
        url: "/webhooks/ebay/account-deletion",
        headers: { "content-type": "application/json", "x-ebay-signature": signature },
        payload: body,
      });

    const buyer = notice({ username: "jordan_buys", userId: "buyer-1", eiasToken: "x" });
    expect((await send(buyer, fakeEbay.signNotification(notice({ username: "autre" })))).statusCode).toBe(412);
    expect((await send(buyer, "pas-une-signature")).statusCode).toBe(412);
    expect((await prisma.order.findFirstOrThrow()).buyerName).toBe("Jordan Buyer");

    expect((await send(buyer, fakeEbay.signNotification(buyer))).statusCode).toBe(204);
    expect(await prisma.order.findFirstOrThrow()).toMatchObject({ buyerName: null, buyerRef: null, totalCents: 4500 });

    const seller = notice({ username: "omnilist_seller", userId: "fakeUser123", eiasToken: "y" });
    expect((await send(seller, fakeEbay.signNotification(seller))).statusCode).toBe(204);
    expect(await prisma.channelConnection.count({ where: { channel: "EBAY" } })).toBe(0);
  });
});
