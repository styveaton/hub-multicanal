import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { buildMe } from "../lib/me.js";
import { SESSION_COOKIE, requireAuth, startSession } from "../plugins/auth.js";

export const Email = z.string().trim().toLowerCase().email().max(254);
export const NewPassword = z.string().min(8, "8 caractères minimum").max(200);
export const PersonName = z.string().trim().min(1).max(100);

const Signup = z.object({
  email: Email,
  password: NewPassword,
  name: PersonName,
  organizationName: z.string().trim().min(1).max(100),
});

const Login = z.object({ email: Email, password: z.string().min(1).max(200) });

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

    const membership = await app.prisma.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    if (!membership) return reply.code(403).send({ error: "no_organization" });

    await startSession(app, reply, user.id, membership.organizationId);
    return buildMe(app, user.id, membership.organizationId);
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
