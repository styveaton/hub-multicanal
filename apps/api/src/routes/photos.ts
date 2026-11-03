import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import multipart from "@fastify/multipart";
import { requireAuth, requirePermission } from "../plugins/auth.js";

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 Mo

/** Type réel du fichier, d'après ses premiers octets (on ne se fie pas à l'extension). */
function detectImageType(buf: Buffer): { contentType: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { contentType: "image/jpeg", ext: "jpg" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { contentType: "image/png", ext: "png" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return { contentType: "image/webp", ext: "webp" };
  return null;
}

export const photoUrl = (id: string) => `/photos/${id}`;

export const photoRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, { limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 0 } });

  // Envoi d'une photo (une par requête ; le front envoie les photos en parallèle).
  app.post("/", { preHandler: requirePermission("products:manage") }, async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "file_required" });

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "photo_too_large", maxBytes: MAX_PHOTO_BYTES });
      }
      throw err;
    }

    const type = detectImageType(buffer);
    if (!type) return reply.code(415).send({ error: "unsupported_photo_type" });

    const { organizationId } = request.auth!;
    const storageKey = `org/${organizationId}/photos/${randomUUID()}.${type.ext}`;
    await app.storage.put(storageKey, buffer, type.contentType);
    const photo = await app.prisma.productPhoto.create({
      data: { organizationId, storageKey, contentType: type.contentType, sizeBytes: buffer.length },
    });
    return reply.code(201).send({ id: photo.id, url: photoUrl(photo.id), contentType: photo.contentType, sizeBytes: photo.sizeBytes });
  });

  // Affichage d'une photo de la boutique.
  app.get<{ Params: { id: string } }>("/:id", { preHandler: requireAuth }, async (request, reply) => {
    const photo = await app.prisma.productPhoto.findFirst({
      where: { id: request.params.id, organizationId: request.auth!.organizationId },
    });
    if (!photo) return reply.code(404).send({ error: "not_found" });
    const object = await app.storage.get(photo.storageKey);
    if (!object) return reply.code(404).send({ error: "not_found" });
    reply.header("content-type", photo.contentType);
    reply.header("cache-control", "private, max-age=86400, immutable");
    return reply.send(object.body);
  });

  // Suppression d'une photo pas encore rattachée (sinon, on la retire via la fiche produit).
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requirePermission("products:manage") },
    async (request, reply) => {
      const photo = await app.prisma.productPhoto.findFirst({
        where: { id: request.params.id, organizationId: request.auth!.organizationId },
      });
      if (!photo) return reply.code(404).send({ error: "not_found" });
      if (photo.productId) return reply.code(409).send({ error: "photo_in_use" });
      await app.prisma.productPhoto.delete({ where: { id: photo.id } });
      await app.storage.delete(photo.storageKey).catch((err) => request.log.warn(err, "suppression photo S3"));
      return reply.code(204).send();
    },
  );
};

/**
 * Photo par lien signé et temporaire, sans session : c'est ainsi que Depop (et plus tard
 * les autres canaux) télécharge les images d'une annonce.
 */
export const publicPhotoRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>("/:id", async (request, reply) => {
    const { id } = request.params;
    if (!app.channels.config.media.verify(id, request.query.exp, request.query.sig)) {
      return reply.code(403).send({ error: "invalid_signature" });
    }
    const photo = await app.prisma.productPhoto.findUnique({ where: { id } });
    const object = photo ? await app.storage.get(photo.storageKey) : null;
    if (!photo || !object) return reply.code(404).send({ error: "not_found" });
    reply.header("content-type", photo.contentType);
    reply.header("cache-control", "public, max-age=86400");
    return reply.send(object.body);
  });
};
