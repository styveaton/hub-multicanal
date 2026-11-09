import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["local", "staging", "production"]).default("local"),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  // Adresse du front, utilisée pour les liens dans les emails d'invitation.
  WEB_URL: z.string().url().default("http://localhost:3000"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Limite de requêtes par adresse IP. Coupée par défaut dans les tests seulement.
  RATE_LIMIT: z.enum(["on", "off"]).optional(),
  // Relais devant l'API qui ajoutent l'IP du visiteur à X-Forwarded-For. En production :
  // nginx l'ajoute, Next.js (/api) le transmet tel quel → 1. Mettre 0 si l'API est appelée en direct.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("OmniList <no-reply@localhost>"),
  // Stockage des photos, compatible S3 (SeaweedFS en local).
  S3_ENDPOINT: z.string().default("http://localhost:8333"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("omnilist-media"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => EnvSchema.parse(source);
