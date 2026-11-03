"use client";

import { Layers, Package } from "lucide-react";
import { useState, type FormEvent } from "react";
import { CHANNEL_TITLE_MAX } from "@hub/shared";
import { Alert } from "../Alert";
import { useI18n } from "../../i18n/I18nProvider";
import { api, centsToInput, parseMoney, type Condition, type Photo, type ProductDetail } from "../../lib/api";
import { PhotoUploader } from "./PhotoUploader";
import { VariantsEditor, newVariantRow, type VariantRow } from "./VariantsEditor";

type Mode = "SINGLE" | "VARIANTS";

const CONDITIONS: Condition[] = ["NEW", "USED_LIKE_NEW", "USED_GOOD", "USED_FAIR"];

function initialVariants(defaultOption: string, product?: ProductDetail): { options: string[]; rows: VariantRow[] } {
  if (!product || product.mode !== "VARIANTS" || product.variants.length === 0) {
    return { options: [defaultOption], rows: [newVariantRow(1)] };
  }
  const options = Object.keys(product.variants[0]!.attributes);
  return {
    options,
    rows: product.variants.map((v) => ({
      ...newVariantRow(options.length),
      id: v.id,
      sku: v.sku,
      values: options.map((o) => v.attributes[o] ?? ""),
      price: centsToInput(v.priceCents),
      quantity: String(v.quantity),
    })),
  };
}

/** Fiche maître (US4) : création et modification. */
export function ProductForm({ product, onSaved }: { product?: ProductDetail; onSaved: (p: ProductDetail) => void }) {
  const { t } = useI18n();
  const f = t.form;
  const [mode, setMode] = useState<Mode>(product?.mode ?? "SINGLE");
  const [title, setTitle] = useState(product?.title ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [brand, setBrand] = useState(product?.brand ?? "");
  const [condition, setCondition] = useState<Condition>(product?.condition ?? "NEW");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [price, setPrice] = useState(centsToInput(product?.priceCents));
  const [photos, setPhotos] = useState<Photo[]>(product?.photos ?? []);
  const init = initialVariants(f.defaultOption, product);
  const [options, setOptions] = useState(init.options);
  const [rows, setRows] = useState(init.rows);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  function buildBody(): object | string {
    if (photos.length === 0) return f.errors.photoRequired;
    const base = { title, description, brand: brand || null, condition, photoIds: photos.map((p) => p.id) };
    if (mode === "SINGLE") {
      const priceCents = parseMoney(price);
      if (priceCents == null) return f.errors.priceInvalid;
      return { ...base, mode, sku, priceCents };
    }
    const optionNames = options.map((o) => o.trim());
    if (optionNames.some((o) => !o)) return f.errors.optionNameMissing;
    if (new Set(optionNames.map((o) => o.toLowerCase())).size !== optionNames.length) return f.errors.optionDuplicate;
    const variants = [];
    for (const [i, row] of rows.entries()) {
      const priceCents = parseMoney(row.price);
      if (priceCents == null) return f.errors.variantPrice(i + 1);
      const quantity = Number(row.quantity);
      if (!Number.isInteger(quantity) || quantity < 0) return f.errors.variantQuantity(i + 1);
      variants.push({
        id: row.id,
        sku: row.sku,
        attributes: Object.fromEntries(optionNames.map((name, j) => [name, row.values[j] ?? ""])),
        priceCents,
        quantity,
      });
    }
    return { ...base, mode, variants };
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const body = buildBody();
    if (typeof body === "string") return setError(body);
    setPending(true);
    const res = product
      ? await api<ProductDetail>(`/products/${product.id}`, { method: "PUT", body })
      : await api<ProductDetail>("/products", { method: "POST", body });
    setPending(false);
    if (!res.ok) return setError(res.message);
    setSaved(true);
    onSaved(res.data);
  }

  const ebayMax = CHANNEL_TITLE_MAX.EBAY;

  return (
    <form className="product-form" onSubmit={onSubmit} noValidate={false}>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>{f.photos}</h2>
            <p className="muted">{f.photosHint}</p>
          </div>
        </div>
        <PhotoUploader photos={photos} onChange={setPhotos} />
      </section>

      <section className="card">
        <div className="card-header">
          <h2>{f.info}</h2>
        </div>
        <div className="form">
          <label className="field">
            {f.title}
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
            <span className={`field-hint${title.length > ebayMax ? " field-hint--warn" : ""}`}>
              {f.titleHint(title.length, ebayMax)}
            </span>
          </label>
          <label className="field">
            {f.description}
            <textarea className="input textarea" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={5000} rows={6} />
          </label>
          <div className="form-grid">
            <label className="field">
              {f.brand} <span className="field-optional">{t.common.optional}</span>
              <input className="input" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={100} />
            </label>
            <label className="field">
              {f.condition}
              <select className="input" value={condition} onChange={(e) => setCondition(e.target.value as Condition)}>
                {CONDITIONS.map((value) => (
                  <option key={value} value={value}>
                    {t.conditions[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>{f.priceStock}</h2>
            <p className="muted">{f.priceStockHint}</p>
          </div>
        </div>
        <div className="segmented" role="radiogroup" aria-label={f.productType}>
          <button type="button" role="radio" aria-checked={mode === "SINGLE"} className="segment" onClick={() => setMode("SINGLE")}>
            <Package size={18} aria-hidden />
            <span>
              <strong>{f.single}</strong>
              <small>{f.singleHint}</small>
            </span>
          </button>
          <button type="button" role="radio" aria-checked={mode === "VARIANTS"} className="segment" onClick={() => setMode("VARIANTS")}>
            <Layers size={18} aria-hidden />
            <span>
              <strong>{f.variants}</strong>
              <small>{f.variantsHint}</small>
            </span>
          </button>
        </div>

        {mode === "SINGLE" ? (
          <div className="form-grid" style={{ marginTop: "1.25rem" }}>
            <label className="field">
              SKU
              <input className="input" value={sku} onChange={(e) => setSku(e.target.value)} required maxLength={50} placeholder="VESTE-001" />
              <span className="field-hint">{f.skuHint}</span>
            </label>
            <label className="field">
              {f.price}
              <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="0.00" />
            </label>
            <div className="field">
              {f.quantity}
              <span className="static-value">{f.singleQuantity}</span>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: "1.25rem" }}>
            <VariantsEditor options={options} rows={rows} onOptionsChange={setOptions} onRowsChange={setRows} />
          </div>
        )}
      </section>

      <div className="form-footer">
        {error && <Alert kind="error">{error}</Alert>}
        {saved && !error && <Alert kind="success">{f.saved}</Alert>}
        <button className="btn" disabled={pending}>
          {pending ? t.common.saving : product ? f.save : f.create}
        </button>
      </div>
    </form>
  );
}
