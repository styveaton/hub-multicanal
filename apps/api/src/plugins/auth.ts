import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { can, type Permission, type Role } from "@hub/shared";
import { hashToken, newToken } from "../lib/crypto.js";

export const SESSION_COOKIE = "hub_session";

export interface AuthContext {
  sessionId?: string;
  userId: string;
  organizationId: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Lit le cookie de session et remplit `request.auth` si la session est valide. */
export function registerSessionAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await app.prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!session || session.expiresAt <= new Date()) return;
    const membership = await app.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: session.userId, organizationId: session.organizationId } },
    });
    if (!membership) return;
    request.auth = {
      sessionId: session.id,
      userId: session.userId,
      organizationId: session.organizationId,
      role: membership.role,
    };
  });
}

/** Ouvre une session et pose le cookie (httpOnly, SameSite=Lax, Secure en production). */
export async function startSession(app: FastifyInstance, reply: FastifyReply, userId: string, organizationId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + app.env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await app.prisma.session.create({ data: { tokenHash: hashToken(token), userId, organizationId, expiresAt } });
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: app.env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth) return reply.code(401).send({ error: "unauthenticated" });
}

/** Garde de permission : 401 sans session, 403 si le rôle n'a pas la permission. */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) return reply.code(401).send({ error: "unauthenticated" });
    if (!can(request.auth.role, permission)) return reply.code(403).send({ error: "forbidden" });
  };
}
