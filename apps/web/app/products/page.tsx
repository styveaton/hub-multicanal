"use client";

import Link from "next/link";
import { AlertTriangle, ImageOff, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { CHANNEL_LABEL, formatMoney } from "@hub/shared";
import { AppShell } from "../components/AppShell";
import { useSession } from "../components/useSession";
import { api, type ProductListItem } from "../lib/api";

interface ProductList {
  total: number;
  items: ProductListItem[];
}

const priceLabel = (p: ProductListItem) =>
  p.priceRange.minCents === p.priceRange.maxCents
    ? formatMoney(p.priceRange.minCents, p.currency)
    : `${formatMoney(p.priceRange.minCents, p.currency)} – ${formatMoney(p.priceRange.maxCents, p.currency)}`;

export default function ProductsPage() {
  const { me, logout } = useSession();
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ProductList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    // Petite attente pour ne pas appeler l'API à chaque frappe.
    const timer = setTimeout(async () => {
      const res = await api<ProductList>(`/products${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`);
      if (res.ok) setList(res.data);
      else setError(res.message);
    }, 200);
    return () => clearTimeout(timer);
  }, [me, query]);

  if (!me) return <div className="loading">Chargement…</div>;

  return (
    <AppShell me={me} active="products" onLogout={logout}>
      <div className="page-header page-header--actions">
        <div>
          <h1>Produits</h1>
          <p className="muted">Une fiche maître par produit, adaptée ensuite à chaque canal.</p>
        </div>
        <Link href="/products/new" className="btn">
          <Plus size={18} aria-hidden /> Nouveau produit
        </Link>
      </div>

      <div className="toolbar">
        <label className="search">
          <Search size={18} aria-hidden />
          <input
            className="input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher par titre ou SKU"
            aria-label="Rechercher un produit"
          />
        </label>
        {list && <span className="muted">{list.total} produit{list.total > 1 ? "s" : ""}</span>}
      </div>

      {error && <p className="field-error">{error}</p>}

      {list && list.items.length === 0 ? (
        <div className="card empty-state">
          <h2>{query ? "Aucun produit trouvé" : "Aucun produit pour l'instant"}</h2>
          <p className="muted">{query ? "Essayez un autre titre ou SKU." : "Créez votre première fiche maître : photos, prix, variantes."}</p>
          {!query && (
            <Link href="/products/new" className="btn">
              <Plus size={18} aria-hidden /> Créer un produit
            </Link>
          )}
        </div>
      ) : (
        <ul className="product-list">
          {list?.items.map((p) => (
            <li key={p.id}>
              <Link href={`/products/${p.id}`} className="product-row">
                <span className="product-thumb">
                  {p.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api${p.photoUrl}`} alt="" />
                  ) : (
                    <ImageOff size={20} aria-hidden />
                  )}
                </span>
                <span className="product-main">
                  <strong>{p.title}</strong>
                  <small>{p.mode === "SINGLE" ? `SKU ${p.sku} · article unique` : `${p.variantCount} variante${p.variantCount > 1 ? "s" : ""}`}</small>
                </span>
                <span className="product-price">{priceLabel(p)}</span>
                <span className="product-stock">
                  <strong>{p.quantity}</strong>
                  <small>en stock</small>
                </span>
                <span className="product-channels">
                  {p.channels.length === 0 ? (
                    <span className="badge">Aucun canal</span>
                  ) : (
                    p.channels.map((c) => (
                      <span key={c} className="badge badge--channel">
                        {CHANNEL_LABEL[c]}
                      </span>
                    ))
                  )}
                  {p.warningCount > 0 && (
                    <span className="badge badge--warn" title="Réglages à compléter pour certains canaux">
                      <AlertTriangle size={12} aria-hidden /> {p.warningCount}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
