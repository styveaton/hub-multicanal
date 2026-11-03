import type { FastifyRequest } from "fastify";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "@hub/shared";

/** Langue de la requête : cookie choisi sur le site, sinon langue du navigateur (proxy Next.js inclus). */
export const requestLocale = (request: FastifyRequest): Locale =>
  resolveLocale({ cookie: request.cookies?.[LOCALE_COOKIE], acceptLanguage: request.headers["accept-language"] });
