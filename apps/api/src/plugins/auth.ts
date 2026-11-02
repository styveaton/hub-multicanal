import type { FastifyReply, FastifyRequest } from "fastify";
import { can, type Permission, type Role } from "@hub/shared";

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Garde de permission pour les routes. `request.auth` sera rempli par le
 * plugin de session (tâche « DEV – Auth, rôles, comptes »).
 */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) return reply.code(401).send({ error: "unauthenticated" });
    if (!can(request.auth.role, permission)) return reply.code(403).send({ error: "forbidden" });
  };
}
