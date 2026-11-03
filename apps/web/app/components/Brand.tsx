"use client";

import { BarChart3, Layers, RefreshCw, Sparkles } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";

/** Les quatre mots-clés de la charte. */
export function BrandKeywords({ dark = false }: { dark?: boolean }) {
  const { keywords } = useI18n().t.brand;
  const cls = `keyword${dark ? " keyword--dark" : ""}`;
  return (
    <ul className="keywords">
      <li className={cls}>
        <Layers size={18} className="icon-blue" aria-hidden /> {keywords.centralized}
      </li>
      <li className={cls}>
        <RefreshCw size={18} className="icon-teal" aria-hidden /> {keywords.synced}
      </li>
      <li className={cls}>
        <BarChart3 size={18} className="icon-teal" aria-hidden /> {keywords.scalable}
      </li>
      <li className={cls}>
        <Sparkles size={18} className="icon-purple" aria-hidden /> {keywords.smart}
      </li>
    </ul>
  );
}
