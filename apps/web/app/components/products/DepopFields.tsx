"use client";

import { AlertTriangle, CheckCircle2, Clock, ExternalLink, MinusCircle } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import {
  DEPOP_DEPARTMENTS,
  DEPOP_DESCRIPTION_MAX,
  depopDescription,
  depopProductTypes,
  depopSizeSetId,
  depopSizes,
  matchDepopSize,
  variantSizeValue,
  type DepopDepartment,
  type DepopDetails,
} from "@hub/shared";
import { useI18n } from "../../i18n/I18nProvider";
import type { Listing, ProductDetail } from "../../lib/api";

/** Valeurs saisies dans l'onglet Depop (les frais de port en texte, convertis à l'enregistrement). */
export interface DepopForm {
  department: DepopDepartment | "";
  productType: string;
  sizeId: string;
  shipping: string;
}

export const depopFormFrom = (d: DepopDetails | null): DepopForm => ({
  department: d?.department ?? "",
  productType: d?.productType ?? "",
  sizeId: d?.sizeId ? String(d.sizeId) : "",
  shipping: d?.shippingCents != null ? (d.shippingCents / 100).toFixed(2) : "",
});

/** DepopForm → details envoyés à l'API, ou message d'erreur. */
export function depopDetailsFrom(form: DepopForm, invalidShipping: string): DepopDetails | string {
  const details: DepopDetails = {};
  if (form.department) details.department = form.department;
  if (form.productType) details.productType = form.productType;
  if (form.sizeId) details.sizeId = Number(form.sizeId);
  const shipping = form.shipping.trim().replace(",", ".");
  if (shipping !== "") {
    if (!/^\d+(\.\d{1,2})?$/.test(shipping)) return invalidShipping;
    details.shippingCents = Math.round(Number(shipping) * 100);
  }
  return details;
}

export function DepopFields({ product, form, onChange }: { product: ProductDetail; form: DepopForm; onChange: (f: DepopForm) => void }) {
  const { t, locale } = useI18n();
  const d = t.channel.depop;
  const name = (o: { en: string; fr: string }) => (locale === "fr" ? o.fr : o.en);

  const types = useMemo(() => (form.department ? depopProductTypes(form.department) : []), [form.department]);
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; types: typeof types }>();
    for (const type of types) {
      const g = map.get(type.group.id) ?? { label: name(type.group), types: [] };
      g.types.push(type);
      map.set(type.group.id, g);
    }
    return [...map.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types, locale]);
  const sizeSet = form.department && form.productType ? depopSizeSetId(form.department, form.productType) : undefined;
  const sizes = sizeSet ? depopSizes(sizeSet) : [];
  const single = product.mode === "SINGLE";
  const descriptionLength = depopDescription(product.title, product.description).length;

  return (
    <>
      <p className="field-hint">{d.noTitle}</p>
      <p className={`field-hint${descriptionLength > DEPOP_DESCRIPTION_MAX ? " field-hint--warn" : ""}`}>
        {d.descriptionLength(Math.min(descriptionLength, DEPOP_DESCRIPTION_MAX), DEPOP_DESCRIPTION_MAX)}
      </p>

      <div className="form-row form-row--2">
        <label className="field">
          {d.department}
          <select
            className="input"
            value={form.department}
            onChange={(e) => onChange({ ...form, department: e.target.value as DepopDepartment | "", productType: "", sizeId: "" })}
          >
            <option value="">{d.departmentPlaceholder}</option>
            {DEPOP_DEPARTMENTS.map((dep) => (
              <option key={dep.id} value={dep.id}>
                {name(dep)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {d.productType}
          <select
            className="input"
            value={form.productType}
            disabled={!form.department}
            onChange={(e) => onChange({ ...form, productType: e.target.value, sizeId: "" })}
          >
            <option value="">{d.productTypePlaceholder}</option>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {name(type)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {form.productType && !sizeSet && <p className="field-hint">{d.noSize}</p>}
      {sizeSet && single && (
        <label className="field">
          {d.size}
          <select className="input" value={form.sizeId} onChange={(e) => onChange({ ...form, sizeId: e.target.value })}>
            <option value="">{d.sizePlaceholder}</option>
            {sizes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {sizeSet && !single && (
        <div className="field">
          {d.size}
          <span className="field-hint">{d.sizeFromVariants}</span>
          <ul className="size-matches">
            {product.variants.map((v) => {
              const value = variantSizeValue(v.attributes);
              const match = value ? matchDepopSize(sizeSet, value) : undefined;
              return (
                <li key={v.sku} className={match ? "" : "size-matches--miss"}>
                  <span>{v.sku}</span>
                  <span>{match ? sizes.find((s) => s.id === match)?.name : `${value ?? "—"} · ${d.sizeNotFound}`}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <label className="field">
        {d.shipping}
        <span className="input-affix">
          <input
            className="input"
            inputMode="decimal"
            value={form.shipping}
            onChange={(e) => onChange({ ...form, shipping: e.target.value })}
            placeholder="0.00"
            aria-label={d.shipping}
          />
          <span>$</span>
        </span>
        <span className="field-hint">{d.shippingHint}</span>
      </label>
    </>
  );
}

const STATUS_ICON = { PENDING: Clock, LISTED: CheckCircle2, ERROR: AlertTriangle, REMOVED: MinusCircle } as const;

/** État des annonces Depop (une par SKU) et bouton de publication. */
export function DepopListingCard({
  listings,
  pending,
  canPublish,
  notConnected,
  onPublish,
}: {
  listings: Listing[];
  pending: boolean;
  canPublish: boolean;
  notConnected: boolean;
  onPublish: () => void;
}) {
  const { t } = useI18n();
  const d = t.channel.depop;
  const live = listings.some((l) => l.status === "LISTED" || l.status === "PENDING");

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>{d.listingTitle}</h2>
          <p className="muted">{d.listingHint}</p>
        </div>
        <button type="button" className="btn" onClick={onPublish} disabled={pending || !canPublish}>
          {pending ? d.publishing : live ? d.update : d.publish}
        </button>
      </div>

      {notConnected && (
        <p className="note note--warn">
          <AlertTriangle size={16} aria-hidden /> {d.notConnected} <Link href="/channels">{d.goToChannels}</Link>
        </p>
      )}

      {listings.length === 0 ? (
        <p className="empty">{d.noListing}</p>
      ) : (
        <ul className="listing-status">
          {listings.map((l) => {
            const Icon = STATUS_ICON[l.status];
            const reason = l.errorCode ? (d.errorCodes[l.errorCode] ?? l.errorMessage ?? l.errorCode) : null;
            return (
              <li key={l.sku} className={`listing-status--${l.status.toLowerCase()}`}>
                <Icon size={16} aria-hidden />
                <span className="listing-sku">{l.sku}</span>
                <span className="listing-state">
                  {d.status[l.status]}
                  {reason && <small> · {reason}</small>}
                </span>
                {l.status === "LISTED" && l.externalUrl && (
                  <a href={l.externalUrl} target="_blank" rel="noreferrer" className="listing-link">
                    {d.view} <ExternalLink size={14} aria-hidden />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
