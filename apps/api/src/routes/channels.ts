import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CHANNELS, CHANNEL_INTEGRATION, CHANNEL_LABEL, can, isUsState, type Channel } from "@hub/shared";
import { DEPOP_SCOPES, PUBLISHABLE_CHANNELS, pkceChallenge, randomToken, sha256Hex } from "@hub/channels";
import { HttpError } from "../lib/errors.js";
import { requireAuth, requirePermission } from "../plugins/auth.js";

/** Canaux déjà branchés de bout en bout. Les autres suivront (eBay au Sprint 3). */
export const SUPPORTED_CHANNELS: ReadonlySet<Channel> = new Set(PUBLISHABLE_CHANNELS);

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const ChannelParam = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(CHANNELS));

const DepopSettingsInput = z.object({
  shipFromState: z.string().refine(isUsState, "us_state_invalid"),
});

function supported(channel: Channel) {
  if (!SUPPORTED_CHANNELS.has(channel)) throw new HttpError(400, "channel_not_supported");
}

export const channelRoutes: FastifyPluginAsync = async (app) => {
  const canManage = { preHandler: requirePermission("channels:manage") };
  const web = app.channels.config.env.WEB_URL.replace(/\/$/, "");
  const depopConfig = app.channels.config.depop;

  // Liste des canaux et état de leur connexion pour la boutique.
  app.get("/", { preHandler: requireAuth }, async (request) => {
    const { organizationId } = request.auth!;
    const [connections, listed] = await Promise.all([
      app.prisma.channelConnection.findMany({ where: { organizationId } }),
      app.prisma.channelListing.groupBy({ by: ["channel"], where: { organizationId, status: "LISTED" }, _count: true }),
    ]);
    return {
      canManage: can(request.auth!.role, "channels:manage"),
      items: CHANNELS.map((channel) => {
        const c = connections.find((x) => x.channel === channel);
        return {
          channel,
          label: CHANNEL_LABEL[channel],
          integration: CHANNEL_INTEGRATION[channel],
          supported: SUPPORTED_CHANNELS.has(channel),
          // Clés présentes (ou faux Depop en local) : on peut proposer la connexion.
          available: channel === "DEPOP" ? depopConfig.available : false,
          testMode: channel === "DEPOP" ? depopConfig.mode !== "production" : false,
          listedCount: listed.find((l) => l.channel === channel)?._count ?? 0,
          connection: c
            ? {
                status: c.status,
                username: c.externalUsername,
                connectedAt: c.createdAt,
                settings: c.settings as { shipFromState?: string },
              }
            : null,
        };
      }),
    };
  });

  // Début de la connexion OAuth : on renvoie l'adresse de la page d'accord du canal.
  app.post<{ Params: { channel: string } }>("/:channel/connect", canManage, async (request) => {
    const channel = ChannelParam.parse(request.params.channel);
    supported(channel);
    if (!depopConfig.available) throw new HttpError(503, "channel_unavailable");
    const { organizationId, userId } = request.auth!;

    const state = randomToken();
    const verifier = randomToken(48); // 64 caractères, dans les bornes PKCE (43 à 128)
    await app.prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await app.prisma.oAuthState.create({
      data: {
        stateHash: sha256Hex(state),
        organizationId,
        userId,
        channel,
        codeVerifierEnc: app.channels.config.cipher.encrypt(verifier),
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });

    const url = new URL(depopConfig.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", depopConfig.clientId);
    url.searchParams.set("redirect_uri", depopConfig.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    // Depop sépare les scopes par « + » (encodé %2B).
    return { url: `${url.toString()}&scope=${DEPOP_SCOPES.join("%2B")}` };
  });

  // Retour du canal après l'accord (ou le refus) du vendeur.
  app.get<{ Params: { channel: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/:channel/callback",
    async (request, reply) => {
      const back = (params: Record<string, string>) => reply.redirect(`${web}/channels?${new URLSearchParams(params)}`);
      const channel = ChannelParam.safeParse(request.params.channel);
      if (!channel.success || !SUPPORTED_CHANNELS.has(channel.data)) return back({ error: "channel_not_supported" });
      const key = channel.data.toLowerCase();
      if (!request.auth) return reply.redirect(`${web}/login`);
      if (!can(request.auth.role, "channels:manage")) return back({ error: "forbidden", channel: key });

      const { code, state, error } = request.query;
      const saved = state ? await app.prisma.oAuthState.findUnique({ where: { stateHash: sha256Hex(state) } }) : null;
      if (saved) await app.prisma.oAuthState.delete({ where: { id: saved.id } });
      const valid =
        saved &&
        saved.channel === channel.data &&
        saved.organizationId === request.auth.organizationId &&
        saved.userId === request.auth.userId &&
        saved.expiresAt > new Date();
      if (!valid) return back({ error: "invalid_state", channel: key });
      if (error || !code) return back({ error: error === "access_denied" ? "access_denied" : "connect_failed", channel: key });

      try {
        const { cipher } = app.channels.config;
        const tokens = await app.channels.depop.exchangeCode(code, depopConfig.redirectUri, cipher.decrypt(saved.codeVerifierEnc));
        const shop = await app.channels.depop.getShop(tokens.access_token);
        const data = {
          status: "CONNECTED" as const,
          externalAccountId: String(shop.id),
          externalUsername: shop.username,
          accessTokenEnc: cipher.encrypt(tokens.access_token),
          refreshTokenEnc: cipher.encrypt(tokens.refresh_token),
          accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          scopes: DEPOP_SCOPES.join(" "),
          connectedById: request.auth.userId,
        };
        const connection = await app.prisma.channelConnection.upsert({
          where: { organizationId_channel: { organizationId: request.auth.organizationId, channel: channel.data } },
          create: { organizationId: request.auth.organizationId, channel: channel.data, ...data },
          update: data,
        });
        // Webhook des commandes (US9) : ventes reçues en quelques secondes. Sans lui, le relevé de
        // secours prend le relais, donc un échec ici ne bloque pas la connexion.
        if (app.channels.config.webhooksEnabled && !connection.webhookId) {
          try {
            const url = `${app.channels.config.publicApiUrl.replace(/\/$/, "")}/webhooks/depop/${connection.id}`;
            const hook = await app.channels.depop.createWebhook(tokens.access_token, url, ["v1:order.*"]);
            await app.prisma.channelConnection.update({
              where: { id: connection.id },
              data: { webhookId: hook.id, webhookSecretEnc: hook.secret ? cipher.encrypt(hook.secret) : null },
            });
          } catch (err) {
            request.log.warn(err, "webhook Depop non enregistré : le relevé de secours prend le relais");
          }
        }
      } catch (err) {
        request.log.warn(err, "connexion Depop échouée");
        return back({ error: "connect_failed", channel: key });
      }
      return back({ connected: key });
    },
  );

  // Réglages du compte connecté (Depop : État d'où partent les colis).
  app.put<{ Params: { channel: string } }>("/:channel/settings", canManage, async (request) => {
    const channel = ChannelParam.parse(request.params.channel);
    supported(channel);
    const input = DepopSettingsInput.parse(request.body);
    const where = { organizationId_channel: { organizationId: request.auth!.organizationId, channel } };
    const existing = await app.prisma.channelConnection.findUnique({ where });
    if (!existing) throw new HttpError(404, "not_connected");
    const settings = { ...(existing.settings as object), shipFromState: input.shipFromState };
    await app.prisma.channelConnection.update({ where, data: { settings } });
    return { settings };
  });

  // Déconnexion : les jetons sont effacés ; les annonces déjà en ligne restent sur le canal.
  app.delete<{ Params: { channel: string } }>("/:channel", canManage, async (request, reply) => {
    const channel = ChannelParam.parse(request.params.channel);
    await app.prisma.channelConnection.deleteMany({ where: { organizationId: request.auth!.organizationId, channel } });
    return reply.code(204).send();
  });
};
