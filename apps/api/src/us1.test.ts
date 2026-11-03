import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, prisma, resetDatabase, sessionCookie, tokenFromLastEmail } from "./test/helpers.js";

/**
 * US1 : en tant que propriétaire, je crée un compte et j'invite un employé.
 * - Invitation par email
 * - Rôles propriétaire et employé
 * - L'employé ne gère ni l'abonnement ni les connexions de canaux
 */

const { app, mailer } = createTestApp();

const OWNER = { email: "proprio@exemple.fr", password: "motdepasse-proprio", name: "Awa Proprio", organizationName: "Boutique Awa" };
const EMPLOYEE = { email: "employe@exemple.fr", password: "motdepasse-employe", name: "Jean Employé" };

async function signupOwner() {
  const res = await app.inject({ method: "POST", url: "/auth/signup", payload: OWNER });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res);
}

async function invite(cookies: Record<string, string>, email = EMPLOYEE.email) {
  return app.inject({ method: "POST", url: "/invitations", cookies, payload: { email } });
}

async function inviteAndAccept() {
  const owner = await signupOwner();
  expect((await invite(owner)).statusCode).toBe(201);
  const token = tokenFromLastEmail(mailer);
  const res = await app.inject({
    method: "POST",
    url: "/invitations/accept",
    payload: { token, name: EMPLOYEE.name, password: EMPLOYEE.password },
  });
  expect(res.statusCode).toBe(200);
  return { owner, employee: sessionCookie(res), token, body: res.json() };
}

beforeEach(async () => {
  await resetDatabase();
  mailer.sent = [];
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("compte propriétaire", () => {
  it("l'inscription crée le compte, l'organisation et le rôle propriétaire", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/signup", payload: OWNER });
    expect(res.statusCode).toBe(201);
    const me = res.json();
    expect(me.user.email).toBe(OWNER.email);
    expect(me.organization.name).toBe(OWNER.organizationName);
    expect(me.role).toBe("OWNER");
    expect(me.permissions).toEqual(expect.arrayContaining(["billing:manage", "channels:manage", "members:invite"]));

    const cookie = res.cookies.find((c) => c.name === "hub_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");

    const user = await prisma.user.findUniqueOrThrow({ where: { email: OWNER.email } });
    expect(user.passwordHash).not.toContain(OWNER.password);
  });

  it("refuse un email déjà utilisé", async () => {
    await signupOwner();
    const res = await app.inject({ method: "POST", url: "/auth/signup", payload: OWNER });
    expect(res.statusCode).toBe(409);
  });

  it("refuse un mot de passe trop court", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/signup", payload: { ...OWNER, password: "court" } });
    expect(res.statusCode).toBe(400);
  });

  it("connexion : mauvais mot de passe refusé, bon mot de passe accepté", async () => {
    await signupOwner();
    const bad = await app.inject({ method: "POST", url: "/auth/login", payload: { email: OWNER.email, password: "faux-mot-de-passe" } });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "PROPRIO@exemple.fr ", password: OWNER.password } });
    expect(good.statusCode).toBe(200);
    expect(good.json().role).toBe("OWNER");
  });

  it("la déconnexion invalide la session", async () => {
    const cookies = await signupOwner();
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/logout", cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies })).statusCode).toBe(401);
  });

  it("/auth/me sans session renvoie 401", async () => {
    expect((await app.inject({ method: "GET", url: "/auth/me" })).statusCode).toBe(401);
  });
});

describe("invitation par email", () => {
  it("le propriétaire invite : un email avec un lien est envoyé", async () => {
    const owner = await signupOwner();
    const res = await invite(owner);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: EMPLOYEE.email, role: "EMPLOYEE", status: "PENDING" });
    expect(res.json()).not.toHaveProperty("tokenHash");

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(EMPLOYEE.email);
    expect(mailer.sent[0]!.subject).toContain(OWNER.organizationName);
    expect(mailer.sent[0]!.text).toContain("http://web.test/invitations/accept?token=");

    const list = await app.inject({ method: "GET", url: "/invitations", cookies: owner });
    expect(list.json()).toHaveLength(1);
  });

  it("l'email suit la langue de la personne qui invite (navigateur, puis choix sur le site)", async () => {
    const owner = await signupOwner();
    const send = (headers: Record<string, string>, cookies: Record<string, string> = owner) =>
      app.inject({ method: "POST", url: "/invitations", cookies, headers, payload: { email: EMPLOYEE.email } });

    await send({ "accept-language": "fr-FR,fr;q=0.9" });
    expect(mailer.sent.at(-1)!.subject).toContain("vous invite à rejoindre");
    expect(mailer.sent.at(-1)!.html).toContain('lang="fr"');

    await send({ "accept-language": "en-US,en;q=0.9" });
    expect(mailer.sent.at(-1)!.subject).toContain("invited you to join");

    // Le choix fait sur le site (cookie) prime sur la langue du navigateur.
    await send({ "accept-language": "fr-FR" }, { ...owner, omnilist_lang: "en" });
    expect(mailer.sent.at(-1)!.subject).toContain("invited you to join");
    expect(mailer.sent.at(-1)!.html).toContain('lang="en"');
  });

  it("la page d'acceptation peut afficher l'organisation et l'email", async () => {
    const owner = await signupOwner();
    await invite(owner);
    const res = await app.inject({ method: "POST", url: "/invitations/preview", payload: { token: tokenFromLastEmail(mailer) } });
    expect(res.json()).toEqual({ email: EMPLOYEE.email, organizationName: OWNER.organizationName, role: "EMPLOYEE", userExists: false });
  });

  it("l'employé accepte : son compte est créé avec le rôle employé", async () => {
    const { body } = await inviteAndAccept();
    expect(body.role).toBe("EMPLOYEE");
    expect(body.organization.name).toBe(OWNER.organizationName);
    const invitation = await prisma.invitation.findFirstOrThrow({ where: { email: EMPLOYEE.email } });
    expect(invitation.status).toBe("ACCEPTED");
  });

  it("un lien ne peut servir qu'une fois", async () => {
    const { token } = await inviteAndAccept();
    const again = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token, name: "X", password: "un-autre-mdp" } });
    expect(again.statusCode).toBe(400);
  });

  it("un compte existant accepte avec son mot de passe", async () => {
    const owner = await signupOwner();
    // L'invité possède déjà un compte (sa propre boutique).
    await app.inject({ method: "POST", url: "/auth/signup", payload: { ...EMPLOYEE, organizationName: "Autre boutique" } });
    await invite(owner);
    const token = tokenFromLastEmail(mailer);

    const wrong = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token, password: "mauvais-mdp" } });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token, password: EMPLOYEE.password } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().role).toBe("EMPLOYEE");
  });

  it("un nouveau compte doit donner son nom et un mot de passe solide", async () => {
    const owner = await signupOwner();
    await invite(owner);
    const token = tokenFromLastEmail(mailer);
    const noName = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token, password: "motdepasse-ok" } });
    expect(noName.json().error).toBe("name_required");
    const weak = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token, name: "Jean", password: "court" } });
    expect(weak.json().error).toBe("weak_password");
  });

  it("une invitation révoquée ne peut plus être acceptée", async () => {
    const owner = await signupOwner();
    const created = (await invite(owner)).json();
    const token = tokenFromLastEmail(mailer);
    expect((await app.inject({ method: "DELETE", url: `/invitations/${created.id}`, cookies: owner })).statusCode).toBe(204);
    const res = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token, name: "Jean", password: "motdepasse-ok" } });
    expect(res.statusCode).toBe(400);
  });

  it("une invitation expirée est refusée", async () => {
    const owner = await signupOwner();
    await invite(owner);
    const token = tokenFromLastEmail(mailer);
    await prisma.invitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token, name: "Jean", password: "motdepasse-ok" } });
    expect(res.json().error).toBe("invitation_expired");
  });

  it("réinviter la même personne annule l'ancien lien", async () => {
    const owner = await signupOwner();
    await invite(owner);
    const oldToken = tokenFromLastEmail(mailer);
    await invite(owner);
    const res = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token: oldToken, name: "Jean", password: "motdepasse-ok" } });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/invitations", cookies: owner })).json()).toHaveLength(1);
  });

  it("on ne peut pas inviter quelqu'un qui est déjà membre", async () => {
    const { owner } = await inviteAndAccept();
    expect((await invite(owner)).statusCode).toBe(409);
  });

  it("un propriétaire ne peut pas révoquer l'invitation d'une autre organisation", async () => {
    const owner = await signupOwner();
    const created = (await invite(owner)).json();
    const other = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "autre@exemple.fr", password: "motdepasse-autre", name: "Autre", organizationName: "Autre" },
    });
    const res = await app.inject({ method: "DELETE", url: `/invitations/${created.id}`, cookies: sessionCookie(other) });
    expect(res.statusCode).toBe(404);
  });
});

describe("droits de l'employé", () => {
  it("n'a ni l'abonnement, ni les canaux, ni la gestion des membres", async () => {
    const { body } = await inviteAndAccept();
    expect(body.permissions).not.toContain("billing:manage");
    expect(body.permissions).not.toContain("channels:manage");
    expect(body.permissions).not.toContain("members:invite");
    expect(body.permissions).toEqual(expect.arrayContaining(["products:manage", "stock:manage", "orders:view"]));
  });

  it("ne peut pas inviter ni voir les invitations", async () => {
    const { employee } = await inviteAndAccept();
    expect((await invite(employee, "autre@exemple.fr")).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/invitations", cookies: employee })).statusCode).toBe(403);
  });

  it("sans session, inviter renvoie 401", async () => {
    expect((await invite({})).statusCode).toBe(401);
  });
});
