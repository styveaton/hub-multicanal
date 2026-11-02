"use client";

import { AlertTriangle, Info } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { PERCENT_BPS_MAX, PERCENT_BPS_MIN, applyPriceRule, feePreview, formatMoney, type PriceRule } from "@hub/shared";
import { Alert } from "../Alert";
import { api, centsToInput, parseMoney, type ChannelSettings, type ProductDetail } from "../../lib/api";

type PriceMode = PriceRule["mode"];

/** Onglet d'un canal (US5) : activation, titre, catégorie, prix et aperçu des frais. */
export function ChannelPanel({
  product,
  settings,
  onSaved,
}: {
  product: ProductDetail;
  settings: ChannelSettings;
  onSaved: (s: ChannelSettings) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [title, setTitle] = useState(settings.title ?? "");
  const [category, setCategory] = useState(settings.category ?? "");
  const [priceMode, setPriceMode] = useState<PriceMode>(settings.price.mode);
  const [fixed, setFixed] = useState(settings.price.mode === "FIXED" ? centsToInput(settings.price.priceCents) : "");
  const [percent, setPercent] = useState(settings.price.mode === "PERCENT" ? String(settings.price.percentBps / 100) : "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const single = product.mode === "SINGLE";
  const effectiveTitle = title.trim() || product.title;
  const titleTooLong = effectiveTitle.length > settings.titleMax;

  // Règle de prix saisie, ou message d'erreur.
  const rule = useMemo((): PriceRule | string => {
    if (priceMode === "BASE") return { mode: "BASE" };
    if (priceMode === "FIXED") {
      const cents = parseMoney(fixed);
      return cents == null ? "Prix fixe invalide." : { mode: "FIXED", priceCents: cents };
    }
    const value = Number(percent.replace(",", "."));
    const bps = Math.round(value * 100);
    if (percent.trim() === "" || !Number.isFinite(value)) return "Pourcentage invalide.";
    if (bps < PERCENT_BPS_MIN || bps > PERCENT_BPS_MAX) return "Pourcentage entre -90 % et +300 %.";
    return { mode: "PERCENT", percentBps: bps };
  }, [priceMode, fixed, percent]);

  // Aperçu en direct, avec les mêmes règles que l'API.
  const items = single
    ? [{ key: "single", label: product.sku ?? "", base: product.priceCents ?? 0 }]
    : product.variants.map((v) => ({ key: v.id ?? v.sku, label: `${Object.values(v.attributes).join(" / ")} · ${v.sku}`, base: v.priceCents }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    if (typeof rule === "string") return setError(rule);
    if (title.trim().length > settings.titleMax) return setError(`Titre trop long pour ${settings.label} (${settings.titleMax} caractères maximum).`);
    setPending(true);
    const res = await api<ChannelSettings>(`/products/${product.id}/channels/${settings.channel}`, {
      method: "PUT",
      body: { enabled, title: title.trim() || null, category: category.trim() || null, price: rule },
    });
    setPending(false);
    if (!res.ok) return setError(res.message);
    setSaved(true);
    onSaved(res.data);
  }

  return (
    <form className="channel-panel" onSubmit={onSubmit}>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>Publication sur {settings.label}</h2>
            <p className="muted">La publication réelle arrivera avec la connexion du compte {settings.label}.</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="switch-track" aria-hidden />
            <span>{enabled ? "Activé" : "Désactivé"}</span>
          </label>
        </div>

        <fieldset className="form" disabled={!enabled}>
          <label className="field">
            Titre pour {settings.label} <span className="field-optional">(facultatif)</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={product.title} />
            <span className={`field-hint${titleTooLong ? " field-hint--warn" : ""}`}>
              {effectiveTitle.length}/{settings.titleMax} caractères
              {title.trim() ? "" : " · titre de la fiche maître utilisé"}
            </span>
          </label>
          <label className="field">
            Catégorie {settings.label}
            <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="ex. Vêtements > Vestes" />
            <span className="field-hint">Texte libre pour l&apos;instant ; la liste officielle arrivera avec la connexion du canal.</span>
          </label>

          <div className="field" role="radiogroup" aria-label="Prix sur ce canal">
            Prix sur {settings.label}
            <div className="price-modes">
              <label className="radio">
                <input type="radio" name={`mode-${settings.channel}`} checked={priceMode === "BASE"} onChange={() => setPriceMode("BASE")} />
                Prix de la fiche maître
              </label>
              <label className="radio">
                <input type="radio" name={`mode-${settings.channel}`} checked={priceMode === "PERCENT"} onChange={() => setPriceMode("PERCENT")} />
                Ajuster en %
              </label>
              <label className={`radio${single ? "" : " radio--disabled"}`} title={single ? undefined : "Réservé aux articles uniques"}>
                <input
                  type="radio"
                  name={`mode-${settings.channel}`}
                  checked={priceMode === "FIXED"}
                  onChange={() => setPriceMode("FIXED")}
                  disabled={!single}
                />
                Prix fixe
              </label>
            </div>
            {priceMode === "PERCENT" && (
              <span className="input-affix">
                <input
                  className="input"
                  inputMode="decimal"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  placeholder="ex. 10 ou -5"
                  aria-label="Ajustement en pourcentage"
                />
                <span>%</span>
              </span>
            )}
            {priceMode === "FIXED" && (
              <span className="input-affix">
                <input className="input" inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} placeholder="0.00" aria-label="Prix fixe en dollars" />
                <span>$</span>
              </span>
            )}
          </div>
        </fieldset>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>Aperçu indicatif des frais</h2>
            <p className="muted">Estimation : les frais réels dépendent de la catégorie et de votre contrat.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="fee-table">
            <thead>
              <tr>
                <th scope="col">{single ? "Article" : "Variante"}</th>
                <th scope="col">Prix maître</th>
                <th scope="col">Prix {settings.label}</th>
                <th scope="col">Frais estimés</th>
                <th scope="col">Net estimé</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const p = typeof rule === "string" ? null : feePreview(applyPriceRule(item.base, rule), settings.channel);
                return (
                  <tr key={item.key}>
                    <th scope="row">{item.label}</th>
                    <td>{formatMoney(item.base, product.currency)}</td>
                    <td>{p ? formatMoney(p.priceCents, product.currency) : "—"}</td>
                    <td className="fee">{p ? `− ${formatMoney(p.feeCents, product.currency)}` : "—"}</td>
                    <td className="net">{p ? formatMoney(p.netCents, product.currency) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note">
          <Info size={16} aria-hidden /> {settings.feeNote}
        </p>
      </section>

      {enabled && settings.warnings.length > 0 && (
        <ul className="warnings">
          {settings.warnings.map((w) => (
            <li key={w.code}>
              <AlertTriangle size={16} aria-hidden /> {w.message}
            </li>
          ))}
        </ul>
      )}

      <div className="form-footer">
        {error && <Alert kind="error">{error}</Alert>}
        {saved && !error && <Alert kind="success">Réglages {settings.label} enregistrés.</Alert>}
        <button className="btn" disabled={pending}>
          {pending ? "Enregistrement…" : `Enregistrer pour ${settings.label}`}
        </button>
      </div>
    </form>
  );
}
