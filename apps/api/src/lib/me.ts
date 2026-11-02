import type { FastifyInstance } from "fastify";
import { PERMISSIONS, can } from "@hub/shared";

/** Profil renvoyé au front : utilisateur, organisation active, rôle et permissions. */
export async function buildMe(app: FastifyInstance, userId: string, organizationId: string) {
  const membership = await app.prisma.membership.findUniqueOrThrow({
    where: { userId_organizationId: { userId, organizationId } },
    include: { user: true, organization: true },
  });
  return {
    user: { id: membership.user.id, email: membership.user.email, name: membership.user.name },
    organization: { id: membership.organization.id, name: membership.organization.name },
    role: membership.role,
    permissions: PERMISSIONS.filter((p) => can(membership.role, p)),
  };
}
