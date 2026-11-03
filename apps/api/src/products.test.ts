import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  JPEG,
  PNG,
  createTestApp,
  multipartFile,
  prisma,
  resetDatabase,
  sessionCookie,
  tokenFromLastEmail,
} from "./test/helpers.js";

/**
 * US4 : je crée un produit avec photos, prix, quantité et variantes.
 *   - Champs obligatoires validés ; 1 à 12 photos ; article unique (quantité 1) ou variantes
 * US5 : j'ajuste titre, catégorie et prix par canal.
 *   - Prix par canal en valeur ou en pourcentage ; aperçu indicatif des frais
 */

const { app, mailer, storage } = createTestApp();
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

async function upload(cookies: Cookies, content = JPEG) {
  const res = await app.inject({ method: "POST", url: "/photos", cookies, ...multipartFile(content) });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function uploadMany(cookies: Cookies, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await upload(cookies));
  return ids;
}

const single = (photoIds: string[], extra: Record<string, unknown> = {}) => ({
  mode: "SINGLE",
  title: "Veste en jean vintage Levi's",
  description: "Veste en jean des années 90, très bon état.",
  brand: "Levi's",
  condition: "USED_GOOD",
  sku: "VESTE-001",
  priceCents: 4500,
  photoIds,
  ...extra,
});

const withVariants = (photoIds: string[], extra: Record<string, unknown> = {}) => ({
  mode: "VARIANTS",
  title: "T-shirt coton bio",
  description: "T-shirt 100 % coton bio.",
  condition: "NEW",
  photoIds,
  variants: [
    { sku: "TS-M-NOIR", attributes: { Taille: "M", Couleur: "Noir" }, priceCents: 2000, quantity: 5 },
    { sku: "TS-L-NOIR", attributes: { Taille: "L", Couleur: "Noir" }, priceCents: 2200, quantity: 3 },
  ],
  ...extra,
});

async function create(cookies: Cookies, body: unknown) {
  return app.inject({ method: "POST", url: "/products", cookies, payload: body as object });
}

beforeEach(async () => {
  await resetDatabase();
  storage.objects.clear();
  mailer.sent = [];
  owner = await signup("proprio@exemple.fr", "Boutique A");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("photos", () => {
  it("accepte JPEG et PNG, détecte le vrai type et sert l'image à la boutique", async () => {
    const res = await app.inject({ method: "POST", url: "/photos", cookies: owner, ...multipartFile(PNG, "x.jpg", "image/jpeg") });
    expect(res.statusCode).toBe(201);
    expect(res.json().contentType).toBe("image/png");
    const img = await app.inject({ method: "GET", url: res.json().url, cookies: owner });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.equals(PNG)).toBe(true);
  });

  it("refuse un fichier qui n'est pas une image", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/photos",
      cookies: owner,
      ...multipartFile(Buffer.from("%PDF-1.4 faux"), "doc.jpg", "image/jpeg"),
    });
    expect(res.statusCode).toBe(415);
  });

  it("refuse une photo de plus de 10 Mo", async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await app.inject({ method: "POST", url: "/photos", cookies: owner, ...multipartFile(big) });
    expect(res.statusCode).toBe(413);
  });

  it("une autre boutique ne peut pas voir la photo", async () => {
    const id = await upload(owner);
    const other = await signup("autre@exemple.fr", "Boutique B");
    expect((await app.inject({ method: "GET", url: `/photos/${id}`, cookies: other })).statusCode).toBe(404);
  });

  it("sans session, envoi refusé", async () => {
    expect((await app.inject({ method: "POST", url: "/photos", ...multipartFile(JPEG) })).statusCode).toBe(401);
  });
});

describe("US4 : article unique", () => {
  it("crée la fiche : quantité 1, photos dans l'ordre, 3 canaux activés", async () => {
    const photos = await uploadMany(owner, 3);
    const res = await create(owner, single([photos[2]!, photos[0]!, photos[1]!]));
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p).toMatchObject({ mode: "SINGLE", sku: "VESTE-001", priceCents: 4500, quantity: 1, currency: "USD", brand: "Levi's" });
    expect(p.photos.map((ph: { id: string }) => ph.id)).toEqual([photos[2], photos[0], photos[1]]);
    // eBay, Amazon et TikTok Shop activés d'office ; les autres s'activent dans leur onglet.
    expect(p.channels.map((c: { channel: string; enabled: boolean }) => [c.channel, c.enabled])).toEqual([
      ["EBAY", true],
      ["AMAZON", true],
      ["TIKTOK_SHOP", true],
      ["WALMART", false],
      ["ETSY", false],
      ["SHOPIFY", false],
      ["FACEBOOK_MARKETPLACE", false],
      ["MERCARI", false],
      ["POSHMARK", false],
      ["DEPOP", false],
      ["VINTED", false],
      ["GRAILED", false],
    ]);
  });

  it.each([
    ["sans titre", { title: "  " }],
    ["sans description", { description: "" }],
    ["sans SKU", { sku: "" }],
    ["SKU invalide", { sku: "SKU AVEC ESPACES" }],
    ["prix nul", { priceCents: 0 }],
    ["prix décimal", { priceCents: 19.5 }],
  ])("refuse une fiche %s", async (_label, extra) => {
    const photos = await uploadMany(owner, 1);
    const res = await create(owner, single(photos, extra));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
  });

  it("exige au moins 1 photo", async () => {
    expect((await create(owner, single([]))).statusCode).toBe(400);
  });

  it("accepte 12 photos et refuse la 13e", async () => {
    const photos = await uploadMany(owner, 13);
    expect((await create(owner, single(photos))).statusCode).toBe(400);
    expect((await create(owner, single(photos.slice(0, 12)))).statusCode).toBe(201);
  });

  it("refuse une photo d'une autre boutique ou déjà utilisée", async () => {
    const other = await signup("autre@exemple.fr", "Boutique B");
    const foreign = await upload(other);
    expect((await create(owner, single([foreign]))).json().error).toBe("invalid_photos");

    const mine = await uploadMany(owner, 1);
    expect((await create(owner, single(mine))).statusCode).toBe(201);
    const reuse = await create(owner, single(mine, { sku: "AUTRE-SKU" }));
    expect(reuse.json().error).toBe("invalid_photos");
  });

  it("le SKU est unique dans la boutique (sans tenir compte de la casse)", async () => {
    await create(owner, single(await uploadMany(owner, 1)));
    const dup = await create(owner, single(await uploadMany(owner, 1), { sku: "veste-001" }));
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: "sku_taken", sku: "VESTE-001" });
  });

  it("deux boutiques peuvent utiliser le même SKU", async () => {
    await create(owner, single(await uploadMany(owner, 1)));
    const other = await signup("autre@exemple.fr", "Boutique B");
    expect((await create(other, single(await uploadMany(other, 1)))).statusCode).toBe(201);
  });
});

describe("US4 : variantes", () => {
  it("crée un produit avec variantes : quantité totale et fourchette de prix", async () => {
    const res = await create(owner, withVariants(await uploadMany(owner, 2)));
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.quantity).toBe(8);
    expect(p.priceRange).toEqual({ minCents: 2000, maxCents: 2200 });
    expect(p.variants.map((v: { sku: string }) => v.sku)).toEqual(["TS-M-NOIR", "TS-L-NOIR"]);
    expect(p.sku).toBeNull();
  });

  it("refuse un produit à variantes sans variante", async () => {
    expect((await create(owner, withVariants(await uploadMany(owner, 1), { variants: [] }))).statusCode).toBe(400);
  });

  it("refuse deux variantes identiques ou avec le même SKU", async () => {
    const photos = await uploadMany(owner, 1);
    const sameCombo = withVariants(photos, {
      variants: [
        { sku: "A", attributes: { Taille: "M" }, priceCents: 1000, quantity: 1 },
        { sku: "B", attributes: { Taille: "m" }, priceCents: 1000, quantity: 1 },
      ],
    });
    expect((await create(owner, sameCombo)).statusCode).toBe(400);
    const sameSku = withVariants(photos, {
      variants: [
        { sku: "A", attributes: { Taille: "M" }, priceCents: 1000, quantity: 1 },
        { sku: "a", attributes: { Taille: "L" }, priceCents: 1000, quantity: 1 },
      ],
    });
    expect((await create(owner, sameSku)).statusCode).toBe(400);
  });

  it("refuse des variantes qui n'ont pas les mêmes options", async () => {
    const body = withVariants(await uploadMany(owner, 1), {
      variants: [
        { sku: "A", attributes: { Taille: "M" }, priceCents: 1000, quantity: 1 },
        { sku: "B", attributes: { Couleur: "Bleu" }, priceCents: 1000, quantity: 1 },
      ],
    });
    expect((await create(owner, body)).statusCode).toBe(400);
  });
});

describe("modification et suppression", () => {
  it("réordonne, ajoute et retire des photos ; la photo retirée est supprimée du stockage", async () => {
    const [a, b, c] = await uploadMany(owner, 3);
    const created = (await create(owner, single([a!, b!]))).json();
    const removedKey = (await prisma.productPhoto.findUniqueOrThrow({ where: { id: a! } })).storageKey;

    const res = await app.inject({ method: "PUT", url: `/products/${created.id}`, cookies: owner, payload: single([c!, b!]) });
    expect(res.statusCode).toBe(200);
    expect(res.json().photos.map((p: { id: string }) => p.id)).toEqual([c, b]);
    expect(storage.objects.has(removedKey)).toBe(false);
    expect(await prisma.productPhoto.findUnique({ where: { id: a! } })).toBeNull();
  });

  it("met à jour les variantes en gardant leur identifiant (et leur stock)", async () => {
    const created = (await create(owner, withVariants(await uploadMany(owner, 1)))).json();
    const [m] = created.variants;
    const res = await app.inject({
      method: "PUT",
      url: `/products/${created.id}`,
      cookies: owner,
      payload: withVariants(
        created.photos.map((p: { id: string }) => p.id),
        {
          variants: [
            { id: m.id, sku: "TS-M-NOIR", attributes: { Taille: "M", Couleur: "Noir" }, priceCents: 2100, quantity: 4 },
            { sku: "TS-XL-NOIR", attributes: { Taille: "XL", Couleur: "Noir" }, priceCents: 2400, quantity: 2 },
          ],
        },
      ),
    });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    // Stock central : la fiche ne modifie pas le stock d'une variante existante (5), seulement celui d'une nouvelle.
    expect(p.variants[0]).toMatchObject({ id: m.id, priceCents: 2100, quantity: 5 });
    expect(p.variants[1]).toMatchObject({ sku: "TS-XL-NOIR", quantity: 2 });
    expect(p.variants.map((v: { sku: string }) => v.sku)).toEqual(["TS-M-NOIR", "TS-XL-NOIR"]);
    // L'ancien SKU TS-L-NOIR est libéré.
    expect((await create(owner, single(await uploadMany(owner, 1), { sku: "TS-L-NOIR" }))).statusCode).toBe(201);
  });

  it("supprime le produit et ses photos", async () => {
    const created = (await create(owner, single(await uploadMany(owner, 2)))).json();
    expect(storage.objects.size).toBe(2);
    expect((await app.inject({ method: "DELETE", url: `/products/${created.id}`, cookies: owner })).statusCode).toBe(204);
    expect(storage.objects.size).toBe(0);
    expect((await app.inject({ method: "GET", url: `/products/${created.id}`, cookies: owner })).statusCode).toBe(404);
  });

  it("une autre boutique ne voit ni ne modifie le produit", async () => {
    const created = (await create(owner, single(await uploadMany(owner, 1)))).json();
    const other = await signup("autre@exemple.fr", "Boutique B");
    expect((await app.inject({ method: "GET", url: `/products/${created.id}`, cookies: other })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/products/${created.id}`, cookies: other })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/products", cookies: other })).json().total).toBe(0);
  });
});

describe("liste des produits", () => {
  it("liste avec recherche par titre ou SKU", async () => {
    await create(owner, single(await uploadMany(owner, 1)));
    await create(owner, withVariants(await uploadMany(owner, 1)));
    const all = (await app.inject({ method: "GET", url: "/products", cookies: owner })).json();
    expect(all.total).toBe(2);
    expect(all.items[0]).toMatchObject({ title: "T-shirt coton bio", variantCount: 2, quantity: 8 });
    expect(all.items[0].photoUrl).toMatch(/^\/photos\//);

    const bySku = (await app.inject({ method: "GET", url: "/products?q=ts-l", cookies: owner })).json();
    expect(bySku.items.map((i: { title: string }) => i.title)).toEqual(["T-shirt coton bio"]);
    const byTitle = (await app.inject({ method: "GET", url: "/products?q=jean", cookies: owner })).json();
    expect(byTitle.items.map((i: { title: string }) => i.title)).toEqual(["Veste en jean vintage Levi's"]);
  });
});

describe("US5 : réglages par canal", () => {
  const put = (id: string, channel: string, payload: object) =>
    app.inject({ method: "PUT", url: `/products/${id}/channels/${channel}`, cookies: owner, payload });

  it("prix en pourcentage : prix canal et aperçu des frais", async () => {
    const p = (await create(owner, single(await uploadMany(owner, 1), { priceCents: 10000 }))).json();
    const res = await put(p.id, "EBAY", {
      enabled: true,
      title: "Veste jean Levi's 90s",
      category: "Vestes homme",
      price: { mode: "PERCENT", percentBps: 1000 },
    });
    expect(res.statusCode).toBe(200);
    const ch = res.json();
    expect(ch.effectiveTitle).toBe("Veste jean Levi's 90s");
    // 100 $ + 10 % = 110 $ ; frais eBay indicatifs 13,25 % + 0,40 $ = 14,98 $
    expect(ch.preview).toEqual([
      { variantId: null, sku: "VESTE-001", basePriceCents: 10000, priceCents: 11000, feeCents: 1498, netCents: 9502 },
    ]);
    expect(ch.warnings).toEqual([]);
  });

  it("prix fixe pour un article unique", async () => {
    const p = (await create(owner, single(await uploadMany(owner, 1)))).json();
    const ch = (await put(p.id, "AMAZON", { enabled: true, category: "Mode", price: { mode: "FIXED", priceCents: 4999 } })).json();
    expect(ch.preview[0]).toMatchObject({ priceCents: 4999, feeCents: 750, netCents: 4249 });
  });

  it("prix fixe refusé pour un produit à variantes ; le pourcentage s'applique à chaque variante", async () => {
    const p = (await create(owner, withVariants(await uploadMany(owner, 1)))).json();
    const fixed = await put(p.id, "TIKTOK_SHOP", { enabled: true, price: { mode: "FIXED", priceCents: 1000 } });
    expect(fixed.json().error).toBe("fixed_price_single_only");

    const ch = (await put(p.id, "TIKTOK_SHOP", { enabled: true, category: "T-shirts", price: { mode: "PERCENT", percentBps: -500 } })).json();
    expect(ch.preview.map((r: { sku: string; priceCents: number }) => [r.sku, r.priceCents])).toEqual([
      ["TS-M-NOIR", 1900],
      ["TS-L-NOIR", 2090],
    ]);
  });

  it("activer Poshmark : apparaît dans la liste, frais au forfait sous 15 $", async () => {
    const p = (await create(owner, single(await uploadMany(owner, 1)))).json(); // 45,00 $
    const ch = (await put(p.id, "POSHMARK", { enabled: true, category: "Vestes", price: { mode: "FIXED", priceCents: 1200 } })).json();
    expect(ch).toMatchObject({ channel: "POSHMARK", label: "Poshmark", enabled: true, titleMax: 80, warnings: [] });
    expect(ch.preview[0]).toMatchObject({ priceCents: 1200, feeCents: 295, netCents: 905 });
    const list = (await app.inject({ method: "GET", url: "/products", cookies: owner })).json();
    expect(list.items[0].channels).toEqual(["EBAY", "AMAZON", "TIKTOK_SHOP", "POSHMARK"]);
  });

  it("pourcentage hors bornes refusé", async () => {
    const p = (await create(owner, single(await uploadMany(owner, 1)))).json();
    expect((await put(p.id, "EBAY", { enabled: true, price: { mode: "PERCENT", percentBps: -9500 } })).statusCode).toBe(400);
  });

  it("titre trop long pour eBay : avertissement sur le titre maître, refus sur un titre spécifique", async () => {
    const long = "T".repeat(120);
    const p = (await create(owner, single(await uploadMany(owner, 1), { title: long }))).json();
    const ebay = p.channels.find((c: { channel: string }) => c.channel === "EBAY");
    expect(ebay.warnings.map((w: { code: string }) => w.code)).toContain("title_too_long");
    const amazon = p.channels.find((c: { channel: string }) => c.channel === "AMAZON");
    expect(amazon.warnings.map((w: { code: string }) => w.code)).not.toContain("title_too_long");

    const res = await put(p.id, "EBAY", { enabled: true, title: long, price: { mode: "BASE" } });
    expect(res.json()).toEqual({ error: "title_too_long", max: 80 });
  });

  it("désactiver un canal le retire de la liste et supprime ses avertissements", async () => {
    const p = (await create(owner, single(await uploadMany(owner, 1)))).json();
    const ch = (await put(p.id, "TIKTOK_SHOP", { enabled: false, price: { mode: "BASE" } })).json();
    expect(ch.enabled).toBe(false);
    expect(ch.warnings).toEqual([]);
    const list = (await app.inject({ method: "GET", url: "/products", cookies: owner })).json();
    expect(list.items[0].channels).toEqual(["EBAY", "AMAZON"]);
  });

  it("passer en variantes ramène un prix fixe au prix maître", async () => {
    const p = (await create(owner, single(await uploadMany(owner, 1)))).json();
    await put(p.id, "EBAY", { enabled: true, price: { mode: "FIXED", priceCents: 5000 } });
    const res = await app.inject({
      method: "PUT",
      url: `/products/${p.id}`,
      cookies: owner,
      payload: withVariants(p.photos.map((ph: { id: string }) => ph.id)),
    });
    expect(res.json().channels.find((c: { channel: string }) => c.channel === "EBAY").price).toEqual({ mode: "BASE" });
  });

  it("canal inconnu refusé", async () => {
    const p = (await create(owner, single(await uploadMany(owner, 1)))).json();
    expect((await put(p.id, "MYSPACE", { enabled: true, price: { mode: "BASE" } })).statusCode).toBe(400);
  });
});

describe("droits", () => {
  it("l'employé gère les produits de sa boutique", async () => {
    await app.inject({ method: "POST", url: "/invitations", cookies: owner, payload: { email: "employe@exemple.fr" } });
    const accepted = await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: tokenFromLastEmail(mailer), name: "Employé", password: "motdepasse-employe" },
    });
    const employee = sessionCookie(accepted);
    expect((await create(employee, single(await uploadMany(employee, 1)))).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/products", cookies: owner })).json().total).toBe(1);
  });

  it("sans session : 401", async () => {
    expect((await app.inject({ method: "GET", url: "/products" })).statusCode).toBe(401);
  });
});
