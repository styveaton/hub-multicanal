import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FAKE_SHOPIFY_CLIENT_SECRET, signShopifyQuery, signShopifyWebhook, signWooWebhook, type FakeShopifyOrder, type WooOrder } from "@hub/channels";
import { JPEG, TEST_WEB_URL, createTestApp, multipartFile, prisma, resetDatabase, sessionCookie } from "./test/helpers.js";

/** Sites marchands : Shopify (OAuth + GraphQL) et WooCommerce (clés REST), contre leurs faux serveurs. */

const { app, queue, fakeShopify, fakeWoo, channelDeps } = createTestApp();
type Cookies = Record<string, string>;
let owner: Cookies;
const SHOP = "omni-demo.myshopify.com";

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
      title: "Veste en jean",
      description: "Années 90.\n\nTrès bon état.",
      brand: "Levi's",
      condition: "USED_GOOD",
      sku,
      priceCents: 4500,
      photoIds: [await uploadPhoto(cookies)],
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
      variants: Object.entries(stock).map(([sku, quantity], i) => ({ sku, attributes: { Taille: ["M", "L", "XL"][i]! }, priceCents: 2000, quantity })),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const stockOf = async (code: string) => (await prisma.sku.findFirstOrThrow({ where: { code } })).quantity;
const listings = (channel: "SHOPIFY" | "WOOCOMMERCE") => prisma.channelListing.findMany({ where: { channel }, orderBy: { skuCode: "asc" } });

async function publishOn(cookies: Cookies, channel: "SHOPIFY" | "WOOCOMMERCE", productId: string, body: Record<string, unknown> = {}) {
  const put = await app.inject({ method: "PUT", url: `/products/${productId}/channels/${channel}`, cookies, payload: { enabled: true, price: { mode: "BASE" }, ...body } });
  expect(put.statusCode).toBe(200);
  const res = await app.inject({ method: "POST", url: `/products/${productId}/channels/${channel}/publish`, cookies });
  expect(res.statusCode).toBe(200);
  await queue.drain(channelDeps);
}

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

/** Installation complète : OmniList → page d'installation (fausse) → retour signé. */
async function connectShopify(cookies: Cookies, shop = "omni-demo") {
  const start = await app.inject({ method: "POST", url: "/channels/shopify/connect", cookies, payload: { shop } });
  expect(start.statusCode).toBe(200);
  const authorize = new URL(start.json().url);
  const consent = await app.inject({ method: "GET", url: `${authorize.pathname.replace(/^\/api/, "")}${authorize.search}` });
  expect(consent.statusCode).toBe(302);
  const back = new URL(consent.headers.location as string);
  const res = await app.inject({ method: "GET", url: `/channels/shopify/callback${back.search}`, cookies });
  return { res, back };
}

function shopifyWebhook(connectionId: string, topic: string, payload: unknown, opts: { secret?: string; shop?: string } = {}) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: `/webhooks/shopify/${connectionId}`,
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": opts.shop ?? SHOP,
      "x-shopify-hmac-sha256": signShopifyWebhook(opts.secret ?? FAKE_SHOPIFY_CLIENT_SECRET, body),
    },
    payload: body,
  });
}

// ---------------------------------------------------------------------------
// WooCommerce
// ---------------------------------------------------------------------------

const connectWoo = (cookies: Cookies, body: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/channels/woocommerce/connect",
    cookies,
    payload: { storeUrl: "boutique.example.com", consumerKey: "ck_test123", consumerSecret: "cs_test456", ...body },
  });

function wooWebhook(connectionId: string, order: WooOrder, opts: { secret?: string; topic?: string } = {}) {
  const body = JSON.stringify(order);
  const secret = opts.secret ?? fakeWoo.webhooks[0]!.secret;
  return app.inject({
    method: "POST",
    url: `/webhooks/woocommerce/${connectionId}`,
    headers: {
      "content-type": "application/json",
      "x-wc-webhook-topic": opts.topic ?? "order.created",
      "x-wc-webhook-signature": signWooWebhook(secret, body),
    },
    payload: body,
  });
}

beforeEach(async () => {
  await resetDatabase();
  queue.jobs.length = 0;
  fakeShopify.products.clear();
  fakeShopify.orders.length = 0;
  fakeShopify.webhooks.length = 0;
  fakeWoo.products.clear();
  fakeWoo.orders.length = 0;
  fakeWoo.webhooks.length = 0;
  owner = await signup("proprio@exemple.fr", "Boutique A");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("liste des canaux", () => {
  it("13 canaux ; Shopify et WooCommerce branchés, disponibles en mode test", async () => {
    const items = (await app.inject({ method: "GET", url: "/channels", cookies: owner })).json().items as Array<{ channel: string }>;
    expect(items).toHaveLength(13);
    for (const channel of ["SHOPIFY", "WOOCOMMERCE"]) {
      expect(items.find((c) => c.channel === channel)).toMatchObject({ supported: true, available: true, testMode: true, connection: null });
    }
  });
});

describe("Shopify : installation", () => {
  it("installe l'application : jeton chiffré, emplacement de stock, webhooks des commandes", async () => {
    const { res } = await connectShopify(owner, "https://Omni-Demo.myshopify.com/admin");
    expect(res.headers.location).toBe(`${TEST_WEB_URL}/channels?connected=shopify`);
    const c = await prisma.channelConnection.findFirstOrThrow({ where: { channel: "SHOPIFY" } });
    expect(c).toMatchObject({ status: "CONNECTED", externalAccountId: SHOP, externalUsername: "OmniList Demo" });
    expect(c.settings).toMatchObject({ locationId: fakeShopify.locationId, currency: "USD" });
    expect(channelDeps.cipher.decrypt(c.accessTokenEnc)).toMatch(/^shpat_/);
    expect(fakeShopify.webhooks.map((w) => w.topic)).toEqual(["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "APP_UNINSTALLED"]);
    expect(fakeShopify.webhooks[0]!.uri).toBe(`https://api.test/webhooks/shopify/${c.id}`);
    const item = (await app.inject({ method: "GET", url: "/channels", cookies: owner })).json().items.find((i: { channel: string }) => i.channel === "SHOPIFY");
    expect(item.connection).toMatchObject({ status: "CONNECTED", account: SHOP, username: "OmniList Demo" });
  });

  it("refuse une boutique invalide, un retour falsifié ou pour une autre boutique", async () => {
    const bad = await app.inject({ method: "POST", url: "/channels/shopify/connect", cookies: owner, payload: { shop: "pas une boutique!" } });
    expect(bad.json().error).toBe("shop_invalid");

    // Signature modifiée.
    const start = await app.inject({ method: "POST", url: "/channels/shopify/connect", cookies: owner, payload: { shop: "omni-demo" } });
    const authorize = new URL(start.json().url);
    const consent = await app.inject({ method: "GET", url: `${authorize.pathname.replace(/^\/api/, "")}${authorize.search}` });
    const back = new URL(consent.headers.location as string);
    back.searchParams.set("hmac", "0".repeat(64));
    const forged = await app.inject({ method: "GET", url: `/channels/shopify/callback${back.search}`, cookies: owner });
    expect(forged.headers.location).toBe(`${TEST_WEB_URL}/channels?error=invalid_state&channel=shopify`);

    // Retour correctement signé, mais pour une autre boutique que celle demandée.
    const start2 = await app.inject({ method: "POST", url: "/channels/shopify/connect", cookies: owner, payload: { shop: "omni-demo" } });
    const state = new URL(start2.json().url).searchParams.get("state")!;
    const q = new URLSearchParams({ code: "x", shop: "autre.myshopify.com", state, timestamp: "1" });
    q.set("hmac", signShopifyQuery(FAKE_SHOPIFY_CLIENT_SECRET, q));
    const other = await app.inject({ method: "GET", url: `/channels/shopify/callback?${q}`, cookies: owner });
    expect(other.headers.location).toContain("error=invalid_state");
    expect(await prisma.channelConnection.count()).toBe(0);
  });

  it("désinstallation : à reconnecter ; effacement RGPD de la boutique : connexion supprimée", async () => {
    await connectShopify(owner);
    const c = await prisma.channelConnection.findFirstOrThrow({ where: { channel: "SHOPIFY" } });
    expect((await shopifyWebhook(c.id, "app/uninstalled", { id: 1 }, { secret: "faux" })).statusCode).toBe(401);
    expect((await shopifyWebhook(c.id, "app/uninstalled", { id: 1 })).statusCode).toBe(200);
    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("NEEDS_REAUTH");

    const body = JSON.stringify({ shop_id: 1, shop_domain: SHOP });
    const redact = await app.inject({
      method: "POST",
      url: "/webhooks/shopify/compliance",
      headers: { "content-type": "application/json", "x-shopify-topic": "shop/redact", "x-shopify-hmac-sha256": signShopifyWebhook(FAKE_SHOPIFY_CLIENT_SECRET, body) },
      payload: body,
    });
    expect(redact.statusCode).toBe(200);
    expect(await prisma.channelConnection.count()).toBe(0);
  });
});

describe("Shopify : publication et stock", () => {
  it("fiche à variantes : un produit, une variante par SKU, stock central ; catégorie facultative", async () => {
    await connectShopify(owner);
    const p = await createTshirts(owner, { "TS-M": 2, "TS-L": 5 });
    const settings = (await app.inject({ method: "GET", url: `/products/${p.id}`, cookies: owner })).json().channels.find((c: { channel: string }) => c.channel === "SHOPIFY");
    expect(settings.publishable).toBe(true);
    await publishOn(owner, "SHOPIFY", p.id, { category: "T-shirts" });

    const [product] = [...fakeShopify.products.values()];
    expect(product).toMatchObject({ title: "T-shirt coton bio", status: "ACTIVE", productType: "T-shirts", descriptionHtml: "<p>Coton bio.</p>" });
    expect(product!.variants.map((v) => [v.sku, v.price, v.quantity, v.options[0]])).toEqual([
      ["TS-M", "20.00", 2, { optionName: "Taille", name: "M" }],
      ["TS-L", "20.00", 5, { optionName: "Taille", name: "L" }],
    ]);
    expect(product!.files).toHaveLength(1);
    const ls = await listings("SHOPIFY");
    expect(ls.map((l) => [l.skuCode, l.status, l.externalParentId])).toEqual([
      ["TS-L", "LISTED", product!.id],
      ["TS-M", "LISTED", product!.id],
    ]);
    expect(ls[0]!.externalUrl).toBe(`https://${SHOP}/products/t-shirt-coton-bio`);

    // Modification de la fiche : même produit, photos pas renvoyées.
    product!.files = [];
    await app.inject({ method: "PUT", url: `/products/${p.id}/channels/SHOPIFY`, cookies: owner, payload: { enabled: true, title: "T-shirt bio", price: { mode: "PERCENT", percentBps: 1000 } } });
    await queue.drain(channelDeps);
    expect(fakeShopify.products.size).toBe(1);
    expect(fakeShopify.products.get(product!.id)).toMatchObject({ title: "T-shirt bio", files: [] });
    expect(fakeShopify.variantBySku("TS-M")!.variant.price).toBe("22.00");
  });

  it("vente en direct : quantité Shopify remise au stock central ; désactiver archive, supprimer efface", async () => {
    await connectShopify(owner);
    const p = await createSingle(owner);
    await publishOn(owner, "SHOPIFY", p.id);
    expect(fakeShopify.variantBySku("VESTE-001")!.variant.quantity).toBe(1);

    await app.inject({ method: "POST", url: "/orders", cookies: owner, payload: { lines: [{ sku: "VESTE-001", quantity: 1, unitPriceCents: 4500 }] } });
    await queue.drain(channelDeps);
    expect(fakeShopify.variantBySku("VESTE-001")!.variant.quantity).toBe(0);

    await app.inject({ method: "PUT", url: `/products/${p.id}/channels/SHOPIFY`, cookies: owner, payload: { enabled: false, price: { mode: "BASE" } } });
    await queue.drain(channelDeps);
    const productId = fakeShopify.variantBySku("VESTE-001")!.product.id;
    expect(fakeShopify.products.get(productId)!.status).toBe("ARCHIVED");
    expect((await listings("SHOPIFY"))[0]).toMatchObject({ status: "REMOVED" });

    // Réactivation : le même produit revient en ligne.
    await publishOn(owner, "SHOPIFY", p.id);
    expect(fakeShopify.products.size).toBe(1);
    expect(fakeShopify.products.get(productId)!.status).toBe("ACTIVE");

    await app.inject({ method: "DELETE", url: `/products/${p.id}`, cookies: owner });
    await queue.drain(channelDeps);
    expect(fakeShopify.products.size).toBe(0);
  });

  it("refus de Shopify : erreur sur l'annonce et au journal ; sans connexion : refusé", async () => {
    const p = await createSingle(owner);
    expect((await app.inject({ method: "POST", url: `/products/${p.id}/channels/SHOPIFY/publish`, cookies: owner })).json().error).toBe("channel_not_connected");
    await connectShopify(owner);
    fakeShopify.failNextSet = "Title is too long";
    await publishOn(owner, "SHOPIFY", p.id);
    expect((await listings("SHOPIFY"))[0]).toMatchObject({ status: "ERROR", errorCode: "invalid", errorMessage: "input: Title is too long" });
    expect(await prisma.syncLog.count({ where: { channel: "SHOPIFY", type: "CHANNEL_ERROR" } })).toBe(1);
  });
});

describe("Shopify : commandes", () => {
  async function listedJacket() {
    await connectShopify(owner);
    const connection = await prisma.channelConnection.findFirstOrThrow({ where: { channel: "SHOPIFY" } });
    const p = await createSingle(owner);
    await publishOn(owner, "SHOPIFY", p.id);
    return { connection, product: p };
  }

  it("webhook signé : commande importée, stock décompté ; même commande par relevé : comptée une fois", async () => {
    const { connection } = await listedJacket();
    const order: FakeShopifyOrder = fakeShopify.simulateSale("VESTE-001");
    expect((await shopifyWebhook(connection.id, "orders/create", order, { secret: "faux" })).statusCode).toBe(401);
    expect((await shopifyWebhook(connection.id, "orders/create", order, { shop: "autre.myshopify.com" })).statusCode).toBe(404);
    expect(await prisma.order.count()).toBe(0);

    expect((await shopifyWebhook(connection.id, "orders/create", order)).statusCode).toBe(200);
    expect(await stockOf("VESTE-001")).toBe(0);
    const orders = (await app.inject({ method: "GET", url: "/orders?channel=SHOPIFY", cookies: owner })).json();
    expect(orders.items[0]).toMatchObject({
      channel: "SHOPIFY",
      externalOrderId: String(order.id),
      status: "PAID",
      buyerName: "Riley Shopper",
      totalCents: 4500,
      lines: [expect.objectContaining({ sku: "VESTE-001", quantity: 1, oversoldQty: 0 })],
    });

    queue.jobs.length = 0;
    await queue.add({ name: "orders:poll", data: {} });
    await queue.drain(channelDeps);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.syncLog.count({ where: { type: "SALE" } })).toBe(1);
  });

  it("relevé de secours : vente importée ; annulation dans Shopify → stock remis et renvoyé", async () => {
    await listedJacket();
    const order = fakeShopify.simulateSale("VESTE-001");
    await queue.add({ name: "orders:poll", data: {} });
    await queue.drain(channelDeps);
    expect(await stockOf("VESTE-001")).toBe(0);

    fakeShopify.cancelOrder(order.id);
    await queue.add({ name: "orders:poll", data: {} });
    await queue.drain(channelDeps);
    expect(await stockOf("VESTE-001")).toBe(1);
    expect((await prisma.order.findFirstOrThrow()).status).toBe("CANCELLED");
    expect(fakeShopify.variantBySku("VESTE-001")!.variant.quantity).toBe(1);
  });
});

describe("WooCommerce : connexion", () => {
  it("vérifie les clés, les chiffre, enregistre les webhooks de commandes", async () => {
    expect((await connectWoo(owner, { consumerKey: "ck_bad1" })).json().error).toBe("woo_keys_invalid");
    expect((await connectWoo(owner, { storeUrl: "pas une adresse" })).json().error).toBe("store_url_invalid");
    expect((await connectWoo(owner, { consumerKey: "clé" })).statusCode).toBe(400);
    expect(await prisma.channelConnection.count()).toBe(0);

    const res = await connectWoo(owner);
    expect(res.json()).toEqual({ connected: true });
    const c = await prisma.channelConnection.findFirstOrThrow({ where: { channel: "WOOCOMMERCE" } });
    expect(c).toMatchObject({ status: "CONNECTED", externalAccountId: "https://boutique.example.com", externalUsername: "boutique.example.com" });
    expect(c.accessTokenEnc).not.toContain("cs_test456");
    expect(JSON.parse(channelDeps.cipher.decrypt(c.accessTokenEnc))).toEqual({ key: "ck_test123", secret: "cs_test456" });
    expect(fakeWoo.webhooks.map((w) => [w.topic, w.delivery_url])).toEqual([
      ["order.created", `https://api.test/webhooks/woocommerce/${c.id}`],
      ["order.updated", `https://api.test/webhooks/woocommerce/${c.id}`],
    ]);
    expect(channelDeps.cipher.decrypt(c.webhookSecretEnc!)).toBe(fakeWoo.webhooks[0]!.secret);

    // Déconnexion : nos webhooks sont retirés du site.
    await app.inject({ method: "DELETE", url: "/channels/woocommerce", cookies: owner });
    expect(fakeWoo.webhooks).toHaveLength(0);
  });
});

describe("WooCommerce : publication, stock et commandes", () => {
  it("article unique → produit simple ; variantes → produit variable avec variations", async () => {
    await connectWoo(owner);
    const single = await createSingle(owner);
    await publishOn(owner, "WOOCOMMERCE", single.id, { category: "Vestes" });
    expect(fakeWoo.bySku("VESTE-001")!.product).toMatchObject({
      type: "simple",
      name: "Veste en jean",
      regular_price: "45.00",
      manage_stock: true,
      stock_quantity: 1,
      status: "publish",
      description: "<p>Années 90.</p><p>Très bon état.</p>",
      tags: [{ name: "Vestes" }],
    });

    const tees = await createTshirts(owner, { "TS-M": 2, "TS-L": 5 });
    await publishOn(owner, "WOOCOMMERCE", tees.id);
    const parent = fakeWoo.bySku("TS-M")!.product;
    expect(parent).toMatchObject({ type: "variable", attributes: [{ name: "Taille", options: ["M", "L"], visible: true, variation: true }] });
    expect(parent.variations.map((v) => [v.sku, v.stock_quantity, v.attributes])).toEqual([
      ["TS-M", 2, [{ name: "Taille", option: "M" }]],
      ["TS-L", 5, [{ name: "Taille", option: "L" }]],
    ]);
    const ls = await listings("WOOCOMMERCE");
    expect(ls.every((l) => l.status === "LISTED")).toBe(true);

    // Variante supprimée de la fiche : la variation disparaît aussi.
    const detail = (await app.inject({ method: "GET", url: `/products/${tees.id}`, cookies: owner })).json();
    const keep = detail.variants.filter((v: { sku: string }) => v.sku === "TS-L");
    const upd = await app.inject({
      method: "PUT",
      url: `/products/${tees.id}`,
      cookies: owner,
      payload: { ...detail, photoIds: detail.photos.map((ph: { id: string }) => ph.id), variants: keep },
    });
    expect(upd.statusCode).toBe(200);
    await queue.drain(channelDeps);
    expect(fakeWoo.bySku("TS-L")!.product.variations.map((v) => v.sku)).toEqual(["TS-L"]);
    expect((await listings("WOOCOMMERCE")).find((l) => l.skuCode === "TS-M")).toMatchObject({ status: "REMOVED" });
  });

  it("webhook signé : vente importée, stock à 0 ; commande non payée ignorée ; ping accepté", async () => {
    await connectWoo(owner);
    const c = await prisma.channelConnection.findFirstOrThrow({ where: { channel: "WOOCOMMERCE" } });
    const p = await createSingle(owner);
    await publishOn(owner, "WOOCOMMERCE", p.id);

    const ping = await app.inject({ method: "POST", url: `/webhooks/woocommerce/${c.id}`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "webhook_id=12" });
    expect(ping.statusCode).toBe(200);

    const order = fakeWoo.simulateSale("VESTE-001");
    expect((await wooWebhook(c.id, { ...order, status: "pending" })).statusCode).toBe(200);
    expect(await prisma.order.count()).toBe(0);
    expect((await wooWebhook(c.id, order, { secret: "faux" })).statusCode).toBe(401);

    expect((await wooWebhook(c.id, order)).statusCode).toBe(200);
    expect(await stockOf("VESTE-001")).toBe(0);
    expect(await prisma.order.findFirstOrThrow()).toMatchObject({ channel: "WOOCOMMERCE", externalOrderId: String(order.id), status: "PAID", buyerName: "Casey Customer" });

    // Annulée dans WooCommerce : stock remis, et renvoyé au site.
    expect((await wooWebhook(c.id, { ...order, status: "cancelled" }, { topic: "order.updated" })).statusCode).toBe(200);
    expect(await stockOf("VESTE-001")).toBe(1);
    await queue.drain(channelDeps);
    expect(fakeWoo.bySku("VESTE-001")!.product.stock_quantity).toBe(1);
  });

  it("relevé de secours : vente sur le site importée et propagée aux autres canaux", async () => {
    await connectWoo(owner);
    await connectShopify(owner);
    const p = await createTshirts(owner, { "TS-M": 2 });
    await publishOn(owner, "WOOCOMMERCE", p.id);
    await publishOn(owner, "SHOPIFY", p.id);

    fakeWoo.simulateSale("TS-M");
    await queue.add({ name: "orders:poll", data: {} });
    await queue.drain(channelDeps);
    expect(await stockOf("TS-M")).toBe(1);
    // Anti double vente : Shopify suit la vente faite sur WooCommerce.
    expect(fakeShopify.variantBySku("TS-M")!.variant.quantity).toBe(1);

    await queue.add({ name: "orders:poll", data: {} });
    await queue.drain(channelDeps);
    expect(await prisma.order.count()).toBe(1);
  });
});
