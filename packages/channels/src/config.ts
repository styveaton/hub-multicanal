import { z } from "zod";
import { MediaSigner, TokenCipher } from "./crypto.js";
import { DepopClient } from "./depop/client.js";
import { FAKE_DEPOP_CLIENT_ID, FAKE_DEPOP_CLIENT_SECRET } from "./depop/fake.js";
import { SHOPIFY_API_VERSION, ShopifyClient } from "./shopify/client.js";
import { FAKE_SHOPIFY_CLIENT_ID, FAKE_SHOPIFY_CLIENT_SECRET } from "./shopify/fake.js";
import { WooClient } from "./woocommerce/client.js";

/** Variables d'environnement des canaux, lues par l'API et par le worker. */
const ChannelEnvSchema = z.object({
  APP_ENV: z.enum(["local", "staging", "production"]).default("local"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  // Adresse publique de l'API vue d'internet (les canaux y téléchargent les photos).
  PUBLIC_API_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  MEDIA_URL_SECRET: z.string().optional(),
  // fake : faux Depop intégré (local) ; staging / production : vraie Selling API.
  DEPOP_ENV: z.enum(["fake", "staging", "production"]).default("fake"),
  DEPOP_CLIENT_ID: z.string().optional(),
  DEPOP_CLIENT_SECRET: z.string().optional(),
  // fake : faux Shopify intégré (local) ; live : vraie Admin API (application Shopify Partner).
  SHOPIFY_ENV: z.enum(["fake", "live"]).default("fake"),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  // fake : faux WooCommerce intégré (local) ; live : la boutique WordPress du marchand.
  WOO_ENV: z.enum(["fake", "live"]).default("fake"),
  // Relevé de secours des commandes (les webhooks peuvent se perdre).
  ORDER_POLL_SECONDS: z.coerce.number().int().min(15).optional(),
});

export type ChannelEnv = z.infer<typeof ChannelEnvSchema>;

const DEPOP_API = {
  staging: "https://partnerapi-staging.depop.com",
  production: "https://partnerapi.depop.com",
} as const;
const DEPOP_AUTHORIZE_URL = "https://www.depop.com/settings/oauth/apps/";

export interface DepopConfig {
  mode: ChannelEnv["DEPOP_ENV"];
  /** Clés présentes : la connexion peut être proposée. */
  available: boolean;
  apiBaseUrl: string;
  authorizeUrl: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}

export interface ShopifyConfig {
  mode: ChannelEnv["SHOPIFY_ENV"];
  available: boolean;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  redirectUri: string;
  /** Adresse de l'API d'une boutique. */
  baseUrlFor: (shop: string) => string;
  /** Adresse de la page d'installation (vue par le navigateur du marchand). */
  authorizeBaseFor: (shop: string) => string;
}

export interface WooConfig {
  mode: ChannelEnv["WOO_ENV"];
  available: boolean;
  /** Adresse réelle de l'API (en mode fake, toujours le faux WooCommerce de l'API). */
  baseUrlFor: (storeUrl: string) => string;
}

export interface ChannelConfig {
  env: ChannelEnv;
  /** Adresse publique de l'API (photos signées, webhooks des canaux). */
  publicApiUrl: string;
  /** Webhooks possibles : adresse publique en HTTPS (pas en local). */
  webhooksEnabled: boolean;
  /** Intervalle du relevé de secours des commandes, en secondes. */
  orderPollSeconds: number;
  cipher: TokenCipher;
  media: MediaSigner;
  depop: DepopConfig;
  shopify: ShopifyConfig;
  woo: WooConfig;
}

const blank = (v?: string) => !v || v.trim() === "";

export function loadChannelConfig(source: NodeJS.ProcessEnv = process.env): ChannelConfig {
  const env = ChannelEnvSchema.parse(source);
  const local = env.APP_ENV === "local";

  // Hors local, les secrets doivent être fournis explicitement.
  if (!local && (blank(env.TOKEN_ENCRYPTION_KEY) || blank(env.MEDIA_URL_SECRET))) {
    throw new Error("TOKEN_ENCRYPTION_KEY et MEDIA_URL_SECRET sont obligatoires hors environnement local");
  }
  if (!local && env.DEPOP_ENV === "fake") throw new Error("DEPOP_ENV=fake n'est autorisé qu'en local");
  if (!local && env.SHOPIFY_ENV === "fake") throw new Error("SHOPIFY_ENV=fake n'est autorisé qu'en local");
  if (!local && env.WOO_ENV === "fake") throw new Error("WOO_ENV=fake n'est autorisé qu'en local");

  const devSecret = env.SESSION_SECRET || "omnilist-local-dev";
  const cipher = blank(env.TOKEN_ENCRYPTION_KEY) ? TokenCipher.fromSecret(devSecret) : TokenCipher.fromBase64(env.TOKEN_ENCRYPTION_KEY!);
  const publicApi = env.PUBLIC_API_URL ?? `${env.WEB_URL.replace(/\/$/, "")}/api`;
  const media = new MediaSigner(env.MEDIA_URL_SECRET || `media:${devSecret}`, publicApi);

  const web = env.WEB_URL.replace(/\/$/, "");
  const fake = env.DEPOP_ENV === "fake";
  const depop: DepopConfig = {
    mode: env.DEPOP_ENV,
    available: fake || (!blank(env.DEPOP_CLIENT_ID) && !blank(env.DEPOP_CLIENT_SECRET)),
    // Le faux Depop est servi par l'API elle-même (routes /dev/fake-depop).
    apiBaseUrl: env.DEPOP_ENV === "fake" ? `${env.API_URL.replace(/\/$/, "")}/dev/fake-depop` : DEPOP_API[env.DEPOP_ENV],
    authorizeUrl: fake ? `${web}/api/dev/fake-depop/authorize` : DEPOP_AUTHORIZE_URL,
    // Retour via le front (proxy /api) pour que le cookie de session accompagne la requête.
    redirectUri: `${web}/api/channels/depop/callback`,
    clientId: fake ? FAKE_DEPOP_CLIENT_ID : (env.DEPOP_CLIENT_ID ?? ""),
    clientSecret: fake ? FAKE_DEPOP_CLIENT_SECRET : (env.DEPOP_CLIENT_SECRET ?? ""),
  };

  const api = env.API_URL.replace(/\/$/, "");
  const fakeShopify = env.SHOPIFY_ENV === "fake";
  const shopify: ShopifyConfig = {
    mode: env.SHOPIFY_ENV,
    available: fakeShopify || (!blank(env.SHOPIFY_CLIENT_ID) && !blank(env.SHOPIFY_CLIENT_SECRET)),
    clientId: fakeShopify ? FAKE_SHOPIFY_CLIENT_ID : (env.SHOPIFY_CLIENT_ID ?? ""),
    clientSecret: fakeShopify ? FAKE_SHOPIFY_CLIENT_SECRET : (env.SHOPIFY_CLIENT_SECRET ?? ""),
    apiVersion: env.SHOPIFY_API_VERSION ?? SHOPIFY_API_VERSION,
    redirectUri: `${web}/api/channels/shopify/callback`,
    // Le faux Shopify est servi par l'API (routes /dev/fake-shopify/<boutique>).
    baseUrlFor: (shop) => (fakeShopify ? `${api}/dev/fake-shopify/${shop}` : `https://${shop}`),
    authorizeBaseFor: (shop) => (fakeShopify ? `${web}/api/dev/fake-shopify/${shop}` : `https://${shop}`),
  };
  const woo: WooConfig = {
    mode: env.WOO_ENV,
    available: true,
    baseUrlFor: (storeUrl) => (env.WOO_ENV === "fake" ? `${api}/dev/fake-woo` : storeUrl),
  };

  return {
    env,
    publicApiUrl: publicApi,
    webhooksEnabled: publicApi.startsWith("https://") && !fake,
    // Faux Depop en local : relevé rapproché pour voir les ventes arriver vite.
    orderPollSeconds: env.ORDER_POLL_SECONDS ?? (fake ? 30 : 120),
    cipher,
    media,
    depop,
    shopify,
    woo,
  };
}

export const createDepopClient = (config: DepopConfig, fetchImpl?: typeof fetch) =>
  new DepopClient({ baseUrl: config.apiBaseUrl, clientId: config.clientId, clientSecret: config.clientSecret, fetch: fetchImpl });

export const createShopifyClient = (config: ShopifyConfig, fetchImpl?: typeof fetch) =>
  new ShopifyClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    apiVersion: config.apiVersion,
    baseUrlFor: config.baseUrlFor,
    authorizeBaseFor: config.authorizeBaseFor,
    fetch: fetchImpl,
  });

export const createWooClient = (config: WooConfig, fetchImpl?: typeof fetch) => new WooClient({ baseUrlFor: config.baseUrlFor, fetch: fetchImpl });
