import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { recordOrder, signDepopWebhook, type DepopOrder } from "@hub/channels";
import { JPEG, createTestApp, multipartFile, prisma, resetDatabase, sessionCookie } from "./test/helpers.js";

const { app, queue, fakeDepop, channelDeps } = createTestApp();
type Cookies = Record<string, string>;
let owner: Cookies;
let organizationId: string;

async function signup(email: string, organizationName: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password: "motdepasse-test", name: "Test", organizationName },
  });
  return sessionCookie(res);
}

async function uploadPhoto(cookies: Cookies) {
  return (await app.inject({ method: "POST", url: "/photos", cookies, ...multipartFile(JPEG) })).json().id as string;
}

async function createSingle(cookies: Cookies, sku = "VESTE-001") {
  const res = await app.inject({
    method: "POST",
    url: "/products",
    cookies,
    payload: {
      mode: "SINGLE",
      title: "Veste en jean",
      description: "Années 90.",
      brand: "Levi's",
      condition: "USED_GOOD",
      sku,
      priceCents: 4500,
      photoIds: [await uploadPhoto(cookies)],
    },
  });
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
      variants: Object.entries(stock).map(([sku, quantity], i) => ({
        sku,
        attributes: { Taille: ["M", "L", "XL"][i]! },
        priceCents: 2000,
        quantity,
      })),
    },
  });
  return res.json();
}

const sell = (cookies: Cookies, lines: Array<{ sku: string; quantity: number }>, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/orders",
    cookies,
    payload: { lines: lines.map((l) => ({ ...l, unitPriceCents: 2000 })), ...extra },
  });

const stockOf = async (code: string) => (await prisma.sku.findFirstOrThrow({ where: { code } })).quantity;

async function connectDepop(cookies: Cookies) {
  const start = await app.inject({ method: "POST", url: "/channels/depop/connect", cookies });
  const consent = await app.inject({ method: "GET", url: `/dev/fake-depop/authorize${new URL(start.json().url).search}` });
  const back = new URL(consent.headers.location as string);
  await app.inject({ method: "GET", url: `/channels/depop/callback${back.search}`, cookies });
  await app.inject({ method: "PUT", url: "/channels/depop/settings", cookies, payload: { shipFromState: "CA" } });
  return prisma.channelConnection.findFirstOrThrow({ where: { channel: "DEPOP" } });
}

async function publishOnDepop(cookies: Cookies, productId: string, details: Record<string, unknown>) {
  await app.inject({
    method: "PUT",
    url: `/products/${productId}/channels/DEPOP`,
    cookies,
    payload: { enabled: true, price: { mode: "BASE" }, details },
  });
  expect((await app.inject({ method: "POST", url: `/products/${productId}/channels/DEPOP/publish`, cookies })).statusCode).toBe(200);
  await queue.drain(channelDeps);
}

/** Webhook signé comme le ferait Depop. */
function depopWebhook(connectionId: string, order: DepopOrder, opts: { secret?: string; timestamp?: number } = {}) {
  const body = JSON.stringify({ id: "evt-1", event_type: "v1:order.new", created_at: new Date().toISOString(), data: order });
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const secret = opts.secret ?? fakeDepop.webhooks[0]!.secret;
  return app.inject({
    method: "POST",
    url: `/webhooks/depop/${connectionId}`,
    headers: {
      "content-type": "application/json",
      "x-depop-timestamp": timestamp,
      "x-depop-signature": signDepopWebhook(secret, body, timestamp),
    },
    payload: body,
  });
}

beforeEach(async () => {
  await resetDatabase();
  queue.jobs.length = 0;
  fakeDepop.products.clear();
  fakeDepop.orders.length = 0;
  fakeDepop.webhooks.length = 0;
  owner = await signup("proprio@exemple.fr", "Boutique A");
  organizationId = (await prisma.organization.findFirstOrThrow()).id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("US8 : stock central", () => {
  it("une vente saisie décompte le stock et s'inscrit au journal ; l'annulation le remet", async () => {
    await createTshirts(owner, { "TS-M": 3, "TS-L": 1 });
    const res = await sell(owner, [{ sku: "TS-M", quantity: 2 }], { buyerName: "Sam" });
    expect(res.statusCode).toBe(201);
    expect(await stockOf("TS-M")).toBe(1);

    const log = (await app.inject({ method: "GET", url: "/stock/log", cookies: owner })).json();
    expect(log.items[0]).toMatchObject({ type: "SALE", sku: "TS-M", delta: -2, quantityAfter: 1, channel: null });

    const cancel = await app.inject({ method: "POST", url: `/orders/${res.json().id}/cancel`, cookies: owner });
    expect(cancel.json().status).toBe("CANCELLED");
    expect(await stockOf("TS-M")).toBe(3);
    // Annuler deux fois ne remet pas le stock deux fois.
    await app.inject({ method: "POST", url: `/orders/${res.json().id}/cancel`, cookies: owner });
    expect(await stockOf("TS-M")).toBe(3);
  });

  it("refuse une vente saisie au-delà du stock ou sur un SKU inconnu, sans rien décompter", async () => {
    await createTshirts(owner, { "TS-M": 1, "TS-L": 5 });
    const tooMany = await sell(owner, [
      { sku: "TS-L", quantity: 1 },
      { sku: "TS-M", quantity: 2 },
    ]);
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json()).toMatchObject({ error: "insufficient_stock", sku: "TS-M", available: 1 });
    expect(await stockOf("TS-L")).toBe(5); // toute la vente est annulée
    expect((await sell(owner, [{ sku: "INCONNU", quantity: 1 }])).json()).toMatchObject({ error: "unknown_sku", sku: "INCONNU" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("ventes simultanées dans OmniList : jamais plus de ventes que de stock", async () => {
    await createTshirts(owner, { "TS-M": 5 });
    const results = await Promise.all(Array.from({ length: 20 }, () => sell(owner, [{ sku: "TS-M", quantity: 1 }])));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(15);
    expect(await stockOf("TS-M")).toBe(0);
    expect(await prisma.syncLog.count({ where: { type: "SALE" } })).toBe(5);
  });

  it("ventes simultanées venant des canaux : aucune mise à jour perdue, doubles ventes tracées", async () => {
    await createTshirts(owner, { "TS-M": 3 });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        recordOrder(prisma, {
          organizationId,
          channel: "DEPOP",
          source: "CHANNEL",
          externalOrderId: `D-${i}`,
          status: "PAID",
          currency: "USD",
          placedAt: new Date(),
          lines: [{ sku: "TS-M", quantity: 1, unitPriceCents: 2000 }],
        }),
      ),
    );
    expect(await stockOf("TS-M")).toBe(0);
    const lines = await prisma.orderLine.findMany();
    expect(lines).toHaveLength(10);
    expect(lines.reduce((n, l) => n + l.oversoldQty, 0)).toBe(7);
    expect(await prisma.syncLog.count({ where: { type: "OVERSOLD" } })).toBe(7);
    const orders = (await app.inject({ method: "GET", url: "/orders?channel=DEPOP", cookies: owner })).json();
    expect(orders.items.filter((o: { oversold: boolean }) => o.oversold)).toHaveLength(7);
  });

  it("modifier la fiche n'écrase pas le stock après une vente", async () => {
    const p = await createSingle(owner);
    await sell(owner, [{ sku: "VESTE-001", quantity: 1 }]);
    const master = {
      mode: "SINGLE",
      title: "Veste en jean (retouchée)",
      description: "Années 90.",
      brand: "Levi's",
      condition: "USED_GOOD",
      sku: "VESTE-001",
      priceCents: 4000,
      photoIds: p.photos.map((ph: { id: string }) => ph.id),
    };
    const res = await app.inject({ method: "PUT", url: `/products/${p.id}`, cookies: owner, payload: master });
    expect(res.json().quantity).toBe(0);
    expect(await stockOf("VESTE-001")).toBe(0);
  });

  it("page Stock : filtres rupture et stock faible ; correction manuelle", async () => {
    await createTshirts(owner, { "TS-M": 0, "TS-L": 2, "TS-XL": 9 });
    const out = (await app.inject({ method: "GET", url: "/stock?filter=out", cookies: owner })).json();
    expect(out.items.map((i: { sku: string }) => i.sku)).toEqual(["TS-M"]);
    const low = (await app.inject({ method: "GET", url: "/stock?filter=low", cookies: owner })).json();
    expect(low.items.map((i: { sku: string }) => i.sku)).toEqual(["TS-L"]);
    expect(low.items[0]).toMatchObject({ title: "T-shirt coton bio", attributes: { Taille: "L" }, quantity: 2 });

    const adj = await app.inject({ method: "POST", url: "/stock/TS-M/adjust", cookies: owner, payload: { delta: 4, note: "Réassort" } });
    expect(adj.json()).toEqual({ sku: "TS-M", quantity: 4 });
    expect((await app.inject({ method: "POST", url: "/stock/TS-M/adjust", cookies: owner, payload: { delta: -5 } })).json().error).toBe("stock_negative");
    expect((await app.inject({ method: "POST", url: "/stock/TS-M/adjust", cookies: owner, payload: {} })).statusCode).toBe(400);
    const log = (await app.inject({ method: "GET", url: "/stock/log?type=ADJUSTMENT", cookies: owner })).json();
    expect(log.items).toEqual([expect.objectContaining({ sku: "TS-M", delta: 4, quantityAfter: 4, message: "Réassort" })]);
  });
});

describe("US8 : propagation vers Depop", () => {
  it("vente en direct : quantité mise à jour sur Depop, puis annonce vendue à 0 ; réassort : remise en vente", async () => {
    await connectDepop(owner);
    const p = await createTshirts(owner, { "TS-M": 2 });
    await publishOnDepop(owner, p.id, { department: "menswear", productType: "tshirts", shippingCents: 0 });
    expect(fakeDepop.products.get("TS-M")!.body.quantity).toBe(2);

    await sell(owner, [{ sku: "TS-M", quantity: 1 }]);
    expect(queue.jobs).toEqual([{ name: "publish", data: { productId: p.id, channel: "DEPOP" } }]);
    await queue.drain(channelDeps);
    expect(fakeDepop.products.get("TS-M")!.body.quantity).toBe(1);

    await sell(owner, [{ sku: "TS-M", quantity: 1 }]);
    await queue.drain(channelDeps);
    expect(fakeDepop.products.get("TS-M")!.status).toBe("sold");

    await app.inject({ method: "POST", url: "/stock/TS-M/adjust", cookies: owner, payload: { delta: 3 } });
    await queue.drain(channelDeps);
    expect(fakeDepop.products.get("TS-M")!).toMatchObject({ status: "selling", body: expect.objectContaining({ quantity: 3 }) });

    const log = (await app.inject({ method: "GET", url: "/stock/log?channel=DEPOP", cookies: owner })).json();
    expect(log.items.map((i: { message: string }) => i.message)).toEqual(["updated:3", "marked_sold", "updated:1", "listed:2"]);
  });
});

describe("US9 : commandes Depop", () => {
  async function listedJacket() {
    const connection = await connectDepop(owner);
    const p = await createSingle(owner);
    await publishOnDepop(owner, p.id, { department: "menswear", productType: "jackets", sizeId: 4, shippingCents: 599 });
    return { connection, product: p };
  }

  it("connexion : le webhook des commandes est enregistré chez Depop, secret chiffré", async () => {
    const connection = await connectDepop(owner);
    expect(fakeDepop.webhooks).toEqual([
      expect.objectContaining({ url: `https://api.test/webhooks/depop/${connection.id}`, eventTypes: ["v1:order.*"] }),
    ]);
    expect(connection.webhookSecretEnc).not.toBe(fakeDepop.webhooks[0]!.secret);
    expect(channelDeps.cipher.decrypt(connection.webhookSecretEnc!)).toBe(fakeDepop.webhooks[0]!.secret);
  });

  it("webhook signé : commande importée et stock décompté ; signature fausse ou trop ancienne refusée", async () => {
    const { connection } = await listedJacket();
    const order = fakeDepop.simulateSale("VESTE-001");
    expect((await depopWebhook(connection.id, order, { secret: "faux" })).statusCode).toBe(401);
    expect((await depopWebhook(connection.id, order, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    expect(await prisma.order.count()).toBe(0);

    const res = await depopWebhook(connection.id, order);
    expect(res.statusCode).toBe(200);
    expect(await stockOf("VESTE-001")).toBe(0);
    const orders = (await app.inject({ method: "GET", url: "/orders", cookies: owner })).json();
    expect(orders.items[0]).toMatchObject({
      channel: "DEPOP",
      source: "CHANNEL",
      externalOrderId: order.purchase_id,
      status: "PAID",
      buyerName: "Jordan Buyer",
      totalCents: 4500,
      lines: [expect.objectContaining({ sku: "VESTE-001", title: "Veste en jean", quantity: 1, oversoldQty: 0 })],
    });
  });

  it("même commande par webhook et par relevé, au même instant : comptée une seule fois", async () => {
    const { connection } = await listedJacket();
    const order = fakeDepop.simulateSale("VESTE-001");
    queue.jobs.length = 0;
    await queue.add({ name: "orders:poll", data: {} });
    await Promise.all([depopWebhook(connection.id, order), depopWebhook(connection.id, order), queue.drain(channelDeps)]);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.syncLog.count({ where: { type: "SALE" } })).toBe(1);
    expect(await prisma.syncLog.count({ where: { type: "OVERSOLD" } })).toBe(0);
    expect(await stockOf("VESTE-001")).toBe(0);
  });

  it("relevé de secours : vente importée, annonce passée en rupture, annulation Depop → stock remis", async () => {
    await listedJacket();
    const order = fakeDepop.simulateSale("VESTE-001");
    await queue.add({ name: "orders:poll", data: {} });
    await queue.drain(channelDeps);
    expect(await stockOf("VESTE-001")).toBe(0);
    expect(await prisma.channelListing.findFirstOrThrow({ where: { skuCode: "VESTE-001" } })).toMatchObject({ status: "REMOVED", errorCode: "out_of_stock" });

    fakeDepop.setOrderStatus(order.purchase_id, "CANCELLED");
    await queue.add({ name: "orders:poll", data: {} });
    await queue.drain(channelDeps);
    expect(await stockOf("VESTE-001")).toBe(1);
    expect((await prisma.order.findFirstOrThrow()).status).toBe("CANCELLED");
    // Remis en vente sur Depop.
    expect(fakeDepop.products.get("VESTE-001")!.status).toBe("selling");
  });

  it("commande d'une annonce créée hors OmniList : enregistrée, rien de décompté", async () => {
    const { connection } = await listedJacket();
    const order = fakeDepop.simulateSale("VESTE-001");
    order.line_items[0]!.sku = null;
    await depopWebhook(connection.id, order);
    const line = await prisma.orderLine.findFirstOrThrow();
    expect(line).toMatchObject({ matched: false, skuCode: expect.stringMatching(/^depop-\d+$/) });
    expect(await stockOf("VESTE-001")).toBe(1);
    expect(await prisma.syncLog.count({ where: { type: "UNKNOWN_SKU" } })).toBe(1);
  });

  it("liste des commandes filtrable par canal et par statut", async () => {
    await createTshirts(owner, { "TS-M": 5 });
    await sell(owner, [{ sku: "TS-M", quantity: 1 }]);
    const mercari = await sell(owner, [{ sku: "TS-M", quantity: 1 }], { channel: "MERCARI", reference: "M-123" });
    await app.inject({ method: "POST", url: `/orders/${mercari.json().id}/cancel`, cookies: owner });
    // Même référence Mercari : refusée (déjà enregistrée).
    expect((await sell(owner, [{ sku: "TS-M", quantity: 1 }], { channel: "MERCARI", reference: "M-123" })).json().error).toBe("order_exists");

    const get = async (q: string) => (await app.inject({ method: "GET", url: `/orders${q}`, cookies: owner })).json();
    expect((await get("")).total).toBe(2);
    expect((await get("?channel=manual")).items).toHaveLength(1);
    expect((await get("?channel=MERCARI")).items[0]).toMatchObject({ externalOrderId: "manual:M-123", status: "CANCELLED" });
    expect((await get("?status=PAID")).items).toHaveLength(1);
    expect((await get("?channel=DEPOP")).items).toHaveLength(0);
    expect(await stockOf("TS-M")).toBe(4);
  });
});
