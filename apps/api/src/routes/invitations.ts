import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Invitation } from "@hub/db";
import { hashPassword, hashToken, newToken, verifyPassword } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { requestLocale } from "../lib/locale.js";
import { invitationEmail } from "../lib/mailer.js";
import { buildMe } from "../lib/me.js";
import { requirePermission, startSession } from "../plugins/auth.js";
import { Email, NewPassword, PersonName } from "./auth.js";

const CreateInvitation = z.object({ email: Email });
const TokenBody = z.object({ token: z.string().min(1).max(200) });
const AcceptInvitation = TokenBody.extend({
  name: PersonName.optional(),
  password: z.string().min(1).max(200),
});

const serialize = (inv: Invitation) => ({
  id: inv.id,
  email: inv.email,
  role: inv.role,
  status: inv.status,
  expiresAt: inv.expiresAt,
  createdAt: inv.createdAt,
});


export const invitationRoutes: FastifyPluginAsync = async (app) => {
  /** Retrouve une invitation encore utilisable à partir du jeton du lien. */
  async function findUsableInvitation(token: string) {
    const invitation = await app.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { organization: true },
    });
    if (!invitation || invitation.status !== "PENDING") throw new HttpError(400, "invalid_invitation");
    if (invitation.expiresAt <= new Date()) {
      await app.prisma.invitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
      throw new HttpError(400, "invitation_expired");
    }
    return invitation;
  }

  // Le propriétaire invite un employé par email. Une nouvelle invitation remplace la précédente.
  app.post("/", { preHandler: requirePermission("members:invite") }, async (request, reply) => {
    const { email } = CreateInvitation.parse(request.body);
    const { organizationId, userId } = request.auth!;

    const alreadyMember = await app.prisma.membership.findFirst({ where: { organizationId, user: { email } } });
    if (alreadyMember) return reply.code(409).send({ error: "already_member" });

    const token = newToken();
    const expiresAt = new Date(Date.now() + app.env.INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [, invitation] = await app.prisma.$transaction([
      app.prisma.invitation.updateMany({
        where: { organizationId, email, status: "PENDING" },
        data: { status: "REVOKED" },
      }),
      app.prisma.invitation.create({
        data: { email, role: "EMPLOYEE", tokenHash: hashToken(token), expiresAt, organizationId, invitedById: userId },
        include: { organization: true, invitedBy: true },
      }),
    ]);

    const link = new URL("/invitations/accept", app.env.WEB_URL);
    link.searchParams.set("token", token);
    try {
      await app.mailer.send(
        invitationEmail({
          to: email,
          organizationName: invitation.organization.name,
          inviterName: invitation.invitedBy.name ?? invitation.invitedBy.email,
          link: link.toString(),
          expiresAt,
          locale: requestLocale(request),
        }),
      );
    } catch (err) {
      // Email non parti : l'invitation ne doit pas rester active sans que la personne le sache.
      await app.prisma.invitation.update({ where: { id: invitation.id }, data: { status: "REVOKED" } });
      request.log.error(err, "envoi de l'email d'invitation impossible");
      return reply.code(502).send({ error: "email_failed" });
    }

    return reply.code(201).send(serialize(invitation));
  });

  // Invitations en attente de l'organisation.
  app.get("/", { preHandler: requirePermission("members:invite") }, async (request) => {
    const invitations = await app.prisma.invitation.findMany({
      where: { organizationId: request.auth!.organizationId, status: "PENDING", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    return invitations.map(serialize);
  });

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requirePermission("members:invite") },
    async (request, reply) => {
      const { count } = await app.prisma.invitation.updateMany({
        where: { id: request.params.id, organizationId: request.auth!.organizationId, status: "PENDING" },
        data: { status: "REVOKED" },
      });
      if (count === 0) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  // Public : infos affichées sur la page d'acceptation (le lien contient le jeton).
  app.post("/preview", async (request) => {
    const { token } = TokenBody.parse(request.body);
    const invitation = await findUsableInvitation(token);
    const existingUser = await app.prisma.user.findUnique({ where: { email: invitation.email } });
    return {
      email: invitation.email,
      organizationName: invitation.organization.name,
      role: invitation.role,
      userExists: Boolean(existingUser),
    };
  });

  // Public : l'invité accepte. Nouveau compte (nom + mot de passe) ou compte existant (mot de passe).
  app.post("/accept", async (request, reply) => {
    const body = AcceptInvitation.parse(request.body);
    const invitation = await findUsableInvitation(body.token);
    const existingUser = await app.prisma.user.findUnique({ where: { email: invitation.email } });

    let newUser: { name: string; passwordHash: string } | undefined;
    if (existingUser) {
      const valid = existingUser.passwordHash && (await verifyPassword(body.password, existingUser.passwordHash));
      if (!valid) return reply.code(401).send({ error: "invalid_credentials" });
    } else {
      const name = body.name;
      if (!name) return reply.code(400).send({ error: "name_required" });
      const password = NewPassword.safeParse(body.password);
      if (!password.success) return reply.code(400).send({ error: "weak_password" });
      newUser = { name, passwordHash: await hashPassword(password.data) };
    }

    const userId = await app.prisma.$transaction(async (tx) => {
      // Verrouille l'invitation : un même lien ne peut être accepté qu'une fois.
      const { count } = await tx.invitation.updateMany({
        where: { id: invitation.id, status: "PENDING" },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
      if (count === 0) throw new HttpError(400, "invalid_invitation");

      const user = existingUser ?? (await tx.user.create({ data: { email: invitation.email, ...newUser! } }));
      const member = await tx.membership.findUnique({
        where: { userId_organizationId: { userId: user.id, organizationId: invitation.organizationId } },
      });
      if (member) throw new HttpError(409, "already_member");
      await tx.membership.create({
        data: { userId: user.id, organizationId: invitation.organizationId, role: invitation.role },
      });
      return user.id;
    });

    await startSession(app, reply, userId, invitation.organizationId);
    return buildMe(app, userId, invitation.organizationId);
  });
};
