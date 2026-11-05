import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BrowserTask, ExtensionDevice } from "@hub/db";
import {
  ASSISTED_CHANNELS,
  ASSISTED_CONSENT_VERSION,
  ASSISTED_SITES,
  can,
  isAssistedChannel,
  type AssistedChannel,
} from "@hub/shared";
import {
  OPEN_TASK_STATUSES,
  cancelOpenTasks,
  claimExpired,
  claimTask,
  completeTask,
  failTask,
  listingsLast24h,
  releaseTask,
  siteSwitch,
  type ChannelDeps,
} from "@hub/channels";
import { hashToken, newToken } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { requirePermission } from "../plugins/auth.js";

/**
 * Extension « OmniList Assistant » (docs/PLAN-EXTENSION.md).
 * - `extensionAdminRoutes` (session du site) : navigateurs reliés et accords par site.
 * - `extensionDeviceRoutes` (jeton du navigateur) : configuration et tâches.
 */

/** Préfixe des jetons de navigateur : reconnaissable dans un journal ou un ticket. */
const DEVICE_TOKEN_PREFIX = "omx_";

const AssistedParam = z
  .string()
  .transform((s) => s.toUpperCase())
  .refine(isAssistedChannel, "channel_not_assisted")
  .transform((s) => s as AssistedChannel);

const DeviceInput = z.object({ name: z.string().trim().min(1).max(80) });

const ConsentInput = z.object({
  // L'écran d'accord envoie la version du texte lu : un texte plus récent demande une nouvelle lecture.
  version: z.literal(ASSISTED_CONSENT_VERSION, { message: "consent_outdated" }),
  accepted: z.literal(true),
  dailyCap: z.number().int().min(1).optional(),
});

const ConsentUpdate = z.object({
  dailyCap: z.number().int().min(1).optional(),
  paused: z.boolean().optional(),
});

const CompleteInput = z.object({
  listingUrl: z.string().url().max(500).nullish(),
  externalId: z.string().trim().min(1).max(200).nullish(),
});

const FailInput = z.object({
  code: z.string().trim().regex(/^[a-z0-9_]{1,40}$/, "code_invalid"),
  message: z.string().max(500).nullish(),
});

/** Seul le domaine du site peut être renvoyé comme lien d'annonce. */
function onSiteHost(channel: AssistedChannel, url: string) {
  const host = new URL(url).hostname;
  return ASSISTED_SITES[channel].hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

function channelDeps(app: FastifyInstance): ChannelDeps {
  const { config, depop, shopify, woo, ebay, etsy } = app.channels;
  return { prisma: app.prisma, cipher: config.cipher, media: config.media, depop, shopify, woo, ebay, etsy };
}

const serializeDevice = (d: ExtensionDevice) => ({
  id: d.id,
  name: d.name,
  lastSeenAt: d.lastSeenAt,
  extensionVersion: d.extensionVersion,
  createdAt: d.createdAt,
});

// ---------------------------------------------------------------------------
// Côté site OmniList (session)
// ---------------------------------------------------------------------------

export const extensionAdminRoutes: FastifyPluginAsync = async (app) => {
  const canManage = { preHandler: requirePermission("channels:manage") };
  const deps = channelDeps(app);

  // Navigateurs reliés à la boutique.
  app.get("/devices", canManage, async (request) => {
    const devices = await app.prisma.extensionDevice.findMany({
      where: { organizationId: request.auth!.organizationId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return { items: devices.map(serializeDevice) };
  });

  // Relier un navigateur : le jeton est renvoyé une seule fois, à l'extension, et stocké haché.
  app.post("/devices", canManage, async (request, reply) => {
    const { name } = DeviceInput.parse(request.body ?? {});
    const { organizationId, userId } = request.auth!;
    const token = `${DEVICE_TOKEN_PREFIX}${newToken()}`;
    const device = await app.prisma.extensionDevice.create({ data: { organizationId, userId, name, tokenHash: hashToken(token) } });
    return reply.code(201).send({ device: serializeDevice(device), token });
  });

  // Révoquer : le navigateur perd l'accès tout de suite, ses tâches ouvertes reviennent dans la file.
  app.delete<{ Params: { id: string } }>("/devices/:id", canManage, async (request, reply) => {
    const { organizationId } = request.auth!;
    const device = await app.prisma.extensionDevice.findFirst({ where: { id: request.params.id, organizationId, revokedAt: null } });
    if (!device) throw new HttpError(404, "not_found");
    await app.prisma.$transaction([
      app.prisma.extensionDevice.update({ where: { id: device.id }, data: { revokedAt: new Date() } }),
      app.prisma.browserTask.updateMany({ where: { deviceId: device.id, status: "CLAIMED" }, data: { status: "QUEUED", deviceId: null, claimedAt: null } }),
    ]);
    return reply.code(204).send();
  });

  // État des sites assistés pour la boutique : interrupteur, accord, plafond, tâches en attente.
  app.get("/consents", canManage, async (request) => {
    const { organizationId } = request.auth!;
    const [consents, open] = await Promise.all([
      app.prisma.channelConsent.findMany({ where: { organizationId } }),
      app.prisma.browserTask.groupBy({ by: ["channel"], where: { organizationId, status: { in: [...OPEN_TASK_STATUSES] } }, _count: true }),
    ]);
    const items = [];
    for (const channel of ASSISTED_CHANNELS) {
      const c = consents.find((x) => x.channel === channel);
      items.push({
        channel,
        site: await siteSwitch(deps, channel),
        defaultDailyCap: ASSISTED_SITES[channel].defaultDailyCap,
        consentVersion: ASSISTED_CONSENT_VERSION,
        consent: c
          ? { version: c.version, acceptedAt: c.acceptedAt, dailyCap: c.dailyCap, pausedAt: c.pausedAt, pauseReason: c.pauseReason }
          : null,
        openTasks: open.find((o) => o.channel === channel)?._count ?? 0,
      });
    }
    return { items };
  });

  // Accord du vendeur, après lecture de l'écran des risques. Le plafond ne peut que baisser.
  app.post<{ Params: { channel: string } }>("/consents/:channel", canManage, async (request) => {
    const channel = AssistedParam.parse(request.params.channel);
    const input = ConsentInput.parse(request.body ?? {});
    const max = ASSISTED_SITES[channel].defaultDailyCap;
    if (input.dailyCap != null && input.dailyCap > max) throw new HttpError(400, "daily_cap_too_high", { max });
    const { organizationId, userId } = request.auth!;
    const data = { version: input.version, acceptedById: userId, acceptedAt: new Date(), dailyCap: input.dailyCap ?? max };
    const consent = await app.prisma.channelConsent.upsert({
      where: { organizationId_channel: { organizationId, channel } },
      create: { organizationId, channel, ...data },
      update: data,
    });
    return { consent: { version: consent.version, acceptedAt: consent.acceptedAt, dailyCap: consent.dailyCap, pausedAt: consent.pausedAt } };
  });

  // Baisser le plafond, mettre en pause ou reprendre.
  app.patch<{ Params: { channel: string } }>("/consents/:channel", canManage, async (request) => {
    const channel = AssistedParam.parse(request.params.channel);
    const input = ConsentUpdate.parse(request.body ?? {});
    const max = ASSISTED_SITES[channel].defaultDailyCap;
    if (input.dailyCap != null && input.dailyCap > max) throw new HttpError(400, "daily_cap_too_high", { max });
    const where = { organizationId_channel: { organizationId: request.auth!.organizationId, channel } };
    const existing = await app.prisma.channelConsent.findUnique({ where });
    if (!existing) throw new HttpError(404, "consent_missing");
    const pause =
      input.paused === true && !existing.pausedAt
        ? { pausedAt: new Date(), pauseReason: "manual" }
        : input.paused === false
          ? { pausedAt: null, pauseReason: null }
          : {};
    const consent = await app.prisma.channelConsent.update({
      where,
      data: { ...(input.dailyCap != null ? { dailyCap: input.dailyCap } : {}), ...pause },
    });
    return { consent: { version: consent.version, acceptedAt: consent.acceptedAt, dailyCap: consent.dailyCap, pausedAt: consent.pausedAt, pauseReason: consent.pauseReason } };
  });

  // Retirer l'accord : plus aucune tâche pour ce site. Les annonces déjà en ligne restent sur le site.
  app.delete<{ Params: { channel: string } }>("/consents/:channel", canManage, async (request, reply) => {
    const channel = AssistedParam.parse(request.params.channel);
    const { organizationId } = request.auth!;
    await app.prisma.channelConsent.deleteMany({ where: { organizationId, channel } });
    await cancelOpenTasks(deps, organizationId, channel, "consent_withdrawn");
    return reply.code(204).send();
  });
};

// ---------------------------------------------------------------------------
// Côté extension (jeton du navigateur)
// ---------------------------------------------------------------------------

interface DeviceContext {
  device: ExtensionDevice;
  organizationId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    extension?: DeviceContext;
  }
}

export const extensionDeviceRoutes: FastifyPluginAsync = async (app) => {
  const deps = channelDeps(app);

  // Jeton « Authorization: Bearer omx_… ». Navigateur révoqué ou membre retiré : 401.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return reply.code(401).send({ error: "unauthenticated" });
    const device = await app.prisma.extensionDevice.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!device || device.revokedAt) return reply.code(401).send({ error: "unauthenticated" });
    const membership = await app.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: device.userId, organizationId: device.organizationId } },
    });
    if (!membership || !can(membership.role, "channels:manage")) return reply.code(401).send({ error: "unauthenticated" });
    const version = request.headers["x-extension-version"];
    await app.prisma.extensionDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date(), ...(typeof version === "string" ? { extensionVersion: version.slice(0, 20) } : {}) },
    });
    request.extension = { device, organizationId: device.organizationId };
  });

  /** Tâche de la boutique du navigateur, sur un site assisté. */
  async function loadTask(request: FastifyRequest<{ Params: { id: string } }>): Promise<BrowserTask> {
    const task = await app.prisma.browserTask.findFirst({ where: { id: request.params.id, organizationId: request.extension!.organizationId } });
    if (!task || !isAssistedChannel(task.channel)) throw new HttpError(404, "not_found");
    return task;
  }

  /** La tâche doit être ouverte par ce navigateur pour être terminée ou rendue. */
  function ownClaim(request: FastifyRequest, task: BrowserTask) {
    if (task.status !== "CLAIMED" || task.deviceId !== request.extension!.device.id) throw new HttpError(409, "task_not_claimed");
  }

  // Configuration lue avant chaque tâche : interrupteurs, accords, plafonds, repères de page.
  app.get("/config", async (request) => {
    const { organizationId, device } = request.extension!;
    const consents = await app.prisma.channelConsent.findMany({ where: { organizationId } });
    const sites = [];
    for (const channel of ASSISTED_CHANNELS) {
      const c = consents.find((x) => x.channel === channel);
      const site = await siteSwitch(deps, channel);
      sites.push({
        channel,
        hosts: ASSISTED_SITES[channel].hosts,
        enabled: site.enabled,
        selectorsVersion: site.selectorsVersion,
        consented: c != null,
        paused: c?.pausedAt != null,
        pauseReason: c?.pauseReason ?? null,
        dailyCap: c?.dailyCap ?? 0,
        usedLast24h: c ? await listingsLast24h(deps, organizationId, channel) : 0,
      });
    }
    return { device: { id: device.id, name: device.name }, sites };
  });

  // Tâches à faire (en attente, ou ouvertes par ce navigateur). Le badge de l'extension en affiche le nombre.
  app.get("/tasks", async (request) => {
    const { organizationId, device } = request.extension!;
    const now = new Date();
    const tasks = await app.prisma.browserTask.findMany({
      where: { organizationId, channel: { in: [...ASSISTED_CHANNELS] }, status: { in: [...OPEN_TASK_STATUSES] } },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    const visible = tasks.filter((t) => t.status === "QUEUED" || t.deviceId === device.id || claimExpired(t, now));
    return {
      items: visible.map((t) => ({
        id: t.id,
        channel: t.channel,
        type: t.type,
        sku: t.skuCode,
        title: t.title,
        status: t.status === "CLAIMED" && t.deviceId === device.id ? "CLAIMED" : "QUEUED",
        attempts: t.attempts,
        lastError: t.errorCode,
        createdAt: t.createdAt,
      })),
    };
  });

  // Ouvrir une tâche : renvoie de quoi remplir le formulaire du site.
  app.post<{ Params: { id: string } }>("/tasks/:id/claim", async (request) => {
    const task = await loadTask(request);
    const result = await claimTask(deps, task, request.extension!.device.id);
    if (!result.ok) throw new HttpError(result.reason === "task_not_open" ? 409 : result.reason === "daily_cap_reached" ? 429 : 423, result.reason);
    return result.payload;
  });

  // Le vendeur a cliqué sur le bouton final du site : l'extension renvoie le lien de l'annonce.
  app.post<{ Params: { id: string } }>("/tasks/:id/complete", async (request) => {
    const task = await loadTask(request);
    ownClaim(request, task);
    const input = CompleteInput.parse(request.body ?? {});
    if (input.listingUrl && !onSiteHost(task.channel as AssistedChannel, input.listingUrl)) throw new HttpError(400, "listing_url_invalid");
    if (task.type === "LIST" && !input.listingUrl && !input.externalId) throw new HttpError(400, "listing_reference_missing");
    await completeTask(deps, task, input);
    return { status: "DONE" };
  });

  // Échec ou alerte du site. Une alerte met le site en pause pour le vendeur.
  app.post<{ Params: { id: string } }>("/tasks/:id/fail", async (request) => {
    const task = await loadTask(request);
    ownClaim(request, task);
    const input = FailInput.parse(request.body ?? {});
    return failTask(deps, task, input);
  });

  // Tâche fermée sans résultat : elle revient dans la file.
  app.post<{ Params: { id: string } }>("/tasks/:id/release", async (request) => {
    const task = await loadTask(request);
    ownClaim(request, task);
    await releaseTask(deps, task);
    return { status: "QUEUED" };
  });
};
