import { prisma } from "@hub/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { MemoryMailer } from "../lib/mailer.js";
import { SESSION_COOKIE } from "../plugins/auth.js";

export { prisma };

export function createTestApp() {
  const mailer = new MemoryMailer();
  const app = buildApp(loadEnv({ NODE_ENV: "test", WEB_URL: "http://web.test" }), { prisma, mailer });
  return { app, mailer };
}

export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Session", "Invitation", "Membership", "Organization", "User" CASCADE',
  );
}

type InjectResponse = { cookies: Array<{ name: string; value: string }> };

/** Cookie de session posé par une réponse, à renvoyer dans les requêtes suivantes. */
export function sessionCookie(res: InjectResponse): Record<string, string> {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error("aucun cookie de session dans la réponse");
  return { [SESSION_COOKIE]: cookie.value };
}

/** Jeton contenu dans le lien du dernier email d'invitation. */
export function tokenFromLastEmail(mailer: MemoryMailer): string {
  const text = mailer.sent.at(-1)?.text ?? "";
  const url = text.match(/https?:\/\/\S+/)?.[0];
  const token = url ? new URL(url).searchParams.get("token") : null;
  if (!token) throw new Error("aucun lien d'invitation dans l'email");
  return token;
}
