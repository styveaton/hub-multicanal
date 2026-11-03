"use client";

import { AlertTriangle, Info } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { FEE_NOTES, PERCENT_BPS_MAX, PERCENT_BPS_MIN, applyPriceRule, feePreview, formatMoney, type PriceRule } from "@hub/shared";
import { Alert } from "../Alert";
import { useI18n } from "../../i18n/I18nProvider";
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
  const { t, locale, intl } = useI18n();
  const c = t.channel;
  const label = settings.label;
  const money = (cents: number) => formatMoney(cents, product.currency, intl);
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
      return cents == null ? c.fixedInvalid : { mode: "FIXED", priceCents: cents };
    }
    const value = Number(percent.replace(",", "."));
    const bps = Math.round(value * 100);
    if (percent.trim() === "" || !Number.isFinite(value)) return c.percentInvalid;
    if (bps < PERCENT_BPS_MIN || bps > PERCENT_BPS_MAX) return c.percentRange;
    return { mode: "PERCENT", percentBps: bps };
  }, [priceMode, fixed, percent, c]);

  // Aperçu en direct, avec les mêmes règles que l'API.
  const items = single
    ? [{ key: "single", label: product.sku ?? "", base: product.priceCents ?? 0 }]
    : product.variants.map((v) => ({ key: v.id ?? v.sku, label: `${Object.values(v.attributes).join(" / ")} · ${v.sku}`, base: v.priceCents }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    if (typeof rule === "string") return setError(rule);
    if (title.trim().length > settings.titleMax) return setError(c.titleTooLong(label, settings.titleMax));
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
            <h2>{c.publishOn(label)}</h2>
            <p className="muted">{c.publishHint(label)}</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="switch-track" aria-hidden />
            <span>{enabled ? c.enabled : c.disabled}</span>
          </label>
        </div>

        <fieldset className="form" disabled={!enabled}>
          <label className="field">
            {c.titleFor(label)} <span className="field-optional">{t.common.optional}</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={product.title} />
            <span className={`field-hint${titleTooLong ? " field-hint--warn" : ""}`}>
              {c.characters(effectiveTitle.length, settings.titleMax)}
              {title.trim() ? "" : c.masterTitleUsed}
            </span>
          </label>
          <label className="field">
            {c.category(label)}
            <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={c.categoryPlaceholder} />
            <span className="field-hint">{c.categoryHint}</span>
          </label>

          <div className="field" role="radiogroup" aria-label={c.priceLabel}>
            {c.priceOn(label)}
            <div className="price-modes">
              <label className="radio">
                <input type="radio" name={`mode-${settings.channel}`} checked={priceMode === "BASE"} onChange={() => setPriceMode("BASE")} />
                {c.base}
              </label>
              <label className="radio">
                <input type="radio" name={`mode-${settings.channel}`} checked={priceMode === "PERCENT"} onChange={() => setPriceMode("PERCENT")} />
                {c.percent}
              </label>
              <label className={`radio${single ? "" : " radio--disabled"}`} title={single ? undefined : c.fixedSingleOnly}>
                <input
                  type="radio"
                  name={`mode-${settings.channel}`}
                  checked={priceMode === "FIXED"}
                  onChange={() => setPriceMode("FIXED")}
                  disabled={!single}
                />
                {c.fixed}
              </label>
            </div>
            {priceMode === "PERCENT" && (
              <span className="input-affix">
                <input
                  className="input"
                  inputMode="decimal"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  placeholder={c.percentPlaceholder}
                  aria-label={c.percentLabel}
                />
                <span>%</span>
              </span>
            )}
            {priceMode === "FIXED" && (
              <span className="input-affix">
                <input className="input" inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} placeholder="0.00" aria-label={c.fixedLabel} />
                <span>$</span>
              </span>
            )}
          </div>
        </fieldset>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>{c.feesTitle}</h2>
            <p className="muted">{c.feesHint}</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="fee-table">
            <thead>
              <tr>
                <th scope="col">{single ? c.item : c.variant}</th>
                <th scope="col">{c.masterPrice}</th>
                <th scope="col">{c.channelPrice(label)}</th>
                <th scope="col">{c.fees}</th>
                <th scope="col">{c.net}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const p = typeof rule === "string" ? null : feePreview(applyPriceRule(item.base, rule), settings.channel);
                return (
                  <tr key={item.key}>
                    <th scope="row">{item.label}</th>
                    <td>{money(item.base)}</td>
                    <td>{p ? money(p.priceCents) : "—"}</td>
                    <td className="fee">{p ? `− ${money(p.feeCents)}` : "—"}</td>
                    <td className="net">{p ? money(p.netCents) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note">
          <Info size={16} aria-hidden /> {FEE_NOTES[settings.channel][locale]}
        </p>
      </section>

      {enabled && settings.warnings.length > 0 && (
        <ul className="warnings">
          {settings.warnings.map((w) => (
            <li key={w.code}>
              <AlertTriangle size={16} aria-hidden />{" "}
              {w.code === "title_too_long" ? c.warnings.title_too_long(label, w.length, w.max) : c.warnings.category_missing(label)}
            </li>
          ))}
        </ul>
      )}

      <div className="form-footer">
        {error && <Alert kind="error">{error}</Alert>}
        {saved && !error && <Alert kind="success">{c.saved(label)}</Alert>}
        <button className="btn" disabled={pending}>
          {pending ? t.common.saving : c.save(label)}
        </button>
      </div>
    </form>
  );
}
