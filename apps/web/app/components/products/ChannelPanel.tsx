"use client";

import { AlertTriangle, Info } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CHANNEL_INTEGRATION, FEE_NOTES, type EtsyDetails, PERCENT_BPS_MAX, PERCENT_BPS_MIN, applyPriceRule, feePreview, formatMoney, type PriceRule } from "@hub/shared";
import { Alert } from "../Alert";
import { useI18n } from "../../i18n/I18nProvider";
import { api, centsToInput, parseMoney, type ChannelSettings, type ChannelWarning, type ProductDetail } from "../../lib/api";
import { DepopFields, depopDetailsFrom, depopFormFrom } from "./DepopFields";
import { EtsyFields } from "./EtsyFields";
import { ListingCard } from "./ListingCard";

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
  const isDepop = settings.channel === "DEPOP";
  const isShopify = settings.channel === "SHOPIFY";
  const isWoo = settings.channel === "WOOCOMMERCE";
  const isEbay = settings.channel === "EBAY";
  const isEtsy = settings.channel === "ETSY";
  // Catégorie facultative : Shopify (type de produit), WooCommerce (étiquette), eBay et Etsy (trouvée d'après le titre).
  const categoryOptional = isShopify || isWoo || isEbay || isEtsy;
  const [etsyDetails, setEtsyDetails] = useState<EtsyDetails>(() => ({
    whoMade: settings.details?.whoMade,
    whenMade: settings.details?.whenMade,
  }));
  const [depopForm, setDepopForm] = useState(() => depopFormFrom(settings.details));
  const [publishing, setPublishing] = useState(false);
  const [notConnected, setNotConnected] = useState(false);

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

  /** Enregistre les réglages du canal ; renvoie les réglages à jour, ou null en cas d'erreur. */
  async function save(enabledValue = enabled): Promise<ChannelSettings | null> {
    const fail = (message: string) => {
      setError(message);
      return null;
    };
    setError(null);
    setSaved(false);
    if (typeof rule === "string") return fail(rule);
    // Depop n'a pas de titre : la limite de titre ne s'applique pas.
    if (!isDepop && title.trim().length > settings.titleMax) return fail(c.titleTooLong(label, settings.titleMax));
    const details = isDepop ? depopDetailsFrom(depopForm, c.depop.shippingInvalid) : isEtsy ? etsyDetails : undefined;
    if (typeof details === "string") return fail(details);
    const res = await api<ChannelSettings>(`/products/${product.id}/channels/${settings.channel}`, {
      method: "PUT",
      body: { enabled: enabledValue, title: title.trim() || null, category: category.trim() || null, price: rule, details },
    });
    if (!res.ok) return fail(res.message);
    onSaved(res.data);
    return res.data;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    const res = await save();
    setPending(false);
    if (res) setSaved(true);
  }

  // Publier = enregistrer (canal activé) puis demander l'envoi ; le worker fait le reste.
  async function onPublish() {
    setPublishing(true);
    setNotConnected(false);
    const savedSettings = await save(true);
    if (!savedSettings) return setPublishing(false);
    setEnabled(true);
    const res = await api<ChannelSettings>(`/products/${product.id}/channels/${settings.channel}/publish`, { method: "POST" });
    setPublishing(false);
    if (!res.ok) {
      if (res.code === "channel_not_connected" || res.code === "channel_needs_reauth") setNotConnected(true);
      return setError(res.message);
    }
    onSaved(res.data);
  }

  // Envoi en cours : on relit l'état des annonces toutes les 2 secondes (1 minute au plus).
  const polls = useRef(0);
  // Sites assistés : l'annonce attend le vendeur dans l'extension, inutile de relire en boucle.
  const waiting = settings.listings.some((l) => l.status === "PENDING" && l.errorCode !== "awaiting_seller");
  useEffect(() => {
    if (!waiting || polls.current >= 30) return;
    const timer = setTimeout(async () => {
      polls.current += 1;
      const res = await api<ProductDetail>(`/products/${product.id}`);
      const next = res.ok ? res.data.channels.find((ch) => ch.channel === settings.channel) : undefined;
      if (next) onSaved(next);
    }, 2000);
    return () => clearTimeout(timer);
  }, [waiting, settings, product.id, onSaved]);

  const warningText = (w: ChannelWarning) => {
    if (w.code === "title_too_long") return c.warnings.title_too_long(label, w.length, w.max);
    if (w.code === "category_missing") return c.warnings.category_missing(label);
    if (w.code === "etsy_too_many_options") return c.warnings.etsy_too_many_options(w.max);
    if (w.code === "etsy_who_made_missing" || w.code === "etsy_when_made_missing") return c.warnings[w.code]();
    if (w.code === "price_too_low" && isEtsy) return c.etsy.priceTooLow(w.sku);
    return c.warnings[w.code](w.sku);
  };

  return (
    <form className="channel-panel" onSubmit={onSubmit}>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>{c.publishOn(label)}</h2>
            <p className="muted">
              {isDepop
                ? c.depop.hint
                : isEbay
                  ? c.ebayHint
                  : isEtsy
                    ? c.etsyHint
                  : isShopify
                  ? c.shopifyHint
                  : isWoo
                    ? c.wooHint
                    : CHANNEL_INTEGRATION[settings.channel] === "assisted"
                  ? c.publishHintAssisted(label)
                  : c.publishHint(label)}
            </p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="switch-track" aria-hidden />
            <span>{enabled ? c.enabled : c.disabled}</span>
          </label>
        </div>

        <fieldset className="form" disabled={!enabled}>
          {isDepop ? (
            <DepopFields product={product} form={depopForm} onChange={setDepopForm} />
          ) : (
            <>
          <label className="field">
            {c.titleFor(label)} <span className="field-optional">{t.common.optional}</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={product.title} />
            <span className={`field-hint${titleTooLong ? " field-hint--warn" : ""}`}>
              {c.characters(effectiveTitle.length, settings.titleMax)}
              {title.trim() ? "" : c.masterTitleUsed}
            </span>
          </label>
          <label className="field">
            {isEtsy ? c.categoryEtsy : isEbay ? c.categoryEbay : isShopify ? c.categoryShopify : isWoo ? c.categoryWoo : c.category(label)}
            {categoryOptional && (
              <>
                {" "}
                <span className="field-optional">{t.common.optional}</span>
              </>
            )}
            <input
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={isEtsy ? c.categoryPlaceholderEtsy : isEbay ? c.categoryPlaceholderEbay : isShopify || isWoo ? c.categoryPlaceholderShopify : c.categoryPlaceholder}
            />
            <span className="field-hint">{isEtsy ? c.categoryEtsyHint : isEbay ? c.categoryEbayHint : isShopify || isWoo ? c.categoryOptionalHint : c.categoryHint}</span>
          </label>
          {isEtsy && <EtsyFields details={etsyDetails} onChange={setEtsyDetails} />}
            </>
          )}

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

      {settings.publishable && (
        <ListingCard
          channel={settings.channel}
          label={label}
          listings={settings.listings}
          pending={publishing}
          canPublish={!pending}
          notConnected={notConnected}
          onPublish={onPublish}
        />
      )}

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
            <li key={`${w.code}-${"sku" in w ? (w.sku ?? "") : ""}`}>
              <AlertTriangle size={16} aria-hidden />{" "}
              {warningText(w)}
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
