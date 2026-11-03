import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "@hub/shared";

/** Langue de la page : choix enregistré (cookie), sinon langue du navigateur (Accept-Language). */
export async function getLocale(): Promise<Locale> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  return resolveLocale({ cookie: cookieStore.get(LOCALE_COOKIE)?.value, acceptLanguage: headerList.get("accept-language") });
}
