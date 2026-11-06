"use client";

import Link from "next/link";
import { useI18n } from "../i18n/I18nProvider";

/** Pied de page de toutes les pages : mention de l'éditeur et lien vers la confidentialité. */
export function SiteFooter() {
  const { common } = useI18n().t;
  return (
    <footer className="site-footer">
      <span>{common.copyright(new Date().getFullYear())}</span>
      <Link href="/privacy">{common.privacy}</Link>
    </footer>
  );
}
