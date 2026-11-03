"use client";

import { Globe } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALES, LOCALE_COOKIE, type Locale } from "@hub/shared";
import { useI18n } from "./I18nProvider";

const LABEL: Record<Locale, { short: string; name: string }> = {
  fr: { short: "FR", name: "Français" },
  en: { short: "EN", name: "English" },
};

/** Choix de la langue : mémorisé un an dans un cookie, il remplace la langue du navigateur. */
export function LanguageSwitcher({ dark = false }: { dark?: boolean }) {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: Locale) {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div className={`lang-switch${dark ? " lang-switch--dark" : ""}`} role="group" aria-label={t.common.language} aria-busy={pending}>
      <Globe size={15} aria-hidden />
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          className="lang-option"
          aria-pressed={l === locale}
          title={LABEL[l].name}
          onClick={() => choose(l)}
        >
          <span aria-hidden>{LABEL[l].short}</span>
          <span className="sr-only">{LABEL[l].name}</span>
        </button>
      ))}
    </div>
  );
}
