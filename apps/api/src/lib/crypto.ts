import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Hachage des mots de passe avec scrypt (inclus dans Node, aucune dépendance native).
const SCRYPT_N = 2 ** 15;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, keyLength: number, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format stocké : scrypt$N$sel$hash (sel et hash en base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH, SCRYPT_N);
  return `scrypt$${SCRYPT_N}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, n, salt, hash] = stored.split("$");
  if (algorithm !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await derive(password, Buffer.from(salt, "base64url"), expected.length, Number(n));
  return timingSafeEqual(key, expected);
}

/** Jeton aléatoire envoyé au client (cookie de session, lien d'invitation). */
export const newToken = (): string => randomBytes(32).toString("base64url");

/** Seul le hash du jeton est stocké en base. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
