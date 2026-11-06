import { randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { hashPassword, hashToken, verifyPassword } from "../lib/crypto.js";
import { requestLocale } from "../lib/locale.js";
import { passwordResetEmail } from "../lib/mailer.js";
import { buildMe } from "../lib/me.js";
import { SESSION_COOKIE, requireAuth, startSession } from "../plugins/auth.js";

export const Email = z.string().trim().toLowerCase().email().max(254);
export const NewPassword = z.string().min(8, "password_too_short").max(200);
export const PersonName = z.string().trim().min(1).max(100);

const Signup = z.object({
  email: Email,
  password: NewPassword,
  name: PersonName,
  organizationName: z.string().trim().min(1).max(100),
});

const Login = z.object({ email: Email, password: z.string().min(1).max(200) });

const ForgotPassword = z.object({ email: Email });
const ResetPassword = z.object({ email: Email, code: z.string().trim().max(20), password: NewPassword });

// Code de changement de mot de passe : 6 chiffres, valable 2 minutes, 5 essais.
export const RESET_CODE_TTL_SECONDS = 120;
export const RESET_RESEND_SECONDS = 30;
export const RESET_MAX_ATTEMPTS = 5;
const RESET_MAX_PER_HOUR = 6;

const resetCodeHash = (userId: string, code: string) => hashToken(`${userId}:${code}`);

/** Ouvre une session dans la première boutique de l'utilisateur. */
async function loginInto(app: FastifyInstance, reply: FastifyReply, userId: string) {
  const membership = await app.prisma.membership.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
  if (!membership) return reply.code(403).send({ error: "no_organization" });
  await startSession(app, reply, userId, membership.organizationId);
  return buildMe(app, userId, membership.organizationId);
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Inscription d'un propriétaire : crée l'utilisateur, son organisation et le rôle OWNER.
  app.post("/signup", async (request, reply) => {
    const body = Signup.parse(request.body);
    if (await app.prisma.user.findUnique({ where: { email: body.email } })) {
      return reply.code(409).send({ error: "email_taken" });
    }
    const passwordHash = await hashPassword(body.password);
    const { user, organization } = await app.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: body.email, name: body.name, passwordHash } });
      const organization = await tx.organization.create({
        data: { name: body.organizationName, memberships: { create: { userId: user.id, role: "OWNER" } } },
      });
      return { user, organization };
    });
    await startSession(app, reply, user.id, organization.id);
    return reply.code(201).send(await buildMe(app, user.id, organization.id));
  });

  app.post("/login", async (request, reply) => {
    const body = Login.parse(request.body);
    const user = await app.prisma.user.findUnique({ where: { email: body.email } });
    // Même temps de réponse que l'email existe ou non.
    const valid = user?.passwordHash
      ? await verifyPassword(body.password, user.passwordHash)
      : (await hashPassword(body.password), false);
    if (!user || !valid) return reply.code(401).send({ error: "invalid_credentials" });
    return loginInto(app, reply, user.id);
  });

  // Mot de passe oublié, étape 1 : envoie un code par email.
  // Même réponse que le compte existe ou non. Un seul code toutes les 30 s, 6 par heure.
  app.post("/password/forgot", async (request) => {
    const { email } = ForgotPassword.parse(request.body);
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (user) {
      const now = Date.now();
      const recent = await app.prisma.passwordReset.findMany({
        where: { userId: user.id, createdAt: { gte: new Date(now - 3_600_000) } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const tooSoon = recent[0] && now - recent[0].createdAt.getTime() < RESET_RESEND_SECONDS * 1000;
      if (!tooSoon && recent.length < RESET_MAX_PER_HOUR) {
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        await app.prisma.passwordReset.create({
          data: { userId: user.id, codeHash: resetCodeHash(user.id, code), expiresAt: new Date(now + RESET_CODE_TTL_SECONDS * 1000) },
        });
        await app.mailer.send(
          passwordResetEmail({ to: user.email, code, minutes: RESET_CODE_TTL_SECONDS / 60, locale: requestLocale(request) }),
        );
      }
    }
    return { expiresInSeconds: RESET_CODE_TTL_SECONDS, resendInSeconds: RESET_RESEND_SECONDS };
  });

  // Mot de passe oublié, étape 2 : vérifie le code (seul le dernier envoyé compte), change le mot de passe,
  // ferme toutes les sessions ouvertes et connecte la personne.
  app.post("/password/reset", async (request, reply) => {
    const body = ResetPassword.parse(request.body);
    const user = await app.prisma.user.findUnique({ where: { email: body.email } });
    const reset = user
      ? await app.prisma.passwordReset.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } })
      : null;
    if (!user || !reset || reset.usedAt) return reply.code(400).send({ error: "invalid_code" });
    if (reset.expiresAt.getTime() <= Date.now()) return reply.code(400).send({ error: "code_expired" });
    if (reset.attempts >= RESET_MAX_ATTEMPTS) return reply.code(400).send({ error: "too_many_attempts" });

    const expected = Buffer.from(reset.codeHash, "hex");
    const given = Buffer.from(resetCodeHash(user.id, body.code.replace(/\s/g, "")), "hex");
    if (!timingSafeEqual(expected, given)) {
      const { attempts } = await app.prisma.passwordReset.update({
        where: { id: reset.id },
        data: { attempts: { increment: 1 } },
      });
      const remaining = Math.max(RESET_MAX_ATTEMPTS - attempts, 0);
      return reply.code(400).send(remaining > 0 ? { error: "invalid_code", remaining } : { error: "too_many_attempts" });
    }

    const passwordHash = await hashPassword(body.password);
    const used = await app.prisma.$transaction(async (tx) => {
      const { count } = await tx.passwordReset.updateMany({ where: { id: reset.id, usedAt: null }, data: { usedAt: new Date() } });
      if (count === 0) return false;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      return true;
    });
    if (!used) return reply.code(400).send({ error: "invalid_code" });
    return loginInto(app, reply, user.id);
  });

  app.post("/logout", { preHandler: requireAuth }, async (request, reply) => {
    await app.prisma.session.deleteMany({ where: { id: request.auth!.sessionId } });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: requireAuth }, async (request) => {
    return buildMe(app, request.auth!.userId, request.auth!.organizationId);
  });
};
