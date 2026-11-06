import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RESET_MAX_ATTEMPTS } from "./routes/auth.js";
import { createTestApp, prisma, resetDatabase, sessionCookie } from "./test/helpers.js";

/** Mot de passe oublié : code à 6 chiffres par email, valable 2 minutes. */

const { app, mailer } = createTestApp();

const OWNER = { email: "proprio@exemple.fr", password: "ancien-motdepasse", name: "Awa Proprio", organizationName: "Boutique Awa" };
const NEW_PASSWORD = "nouveau-motdepasse";

const lastCode = () => mailer.sent.at(-1)?.text.match(/\b\d{6}\b/)?.[0] ?? "";
const forgot = (email = OWNER.email) => app.inject({ method: "POST", url: "/auth/password/forgot", payload: { email } });
const reset = (code: string, password = NEW_PASSWORD) =>
  app.inject({ method: "POST", url: "/auth/password/reset", payload: { email: OWNER.email, code, password } });
const login = (password: string) => app.inject({ method: "POST", url: "/auth/login", payload: { email: OWNER.email, password } });
/** Recule la date du dernier code, comme si du temps avait passé. */
const age = (seconds: number) =>
  prisma.passwordReset.updateMany({
    data: { createdAt: new Date(Date.now() - seconds * 1000), expiresAt: new Date(Date.now() + (120 - seconds) * 1000) },
  });

beforeEach(async () => {
  await resetDatabase();
  mailer.sent = [];
  expect((await app.inject({ method: "POST", url: "/auth/signup", payload: OWNER })).statusCode).toBe(201);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("mot de passe oublié", () => {
  it("envoie un code à 6 chiffres valable 2 minutes, sans le stocker en clair", async () => {
    const res = await forgot();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ expiresInSeconds: 120, resendInSeconds: 30 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(OWNER.email);
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(mailer.sent[0]!.subject).toContain(code);

    const row = await prisma.passwordReset.findFirstOrThrow();
    expect(row.codeHash).not.toContain(code);
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttl).toBeGreaterThan(119_000);
    expect(ttl).toBeLessThan(121_000);
  });

  it("répond pareil pour un email inconnu, sans envoyer d'email", async () => {
    const res = await forgot("inconnu@exemple.fr");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ expiresInSeconds: 120, resendInSeconds: 30 });
    expect(mailer.sent).toHaveLength(0);
  });

  it("le bon code change le mot de passe, ferme les autres sessions et connecte", async () => {
    const oldSession = sessionCookie(await login(OWNER.password));
    await forgot();
    const res = await reset(lastCode());
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(OWNER.email);
    const newSession = sessionCookie(res);

    expect((await app.inject({ method: "GET", url: "/auth/me", cookies: oldSession })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies: newSession })).statusCode).toBe(200);
    expect((await login(OWNER.password)).statusCode).toBe(401);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
  });

  it("un code ne sert qu'une fois", async () => {
    await forgot();
    const code = lastCode();
    expect((await reset(code)).statusCode).toBe(200);
    const again = await reset(code, "encore-un-autre");
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("invalid_code");
  });

  it("refuse un code expiré après 2 minutes", async () => {
    await forgot();
    await prisma.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await reset(lastCode());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("code_expired");
    expect((await login(OWNER.password)).statusCode).toBe(200);
  });

  it(`bloque le code après ${RESET_MAX_ATTEMPTS} essais faux`, async () => {
    await forgot();
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < RESET_MAX_ATTEMPTS; i++) {
      const res = await reset(wrong);
      expect(res.json()).toEqual({ error: "invalid_code", remaining: RESET_MAX_ATTEMPTS - i });
    }
    expect((await reset(wrong)).json().error).toBe("too_many_attempts");
    expect((await reset(code)).json().error).toBe("too_many_attempts");
  });

  it("un nouvel envoi attend 30 secondes, et seul le dernier code compte", async () => {
    await forgot();
    const first = lastCode();
    await forgot();
    expect(mailer.sent).toHaveLength(1);

    await age(31);
    await forgot();
    expect(mailer.sent).toHaveLength(2);
    const second = lastCode();
    if (first !== second) expect((await reset(first)).json().error).toBe("invalid_code");
    expect((await reset(second)).statusCode).toBe(200);
  });

  it("refuse un mot de passe trop court", async () => {
    await forgot();
    expect((await reset(lastCode(), "court")).statusCode).toBe(400);
  });
});
