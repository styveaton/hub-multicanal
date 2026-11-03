import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Chiffrement des jetons OAuth des canaux (AES-256-GCM).
 * Format stocké : v1.<iv>.<tag>.<données>, en base64url.
 */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("La clé de chiffrement des jetons doit faire 32 octets");
    this.key = key;
  }

  /** Clé fournie en base64 (TOKEN_ENCRYPTION_KEY). */
  static fromBase64(value: string) {
    return new TokenCipher(Buffer.from(value, "base64"));
  }

  /** Clé dérivée d'un secret, pour le développement local uniquement. */
  static fromSecret(secret: string) {
    return new TokenCipher(createHash("sha256").update(`omnilist-tokens:${secret}`).digest());
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  }

  decrypt(stored: string): string {
    const [version, iv, tag, data] = stored.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Jeton chiffré illisible");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }
}

/** Jeton aléatoire (state OAuth, vérificateur PKCE). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** Défi PKCE S256 : base64url(sha256(verifier)). */
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/**
 * Liens publics et temporaires vers les photos : les canaux (Depop) téléchargent les images
 * eux-mêmes, sans session. Signature HMAC de « id.expiration ».
 */
export class MediaSigner {
  constructor(
    private readonly secret: string,
    private readonly publicBaseUrl: string,
  ) {}

  private sign(photoId: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${photoId}.${exp}`).digest("base64url");
  }

  /** URL publique de la photo, valable `ttlSeconds` (30 jours par défaut). */
  url(photoId: string, ttlSeconds = 30 * 24 * 3600, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + ttlSeconds;
    return `${this.publicBaseUrl.replace(/\/$/, "")}/public/photos/${photoId}?exp=${exp}&sig=${this.sign(photoId, exp)}`;
  }

  verify(photoId: string, exp: string | undefined, sig: string | undefined, now = Date.now()): boolean {
    const expNum = Number(exp);
    if (!sig || !Number.isInteger(expNum) || expNum * 1000 < now) return false;
    const expected = Buffer.from(this.sign(photoId, expNum));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
