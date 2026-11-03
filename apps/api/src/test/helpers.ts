import { prisma } from "@hub/db";
import { FakeDepop, createDepopClient, loadChannelConfig, type ChannelDeps } from "@hub/channels";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { MemoryMailer } from "../lib/mailer.js";
import { MemoryJobQueue } from "../lib/queue.js";
import { MemoryStorage } from "../lib/storage.js";
import { SESSION_COOKIE } from "../plugins/auth.js";

export { prisma };

export const TEST_WEB_URL = "http://web.test";
export const TEST_PUBLIC_API_URL = "https://api.test";

export function createTestApp() {
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage();
  const queue = new MemoryJobQueue();
  const fakeDepop = new FakeDepop();
  const config = loadChannelConfig({
    APP_ENV: "local",
    NODE_ENV: "test",
    WEB_URL: TEST_WEB_URL,
    PUBLIC_API_URL: TEST_PUBLIC_API_URL,
    DEPOP_ENV: "fake",
  });
  // Les tests vérifient aussi l'enregistrement et la réception des webhooks.
  config.webhooksEnabled = true;
  const depop = createDepopClient(config.depop, fakeDepop.fetch);
  const app = buildApp(loadEnv({ NODE_ENV: "test", WEB_URL: TEST_WEB_URL }), {
    prisma,
    mailer,
    storage,
    channels: { config, depop, queue, fakeDepop },
  });
  // Ce que reçoit le worker : les tests exécutent les jobs avec queue.drain(channelDeps).
  const channelDeps: ChannelDeps = { prisma, cipher: config.cipher, media: config.media, depop };
  return { app, mailer, storage, queue, fakeDepop, config, channelDeps };
}

export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "SyncLog", "OrderLine", "Order", "ChannelListing", "ChannelConnection", "OAuthState", "ProductChannel", "Sku", "ProductVariant", "ProductPhoto", "Product",
      "Session", "Invitation", "Membership", "Organization", "User" CASCADE`,
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

/** Petites images valides (en-têtes réels) pour les tests d'envoi. */
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);

/** Corps multipart/form-data contenant un fichier « file ». */
export function multipartFile(content: Buffer, filename = "photo.jpg", contentType = "image/jpeg") {
  const boundary = "----omnilist-test-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
