import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ASSISTED_CONSENT_VERSION } from "@hub/shared";
import { JPEG, createTestApp, multipartFile, prisma, resetDatabase, sessionCookie, tokenFromLastEmail } from "./test/helpers.js";

const { app, mailer, queue, channelDeps } = createTestApp();
type Cookies = Record<string, string>;
let owner: Cookies;

async function signup(email: string, organizationName: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password: "motdepasse-test", name: "Test", organizationName },
  });
  return sessionCookie(res);
}

async function createJacket(cookies: Cookies, sku = "VESTE-001") {
  const photo = await app.inject({ method: "POST", url: "/photos", cookies, ...multipartFile(JPEG) });
  const res = await app.inject({
    method: "POST",
    url: "/products",
    cookies,
    payload: {
      mode: "SINGLE",
      title: "Veste en jean vintage",
      description: "Veste en jean des années 90.",
      brand: "Levi's",
      condition: "USED_GOOD",
      sku,
      priceCents: 4500,
      photoIds: [photo.json().id],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

const consent = (cookies: Cookies, body: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/extension/consents/poshmark", cookies, payload: { version: ASSISTED_CONSENT_VERSION, accepted: true, ...body } });

const publish = async (cookies: Cookies, productId: string) => {
  const res = await app.inject({ method: "POST", url: `/products/${productId}/channels/POSHMARK/publish`, cookies });
  await queue.drain(channelDeps);
  return res;
};

async function pair(cookies: Cookies) {
  const res = await app.inject({ method: "POST", url: "/extension/devices", cookies, payload: { name: "Chrome du bureau" } });
  expect(res.statusCode).toBe(201);
  const { token, device } = res.json();
  return { id: device.id as string, headers: { authorization: `Bearer ${token}`, "x-extension-version": "0.1.0" } };
}

type Headers = Record<string, string>;
const tasks = (headers: Headers) => app.inject({ method: "GET", url: "/extension/tasks", headers });
const claim = (headers: Headers, id: string) => app.inject({ method: "POST", url: `/extension/tasks/${id}/claim`, headers });
const complete = (headers: Headers, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/extension/tasks/${id}/complete`, headers, payload });
const fail = (headers: Headers, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/extension/tasks/${id}/fail`, headers, payload });

const listing = (sku = "VESTE-001") => prisma.channelListing.findFirstOrThrow({ where: { skuCode: sku, channel: "POSHMARK" } });

/** Fiche publiée sur Poshmark : une tâche « publier » attend le vendeur. */
async function queuedListTask(cookies: Cookies, sku = "VESTE-001") {
  const product = await createJacket(cookies, sku);
  expect((await publish(cookies, product.id)).statusCode).toBe(200);
  const task = await prisma.browserTask.findFirstOrThrow({ where: { skuCode: sku, status: "QUEUED" } });
  return { product, task };
}

beforeEach(async () => {
  await resetDatabase();
  queue.jobs.length = 0;
  mailer.sent = [];
  owner = await signup("proprio@exemple.fr", "Boutique A");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("accord du vendeur", () => {
  it("publier sur Poshmark demande l'accord", async () => {
    const product = await createJacket(owner);
    const res = await publish(owner, product.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("consent_missing");
  });

  it("l'accord fixe le plafond par défaut ; impossible de le monter au-dessus", async () => {
    expect((await consent(owner, { dailyCap: 500 })).json()).toMatchObject({ error: "daily_cap_too_high", max: 20 });
    expect((await consent(owner, { version: ASSISTED_CONSENT_VERSION + 1 })).statusCode).toBe(400);
    const ok = await consent(owner);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().consent.dailyCap).toBe(20);
    const lower = await app.inject({ method: "PATCH", url: "/extension/consents/poshmark", cookies: owner, payload: { dailyCap: 5 } });
    expect(lower.json().consent.dailyCap).toBe(5);
    const list = await app.inject({ method: "GET", url: "/extension/consents", cookies: owner });
    expect(list.json().items.find((i: { channel: string }) => i.channel === "POSHMARK")).toMatchObject({ consent: { dailyCap: 5 }, site: { enabled: true } });
  });

  it("refuse un site qui n'est pas assisté", async () => {
    const res = await app.inject({ method: "POST", url: "/extension/consents/ebay", cookies: owner, payload: { version: ASSISTED_CONSENT_VERSION, accepted: true } });
    expect(res.statusCode).toBe(400);
  });

  it("publier crée une tâche « publier » et l'annonce attend le vendeur", async () => {
    await consent(owner);
    await queuedListTask(owner);
    expect(await listing()).toMatchObject({ status: "PENDING", errorCode: "awaiting_seller" });
  });

  it("retirer l'accord annule les tâches en attente", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    expect((await app.inject({ method: "DELETE", url: "/extension/consents/poshmark", cookies: owner })).statusCode).toBe(204);
    expect(await prisma.browserTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "CANCELLED", errorCode: "consent_withdrawn" });
  });
});

describe("navigateurs reliés", () => {
  it("le jeton est donné une fois et stocké haché ; sans jeton, 401", async () => {
    const device = await pair(owner);
    const stored = await prisma.extensionDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(stored.tokenHash).not.toContain("omx_");
    expect((await tasks({})).statusCode).toBe(401);
    expect((await tasks({ authorization: "Bearer omx_faux" })).statusCode).toBe(401);
    const ok = await tasks(device.headers);
    expect(ok.statusCode).toBe(200);
    expect((await prisma.extensionDevice.findUniqueOrThrow({ where: { id: device.id } })).extensionVersion).toBe("0.1.0");
  });

  it("un employé ne peut pas relier de navigateur", async () => {
    await app.inject({ method: "POST", url: "/invitations", cookies: owner, payload: { email: "employe@exemple.fr" } });
    const accepted = await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: tokenFromLastEmail(mailer), name: "Employé", password: "motdepasse-test" },
    });
    const res = await app.inject({ method: "POST", url: "/extension/devices", cookies: sessionCookie(accepted), payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
  });

  it("révoquer coupe l'accès et rend les tâches ouvertes", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    const device = await pair(owner);
    expect((await claim(device.headers, task.id)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/extension/devices/${device.id}`, cookies: owner })).statusCode).toBe(204);
    expect((await tasks(device.headers)).statusCode).toBe(401);
    expect((await prisma.browserTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("QUEUED");
  });

  it("une autre boutique ne voit pas les tâches", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    const other = await pair(await signup("autre@exemple.fr", "Boutique B"));
    expect((await tasks(other.headers)).json().items).toHaveLength(0);
    expect((await claim(other.headers, task.id)).statusCode).toBe(404);
  });
});

describe("tâches dans le navigateur", () => {
  it("parcours complet : ouvrir, remplir, publier, renvoyer le lien", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    const device = await pair(owner);

    const list = await tasks(device.headers);
    expect(list.json().items).toEqual([expect.objectContaining({ id: task.id, channel: "POSHMARK", type: "LIST", sku: "VESTE-001", status: "QUEUED" })]);

    const opened = await claim(device.headers, task.id);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      type: "LIST",
      openUrl: "https://poshmark.com/create-listing",
      product: { title: "Veste en jean vintage", brand: "Levi's", priceCents: 4500, quantity: 1 },
    });
    expect(opened.json().product.photos).toHaveLength(1);

    // Le lien doit venir du site lui-même.
    expect((await complete(device.headers, task.id, { listingUrl: "https://evil.example/listing/1" })).json().error).toBe("listing_url_invalid");
    expect((await complete(device.headers, task.id, {})).json().error).toBe("listing_reference_missing");
    const done = await complete(device.headers, task.id, { listingUrl: "https://poshmark.com/listing/veste-abc123", externalId: "abc123" });
    expect(done.statusCode).toBe(200);
    expect(await listing()).toMatchObject({ status: "LISTED", externalId: "abc123", externalUrl: "https://poshmark.com/listing/veste-abc123", errorCode: null });
    expect((await tasks(device.headers)).json().items).toHaveLength(0);
  });

  it("deux navigateurs ne peuvent pas ouvrir la même tâche", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    const a = await pair(owner);
    const b = await pair(owner);
    expect((await claim(a.headers, task.id)).statusCode).toBe(200);
    expect((await claim(b.headers, task.id)).json().error).toBe("task_not_open");
    expect((await complete(b.headers, task.id, { externalId: "x" })).json().error).toBe("task_not_claimed");
    // Fermée sans résultat : elle revient dans la file.
    expect((await app.inject({ method: "POST", url: `/extension/tasks/${task.id}/release`, headers: a.headers })).statusCode).toBe(200);
    expect((await claim(b.headers, task.id)).statusCode).toBe(200);
  });

  it("le plafond du jour bloque les publications au-delà", async () => {
    await consent(owner, { dailyCap: 1 });
    const first = await queuedListTask(owner, "VESTE-001");
    const second = await queuedListTask(owner, "VESTE-002");
    const device = await pair(owner);
    expect((await claim(device.headers, first.task.id)).statusCode).toBe(200);
    const blocked = await claim(device.headers, second.task.id);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("daily_cap_reached");
    const config = await app.inject({ method: "GET", url: "/extension/config", headers: device.headers });
    expect(config.json().sites.find((s: { channel: string }) => s.channel === "POSHMARK")).toMatchObject({ dailyCap: 1, usedLast24h: 1, consented: true });
  });

  it("une alerte du site (CAPTCHA) met le site en pause jusqu'à la reprise", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    const device = await pair(owner);
    await claim(device.headers, task.id);
    const res = await fail(device.headers, task.id, { code: "captcha", message: "Vérification demandée" });
    expect(res.json()).toMatchObject({ paused: true, final: false });
    expect(await prisma.channelConsent.findFirstOrThrow()).toMatchObject({ pauseReason: "captcha" });

    const blocked = await claim(device.headers, task.id);
    expect(blocked.json().error).toBe("channel_paused");
    const product = await prisma.browserTask.findUniqueOrThrow({ where: { id: task.id } });
    expect((await publish(owner, product.productId!)).json().error).toBe("channel_paused");

    await app.inject({ method: "PATCH", url: "/extension/consents/poshmark", cookies: owner, payload: { paused: false } });
    expect((await claim(device.headers, task.id)).statusCode).toBe(200);
  });

  it("après 3 essais ratés, l'annonce passe en erreur", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    const device = await pair(owner);
    for (let i = 0; i < 3; i++) {
      expect((await claim(device.headers, task.id)).statusCode).toBe(200);
      await fail(device.headers, task.id, { code: "form_not_found" });
    }
    expect(await prisma.browserTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(await listing()).toMatchObject({ status: "ERROR", errorCode: "form_not_found" });
  });

  it("5 échecs de suite mettent le site en pause", async () => {
    await consent(owner);
    const device = await pair(owner);
    for (let i = 1; i <= 5; i++) {
      const { task } = await queuedListTask(owner, `VESTE-00${i}`);
      await claim(device.headers, task.id);
      const res = await fail(device.headers, task.id, { code: "form_not_found" });
      expect(res.json().paused).toBe(i === 5);
    }
    expect(await prisma.channelConsent.findFirstOrThrow()).toMatchObject({ pauseReason: "too_many_failures" });
  });

  it("site coupé par OmniList : plus aucune tâche ne s'ouvre", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    await prisma.siteSwitch.create({ data: { channel: "POSHMARK", enabled: false, reason: "site modifié" } });
    const device = await pair(owner);
    expect((await claim(device.headers, task.id)).json().error).toBe("site_disabled");
    const config = await app.inject({ method: "GET", url: "/extension/config", headers: device.headers });
    expect(config.json().sites.find((s: { channel: string }) => s.channel === "POSHMARK").enabled).toBe(false);
  });

  it("article vendu ailleurs : une tâche « à retirer » remplace la publication", async () => {
    await consent(owner);
    const { task } = await queuedListTask(owner);
    const device = await pair(owner);
    await claim(device.headers, task.id);
    await complete(device.headers, task.id, { listingUrl: "https://poshmark.com/listing/veste-abc123" });

    // Stock à 0 (vente sur un autre canal) : le worker crée la tâche de retrait.
    await app.inject({ method: "POST", url: "/stock/VESTE-001/adjust", cookies: owner, payload: { set: 0, note: "Vendu ailleurs" } });
    await queue.drain(channelDeps);
    const delist = await prisma.browserTask.findFirstOrThrow({ where: { type: "DELIST", status: "QUEUED" } });
    expect(await listing()).toMatchObject({ status: "PENDING", errorCode: "awaiting_seller" });

    const opened = await claim(device.headers, delist.id);
    expect(opened.json()).toMatchObject({ type: "DELIST", openUrl: "https://poshmark.com/listing/veste-abc123" });
    await complete(device.headers, delist.id, {});
    expect(await listing()).toMatchObject({ status: "REMOVED", errorCode: "out_of_stock" });
  });
});
