import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RetryableChannelError } from "@hub/channels";
import { JPEG, TEST_PUBLIC_API_URL, TEST_WEB_URL, createTestApp, multipartFile, prisma, resetDatabase, sessionCookie, tokenFromLastEmail } from "./test/helpers.js";

const { app, mailer, queue, fakeDepop, channelDeps } = createTestApp();
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

async function uploadPhoto(cookies: Cookies) {
  const res = await app.inject({ method: "POST", url: "/photos", cookies, ...multipartFile(JPEG) });
  return res.json().id as string;
}

/** Parcours complet : OmniList → page d'accord (fausse) → retour avec le code. */
async function connectDepop(cookies: Cookies) {
  const start = await app.inject({ method: "POST", url: "/channels/depop/connect", cookies });
  expect(start.statusCode).toBe(200);
  const authorize = new URL(start.json().url);
  expect(authorize.pathname).toBe("/api/dev/fake-depop/authorize");
  expect(authorize.search).toContain("scope=products_read%2Bproducts_write");
  const consent = await app.inject({ method: "GET", url: `/dev/fake-depop/authorize${authorize.search}` });
  expect(consent.statusCode).toBe(302);
  const back = new URL(consent.headers.location as string);
  expect(back.origin + back.pathname).toBe(`${TEST_WEB_URL}/api/channels/depop/callback`);
  return app.inject({ method: "GET", url: `/channels/depop/callback${back.search}`, cookies });
}

async function setShipFrom(cookies: Cookies, state = "CA") {
  return app.inject({ method: "PUT", url: "/channels/depop/settings", cookies, payload: { shipFromState: state } });
}

const depopDetails = { department: "menswear", productType: "jackets", sizeId: 4, shippingCents: 599 };

async function createJacket(cookies: Cookies, extra: Record<string, unknown> = {}) {
  const photoId = await uploadPhoto(cookies);
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
      sku: "VESTE-001",
      priceCents: 4500,
      photoIds: [photoId],
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const putDepop = (cookies: Cookies, productId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "PUT",
    url: `/products/${productId}/channels/DEPOP`,
    cookies,
    payload: { enabled: true, price: { mode: "BASE" }, details: depopDetails, ...body },
  });

const publish = (cookies: Cookies, productId: string) =>
  app.inject({ method: "POST", url: `/products/${productId}/channels/DEPOP/publish`, cookies });

const listing = (sku: string) => prisma.channelListing.findFirstOrThrow({ where: { skuCode: sku, channel: "DEPOP" } });

beforeEach(async () => {
  await resetDatabase();
  queue.jobs.length = 0;
  fakeDepop.products.clear();
  fakeDepop.failNextPut = null;
  mailer.sent = [];
  owner = await signup("proprio@exemple.fr", "Boutique A");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("connexion Depop", () => {
  it("liste les 13 canaux ; Depop branché et disponible, pas encore connecté", async () => {
    const res = await app.inject({ method: "GET", url: "/channels", cookies: owner });
    const items = res.json().items;
    expect(items).toHaveLength(13);
    expect(items.find((c: { channel: string }) => c.channel === "DEPOP")).toMatchObject({
      supported: true,
      available: true,
      testMode: true,
      connection: null,
    });
    expect(items.find((c: { channel: string }) => c.channel === "AMAZON")).toMatchObject({ supported: false });
  });

  it("OAuth + PKCE : la boutique est connectée, jetons chiffrés en base", async () => {
    const res = await connectDepop(owner);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${TEST_WEB_URL}/channels?connected=depop`);
    const c = await prisma.channelConnection.findFirstOrThrow({ where: { channel: "DEPOP" } });
    expect(c).toMatchObject({ status: "CONNECTED", externalUsername: "omnilist_demo" });
    expect(c.accessTokenEnc).not.toMatch(/^pat_/);
    expect(channelDeps.cipher.decrypt(c.accessTokenEnc)).toMatch(/^pat_/);
    expect(await prisma.oAuthState.count()).toBe(0);
  });

  it("refuse un state inconnu, réutilisé, ou lancé par une autre personne", async () => {
    const bad = await app.inject({ method: "GET", url: "/channels/depop/callback?code=x&state=inconnu", cookies: owner });
    expect(bad.headers.location).toBe(`${TEST_WEB_URL}/channels?error=invalid_state&channel=depop`);

    // Une autre boutique termine la connexion lancée par le propriétaire de la boutique A.
    const start = await app.inject({ method: "POST", url: "/channels/depop/connect", cookies: owner });
    const consent = await app.inject({ method: "GET", url: `/dev/fake-depop/authorize${new URL(start.json().url).search}` });
    const back = new URL(consent.headers.location as string);
    const other = await signup("autre@exemple.fr", "Boutique B");
    const stolen = await app.inject({ method: "GET", url: `/channels/depop/callback${back.search}`, cookies: other });
    expect(stolen.headers.location).toContain("error=invalid_state");
    expect(await prisma.channelConnection.count()).toBe(0);
  });

  it("refus du vendeur sur Depop : retour avec l'erreur", async () => {
    const start = await app.inject({ method: "POST", url: "/channels/depop/connect", cookies: owner });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const res = await app.inject({ method: "GET", url: `/channels/depop/callback?error=access_denied&state=${state}`, cookies: owner });
    expect(res.headers.location).toBe(`${TEST_WEB_URL}/channels?error=access_denied&channel=depop`);
  });

  it("un employé ne peut pas connecter de canal", async () => {
    await app.inject({ method: "POST", url: "/invitations", cookies: owner, payload: { email: "employe@exemple.fr" } });
    const token = tokenFromLastEmail(mailer);
    const accepted = await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token, name: "Employé", password: "motdepasse-employe" },
    });
    const employee = sessionCookie(accepted);
    expect((await app.inject({ method: "POST", url: "/channels/depop/connect", cookies: employee })).statusCode).toBe(403);
  });

  it("État d'expédition : validé puis enregistré ; déconnexion", async () => {
    expect((await setShipFrom(owner)).statusCode).toBe(404); // pas encore connecté
    await connectDepop(owner);
    expect((await setShipFrom(owner, "ZZ")).statusCode).toBe(400);
    expect((await setShipFrom(owner, "NY")).json()).toEqual({ settings: { shipFromState: "NY" } });
    expect((await app.inject({ method: "DELETE", url: "/channels/depop", cookies: owner })).statusCode).toBe(204);
    expect(await prisma.channelConnection.count()).toBe(0);
  });

  it("canal pas encore branché : refusé", async () => {
    expect((await app.inject({ method: "POST", url: "/channels/amazon/connect", cookies: owner })).json().error).toBe("channel_not_supported");
  });
});

describe("publication sur Depop", () => {
  beforeEach(async () => {
    await connectDepop(owner);
    await setShipFrom(owner, "CA");
  });

  it("onglet Depop : contrôles propres à Depop, puis aucun avertissement une fois rempli", async () => {
    const p = await createJacket(owner);
    const depop = p.channels.find((c: { channel: string }) => c.channel === "DEPOP");
    expect(depop).toMatchObject({ enabled: false, publishable: true, listings: [] });
    expect(depop.warnings.map((w: { code: string }) => w.code)).toEqual(["department_missing", "product_type_missing", "shipping_missing"]);

    const saved = (await putDepop(owner, p.id, {})).json();
    expect(saved.warnings).toEqual([]);
    expect(saved.details).toEqual(depopDetails);
  });

  it("refuse des champs Depop invalides", async () => {
    const p = await createJacket(owner);
    expect((await putDepop(owner, p.id, { details: { department: "aliens" } })).statusCode).toBe(400);
    expect((await putDepop(owner, p.id, { details: { shippingCents: -1 } })).statusCode).toBe(400);
    expect((await putDepop(owner, p.id, { details: { inconnu: 1 } })).statusCode).toBe(400);
  });

  it("publie : en attente, puis en ligne après le worker, avec des photos accessibles par lien signé", async () => {
    const p = await createJacket(owner);
    await putDepop(owner, p.id, {});
    const res = await publish(owner, p.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().listings).toMatchObject([{ sku: "VESTE-001", status: "PENDING" }]);
    expect(queue.jobs).toEqual([{ name: "publish", data: { productId: p.id, channel: "DEPOP" } }]);

    await queue.drain(channelDeps);
    const l = await listing("VESTE-001");
    expect(l).toMatchObject({ status: "LISTED", errorCode: null });
    expect(l.externalUrl).toMatch(/^https:\/\/www\.depop\.com\/products\/omnilist_demo-\d+\/$/);

    const sent = fakeDepop.products.get("VESTE-001")!.body;
    expect(sent).toMatchObject({
      address: { country_code: "US", state: "CA" },
      description: "Veste en jean vintage\n\nVeste en jean des années 90.",
      price_amount: "45.00",
      condition: "used_excellent",
      size_set_id: 95,
      size_id: 4,
      brand_name: "Levi's",
      national_shipping_cost: "5.99",
    });
    // Depop télécharge la photo sans session, par le lien signé.
    const photo = new URL(sent.pictures[0]!.url);
    expect(photo.origin).toBe(TEST_PUBLIC_API_URL);
    const path = photo.pathname + photo.search;
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: path.replace(/sig=[^&]+/, "sig=faux") })).statusCode).toBe(403);
  });

  it("refuse de publier une fiche incomplète, ou sans connexion ou État d'expédition", async () => {
    const p = await createJacket(owner, { brand: "" });
    await putDepop(owner, p.id, {});
    const incomplete = await publish(owner, p.id);
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json()).toMatchObject({ error: "listing_incomplete", warnings: [{ code: "brand_missing" }] });

    await prisma.channelConnection.updateMany({ data: { settings: {} } });
    expect((await publish(owner, p.id)).json().error).toBe("ship_from_missing");
    await app.inject({ method: "DELETE", url: "/channels/depop", cookies: owner });
    expect((await publish(owner, p.id)).json().error).toBe("channel_not_connected");
    expect(queue.jobs).toEqual([]);
  });

  it("modifier la fiche maître met à jour l'annonce ; désactiver Depop la retire", async () => {
    const p = await createJacket(owner);
    await putDepop(owner, p.id, {});
    await publish(owner, p.id);
    await queue.drain(channelDeps);

    const master = {
      mode: "SINGLE",
      title: "Veste en jean vintage",
      description: "Veste en jean des années 90.",
      brand: "Levi's",
      condition: "USED_GOOD",
      sku: "VESTE-001",
      priceCents: 3900,
      photoIds: p.photos.map((ph: { id: string }) => ph.id),
    };
    await app.inject({ method: "PUT", url: `/products/${p.id}`, cookies: owner, payload: master });
    expect(queue.jobs).toHaveLength(1);
    await queue.drain(channelDeps);
    expect(fakeDepop.products.get("VESTE-001")!.body.price_amount).toBe("39.00");

    await putDepop(owner, p.id, { enabled: false });
    await queue.drain(channelDeps);
    expect(fakeDepop.products.has("VESTE-001")).toBe(false);
    expect((await listing("VESTE-001")).status).toBe("REMOVED");
  });

  it("supprimer la fiche retire l'annonce de Depop", async () => {
    const p = await createJacket(owner);
    await putDepop(owner, p.id, {});
    await publish(owner, p.id);
    await queue.drain(channelDeps);
    expect((await app.inject({ method: "DELETE", url: `/products/${p.id}`, cookies: owner })).statusCode).toBe(204);
    expect(queue.jobs).toEqual([{ name: "remove", data: { organizationId: expect.any(String), channel: "DEPOP", skus: ["VESTE-001"] } }]);
    await queue.drain(channelDeps);
    expect(fakeDepop.products.size).toBe(0);
  });

  it("variantes : taille déduite de l'option Taille ; rupture et variante supprimée", async () => {
    const photoId = await uploadPhoto(owner);
    const variants = [
      { sku: "TS-M", attributes: { Taille: "M" }, priceCents: 2000, quantity: 2 },
      { sku: "TS-L", attributes: { Taille: "L" }, priceCents: 2000, quantity: 1 },
    ];
    const body = { mode: "VARIANTS", title: "T-shirt", description: "Coton bio.", brand: "Nike", condition: "NEW", photoIds: [photoId], variants };
    const p = (await app.inject({ method: "POST", url: "/products", cookies: owner, payload: body })).json();
    const saved = (await putDepop(owner, p.id, { details: { department: "menswear", productType: "tshirts", shippingCents: 0 } })).json();
    expect(saved.warnings).toEqual([]);
    await publish(owner, p.id);
    await queue.drain(channelDeps);
    expect(fakeDepop.products.get("TS-M")!.body).toMatchObject({ size_set_id: 54, size_id: 4, quantity: 2, condition: "brand_new" });
    expect(fakeDepop.products.get("TS-L")!.body).toMatchObject({ size_id: 5 });

    // TS-M en rupture (stock mis à 0 sur la page Stock), TS-L retirée de la fiche.
    await app.inject({ method: "POST", url: "/stock/TS-M/adjust", cookies: owner, payload: { set: 0 } });
    const ids = p.variants.map((v: { id: string }) => v.id);
    const next = { ...body, variants: [{ ...variants[0], id: ids[0] }] };
    await app.inject({ method: "PUT", url: `/products/${p.id}`, cookies: owner, payload: next });
    await queue.drain(channelDeps);
    expect(fakeDepop.products.get("TS-M")!.status).toBe("sold");
    expect((await listing("TS-M")).status).toBe("REMOVED");
    expect(fakeDepop.products.has("TS-L")).toBe(false);
    expect((await listing("TS-L")).status).toBe("REMOVED");

    // Taille inconnue : avertissement par variante.
    const odd = { ...body, variants: [{ sku: "TS-Z", attributes: { Taille: "Énorme" }, priceCents: 2000, quantity: 1 }] };
    const res = (await app.inject({ method: "PUT", url: `/products/${p.id}`, cookies: owner, payload: odd })).json();
    expect(res.channels.find((c: { channel: string }) => c.channel === "DEPOP").warnings).toEqual([{ code: "size_unmatched", sku: "TS-Z" }]);
  });

  it("jeton expiré : rafraîchi automatiquement ; accès retiré : à reconnecter", async () => {
    const p = await createJacket(owner);
    await putDepop(owner, p.id, {});
    fakeDepop.expireAccessTokens();
    await prisma.channelConnection.updateMany({ data: { accessTokenExpiresAt: new Date(0) } });
    await publish(owner, p.id);
    await queue.drain(channelDeps);
    expect((await listing("VESTE-001")).status).toBe("LISTED");

    fakeDepop.revokeAll();
    await prisma.channelConnection.updateMany({ data: { accessTokenExpiresAt: new Date(0) } });
    await publish(owner, p.id);
    await queue.drain(channelDeps);
    expect(await listing("VESTE-001")).toMatchObject({ status: "ERROR", errorCode: "needs_reauth" });
    expect((await prisma.channelConnection.findFirstOrThrow()).status).toBe("NEEDS_REAUTH");
    expect((await publish(owner, p.id)).json().error).toBe("channel_needs_reauth");
  });

  it("refus de Depop : erreur affichée ; surcharge : le job sera relancé", async () => {
    const p = await createJacket(owner);
    await putDepop(owner, p.id, {});
    fakeDepop.failNextPut = { status: 422, body: { errors: [{ code: "invalid_brand", message: "Invalid brand" }] } };
    await publish(owner, p.id);
    await queue.drain(channelDeps);
    expect(await listing("VESTE-001")).toMatchObject({ status: "ERROR", errorCode: "invalid_brand", errorMessage: "Invalid brand" });

    fakeDepop.failNextPut = { status: 429, body: { error: "TOO_MANY_REQUESTS", error_description: "Too many requests" } };
    await publish(owner, p.id);
    await expect(queue.drain(channelDeps)).rejects.toBeInstanceOf(RetryableChannelError);
    expect((await listing("VESTE-001")).errorCode).toBe("TOO_MANY_REQUESTS");
  });
});
