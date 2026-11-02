import { BarChart3, Layers, RefreshCw, Sparkles } from "lucide-react";

/** Les quatre mots-clés de la charte. */
export function BrandKeywords({ dark = false }: { dark?: boolean }) {
  const cls = `keyword${dark ? " keyword--dark" : ""}`;
  return (
    <ul className="keywords">
      <li className={cls}>
        <Layers size={18} className="icon-blue" aria-hidden /> Centralisé
      </li>
      <li className={cls}>
        <RefreshCw size={18} className="icon-teal" aria-hidden /> Synchronisé
      </li>
      <li className={cls}>
        <BarChart3 size={18} className="icon-teal" aria-hidden /> Évolutif
      </li>
      <li className={cls}>
        <Sparkles size={18} className="icon-purple" aria-hidden /> Intelligent
      </li>
    </ul>
  );
}
