/**
 * Langues de l'interface et choix de la langue.
 * Partagé entre le front (pages) et l'API (emails).
 */

export const LOCALES = ["fr", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Langue utilisée quand le navigateur ne demande ni le français ni l'anglais. */
export const DEFAULT_LOCALE: Locale = "en";

/** Cookie posé quand l'utilisateur choisit sa langue ; il prime sur celle du navigateur. */
export const LOCALE_COOKIE = "omnilist_lang";

/** Locale complète pour Intl (dates, montants). */
export const INTL_LOCALE: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

export const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/**
 * Langue préférée d'après l'en-tête Accept-Language du navigateur,
 * ex. « fr-CA,fr;q=0.9,en;q=0.8 » → fr. Renvoie null si aucune langue gérée.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split("-")[0], quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return ranked.map((entry) => entry.lang).find(isLocale) ?? null;
}

/** Choix de la langue : celle choisie par l'utilisateur, sinon celle du navigateur, sinon l'anglais. */
export function resolveLocale(input: { cookie?: string | null; acceptLanguage?: string | null }): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  return localeFromAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE;
}
