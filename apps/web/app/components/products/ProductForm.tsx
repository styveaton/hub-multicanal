"use client";

import { Layers, Package } from "lucide-react";
import { useState, type FormEvent } from "react";
import { CHANNEL_TITLE_MAX } from "@hub/shared";
import { Alert } from "../Alert";
import { CONDITION_LABEL, api, centsToInput, parseMoney, type Condition, type Photo, type ProductDetail } from "../../lib/api";
import { PhotoUploader } from "./PhotoUploader";
import { VariantsEditor, newVariantRow, type VariantRow } from "./VariantsEditor";

type Mode = "SINGLE" | "VARIANTS";

function initialVariants(product?: ProductDetail): { options: string[]; rows: VariantRow[] } {
  if (!product || product.mode !== "VARIANTS" || product.variants.length === 0) {
    return { options: ["Taille"], rows: [newVariantRow(1)] };
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
  const [mode, setMode] = useState<Mode>(product?.mode ?? "SINGLE");
  const [title, setTitle] = useState(product?.title ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [brand, setBrand] = useState(product?.brand ?? "");
  const [condition, setCondition] = useState<Condition>(product?.condition ?? "NEW");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [price, setPrice] = useState(centsToInput(product?.priceCents));
  const [photos, setPhotos] = useState<Photo[]>(product?.photos ?? []);
  const init = initialVariants(product);
  const [options, setOptions] = useState(init.options);
  const [rows, setRows] = useState(init.rows);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  function buildBody(): object | string {
    if (photos.length === 0) return "Ajoutez au moins 1 photo.";
    const base = { title, description, brand: brand || null, condition, photoIds: photos.map((p) => p.id) };
    if (mode === "SINGLE") {
      const priceCents = parseMoney(price);
      if (priceCents == null) return "Prix invalide : saisissez un montant supérieur à 0, ex. 19.99.";
      return { ...base, mode, sku, priceCents };
    }
    const optionNames = options.map((o) => o.trim());
    if (optionNames.some((o) => !o)) return "Donnez un nom à chaque option (ex. Taille, Couleur).";
    if (new Set(optionNames.map((o) => o.toLowerCase())).size !== optionNames.length) return "Deux options portent le même nom.";
    const variants = [];
    for (const [i, row] of rows.entries()) {
      const priceCents = parseMoney(row.price);
      if (priceCents == null) return `Variante ${i + 1} : prix invalide.`;
      const quantity = Number(row.quantity);
      if (!Number.isInteger(quantity) || quantity < 0) return `Variante ${i + 1} : quantité invalide.`;
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
            <h2>Photos</h2>
            <p className="muted">De 1 à 12 photos, sur fond clair de préférence.</p>
          </div>
        </div>
        <PhotoUploader photos={photos} onChange={setPhotos} />
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Informations</h2>
        </div>
        <div className="form">
          <label className="field">
            Titre
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
            <span className={`field-hint${title.length > ebayMax ? " field-hint--warn" : ""}`}>
              {title.length}/200 · eBay limite à {ebayMax} caractères : au-delà, ajoutez un titre spécifique dans l&apos;onglet eBay.
            </span>
          </label>
          <label className="field">
            Description
            <textarea className="input textarea" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={5000} rows={6} />
          </label>
          <div className="form-grid">
            <label className="field">
              Marque <span className="field-optional">(facultatif)</span>
              <input className="input" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={100} />
            </label>
            <label className="field">
              État
              <select className="input" value={condition} onChange={(e) => setCondition(e.target.value as Condition)}>
                {Object.entries(CONDITION_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
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
            <h2>Prix et stock</h2>
            <p className="muted">Prix en dollars US. Les prix par canal se règlent dans les onglets des canaux.</p>
          </div>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Type de produit">
          <button type="button" role="radio" aria-checked={mode === "SINGLE"} className="segment" onClick={() => setMode("SINGLE")}>
            <Package size={18} aria-hidden />
            <span>
              <strong>Article unique</strong>
              <small>Quantité 1, ex. pièce d&apos;occasion</small>
            </span>
          </button>
          <button type="button" role="radio" aria-checked={mode === "VARIANTS"} className="segment" onClick={() => setMode("VARIANTS")}>
            <Layers size={18} aria-hidden />
            <span>
              <strong>Variantes</strong>
              <small>Tailles, couleurs… avec stock par variante</small>
            </span>
          </button>
        </div>

        {mode === "SINGLE" ? (
          <div className="form-grid" style={{ marginTop: "1.25rem" }}>
            <label className="field">
              SKU
              <input className="input" value={sku} onChange={(e) => setSku(e.target.value)} required maxLength={50} placeholder="VESTE-001" />
              <span className="field-hint">Référence unique dans votre boutique</span>
            </label>
            <label className="field">
              Prix ($)
              <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="0.00" />
            </label>
            <div className="field">
              Quantité
              <span className="static-value">1 (article unique)</span>
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
        {saved && !error && <Alert kind="success">Fiche enregistrée.</Alert>}
        <button className="btn" disabled={pending}>
          {pending ? "Enregistrement…" : product ? "Enregistrer la fiche" : "Créer le produit"}
        </button>
      </div>
    </form>
  );
}
