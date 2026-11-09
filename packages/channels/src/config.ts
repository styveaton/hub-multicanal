import { z } from "zod";
import { MediaSigner, TokenCipher } from "./crypto.js";
import { DepopClient } from "./depop/client.js";
import { FAKE_DEPOP_CLIENT_ID, FAKE_DEPOP_CLIENT_SECRET } from "./depop/fake.js";
import { EbayClient } from "./ebay/client.js";
import { FAKE_EBAY_CLIENT_ID, FAKE_EBAY_CLIENT_SECRET } from "./ebay/fake.js";
import { EtsyClient } from "./etsy/client.js";
import { FAKE_ETSY_KEYSTRING, FAKE_ETSY_SECRET } from "./etsy/fake.js";
import { SHOPIFY_API_VERSION, ShopifyClient } from "./shopify/client.js";
import { FAKE_SHOPIFY_CLIENT_ID, FAKE_SHOPIFY_CLIENT_SECRET } from "./shopify/fake.js";
import { WooClient } from "./woocommerce/client.js";
import { assertPublicHost } from "./net.js";

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
  // fake : faux eBay intégré (local) ; sandbox : eBay de test ; production : vrai eBay.
  EBAY_ENV: z.enum(["fake", "sandbox", "production"]).default("fake"),
  EBAY_CLIENT_ID: z.string().optional(),
  EBAY_CLIENT_SECRET: z.string().optional(),
  // « RuName » : nom eBay de l'adresse de retour (portail développeur › User Tokens).
  EBAY_RUNAME: z.string().optional(),
  // Jeton de vérification des avis « suppression de compte » (32 à 80 caractères : lettres, chiffres, _ et -).
  EBAY_VERIFICATION_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,80}$/, "EBAY_VERIFICATION_TOKEN : 32 à 80 caractères (lettres, chiffres, _ et -)")
    .optional()
    .or(z.literal("")),
  // fake : faux Etsy intégré (local) ; live : vraie Open API v3 (application Etsy approuvée).
  ETSY_ENV: z.enum(["fake", "live"]).default("fake"),
  // Clé de l'application (« keystring ») et secret partagé, page « Your Apps » d'Etsy.
  ETSY_KEYSTRING: z.string().optional(),
  ETSY_SHARED_SECRET: z.string().optional(),
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

export interface EbayConfig {
  mode: ChannelEnv["EBAY_ENV"];
  available: boolean;
  clientId: string;
  clientSecret: string;
  ruName: string;
  apiBaseUrl: string;
  apizBaseUrl: string;
  authBaseUrl: string;
  siteUrl: string;
  /** Avis « suppression de compte » : jeton choisi et adresse déclarés dans le portail eBay. */
  verificationToken: string;
  deletionEndpoint: string;
}

export interface EtsyConfig {
  mode: ChannelEnv["ETSY_ENV"];
  available: boolean;
  keystring: string;
  sharedSecret: string;
  apiBaseUrl: string;
  authorizeUrl: string;
  /** Adresse de retour, à déclarer telle quelle dans l'application Etsy. */
  redirectUri: string;
}

const EBAY_HOSTS = {
  sandbox: { api: "https://api.sandbox.ebay.com", apiz: "https://apiz.sandbox.ebay.com", auth: "https://auth.sandbox.ebay.com", site: "https://sandbox.ebay.com" },
  production: { api: "https://api.ebay.com", apiz: "https://apiz.ebay.com", auth: "https://auth.ebay.com", site: "https://www.ebay.com" },
} as const;

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
  ebay: EbayConfig;
  etsy: EtsyConfig;
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
  if (!local && env.EBAY_ENV === "fake") throw new Error("EBAY_ENV=fake n'est autorisé qu'en local");
  if (!local && env.ETSY_ENV === "fake") throw new Error("ETSY_ENV=fake n'est autorisé qu'en local");
  // eBay coupe les clés d'une application qui ne répond pas aux avis « suppression de compte ».
  if (!local && !blank(env.EBAY_CLIENT_ID) && blank(env.EBAY_VERIFICATION_TOKEN)) {
    throw new Error("EBAY_VERIFICATION_TOKEN est obligatoire hors local quand eBay est configuré");
  }

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

  const fakeEbay = env.EBAY_ENV === "fake";
  const ebayHosts = fakeEbay
    ? { api: `${api}/dev/fake-ebay`, apiz: `${api}/dev/fake-ebay`, auth: `${web}/api/dev/fake-ebay`, site: `${web}/api/dev/fake-ebay` }
    : EBAY_HOSTS[env.EBAY_ENV as "sandbox" | "production"];
  const ebay: EbayConfig = {
    mode: env.EBAY_ENV,
    available: fakeEbay || (!blank(env.EBAY_CLIENT_ID) && !blank(env.EBAY_CLIENT_SECRET) && !blank(env.EBAY_RUNAME)),
    clientId: fakeEbay ? FAKE_EBAY_CLIENT_ID : (env.EBAY_CLIENT_ID ?? ""),
    clientSecret: fakeEbay ? FAKE_EBAY_CLIENT_SECRET : (env.EBAY_CLIENT_SECRET ?? ""),
    // Le faux eBay renvoie directement vers OmniList ; le vrai passe par le RuName.
    ruName: fakeEbay ? `${web}/api/channels/ebay/callback` : (env.EBAY_RUNAME ?? ""),
    apiBaseUrl: ebayHosts.api,
    apizBaseUrl: ebayHosts.apiz,
    authBaseUrl: ebayHosts.auth,
    siteUrl: ebayHosts.site,
    verificationToken: env.EBAY_VERIFICATION_TOKEN || "omnilist-local-ebay-verification-token",
    deletionEndpoint: `${publicApi.replace(/\/$/, "")}/webhooks/ebay/account-deletion`,
  };

  const fakeEtsy = env.ETSY_ENV === "fake";
  const etsy: EtsyConfig = {
    mode: env.ETSY_ENV,
    available: fakeEtsy || (!blank(env.ETSY_KEYSTRING) && !blank(env.ETSY_SHARED_SECRET)),
    keystring: fakeEtsy ? FAKE_ETSY_KEYSTRING : (env.ETSY_KEYSTRING ?? ""),
    sharedSecret: fakeEtsy ? FAKE_ETSY_SECRET : (env.ETSY_SHARED_SECRET ?? ""),
    apiBaseUrl: fakeEtsy ? `${api}/dev/fake-etsy` : "https://api.etsy.com",
    authorizeUrl: fakeEtsy ? `${web}/api/dev/fake-etsy/oauth/connect` : "https://www.etsy.com/oauth/connect",
    redirectUri: `${web}/api/channels/etsy/callback`,
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
    ebay,
    etsy,
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

// Vraies boutiques : l'adresse saisie par le marchand doit mener à une IP publique (pas au réseau du serveur).
export const createWooClient = (config: WooConfig, fetchImpl?: typeof fetch) =>
  new WooClient({ baseUrlFor: config.baseUrlFor, fetch: fetchImpl, checkHost: config.mode === "live" ? (host) => assertPublicHost(host) : undefined });

export const createEbayClient = (config: EbayConfig, fetchImpl?: typeof fetch) =>
  new EbayClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ruName: config.ruName,
    apiBaseUrl: config.apiBaseUrl,
    apizBaseUrl: config.apizBaseUrl,
    authBaseUrl: config.authBaseUrl,
    siteUrl: config.siteUrl,
    fetch: fetchImpl,
  });

export const createEtsyClient = (config: EtsyConfig, fetchImpl?: typeof fetch) =>
  new EtsyClient({
    keystring: config.keystring,
    sharedSecret: config.sharedSecret,
    apiBaseUrl: config.apiBaseUrl,
    authorizeUrl: config.authorizeUrl,
    fetch: fetchImpl,
  });
