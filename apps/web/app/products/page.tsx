"use client";

import Link from "next/link";
import { AlertTriangle, ImageOff, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { CHANNEL_LABEL, formatMoney } from "@hub/shared";
import { AppShell } from "../components/AppShell";
import { PageLoading } from "../components/PageLoading";
import { useSession } from "../components/useSession";
import { useI18n } from "../i18n/I18nProvider";
import { api, type ProductListItem } from "../lib/api";

interface ProductList {
  total: number;
  items: ProductListItem[];
}

const priceLabel = (p: ProductListItem, intl: string) =>
  p.priceRange.minCents === p.priceRange.maxCents
    ? formatMoney(p.priceRange.minCents, p.currency, intl)
    : `${formatMoney(p.priceRange.minCents, p.currency, intl)} – ${formatMoney(p.priceRange.maxCents, p.currency, intl)}`;

export default function ProductsPage() {
  const { me, logout } = useSession();
  const { t, intl } = useI18n();
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

  if (!me) return <PageLoading />;

  return (
    <AppShell me={me} active="products" onLogout={logout}>
      <div className="page-header page-header--actions">
        <div>
          <h1>{t.products.title}</h1>
          <p className="muted">{t.products.intro}</p>
        </div>
        <Link href="/products/new" className="btn">
          <Plus size={18} aria-hidden /> {t.products.new}
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
            placeholder={t.products.searchPlaceholder}
            aria-label={t.products.searchLabel}
          />
        </label>
        {list && <span className="muted">{t.products.count(list.total)}</span>}
      </div>

      {error && <p className="field-error">{error}</p>}

      {list && list.items.length === 0 ? (
        <div className="card empty-state">
          <h2>{query ? t.products.noResult : t.products.empty}</h2>
          <p className="muted">{query ? t.products.noResultHint : t.products.emptyHint}</p>
          {!query && (
            <Link href="/products/new" className="btn">
              <Plus size={18} aria-hidden /> {t.products.create}
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
                  <small>{p.mode === "SINGLE" ? t.products.singleItem(p.sku ?? "") : t.products.variantCount(p.variantCount)}</small>
                </span>
                <span className="product-price">{priceLabel(p, intl)}</span>
                <span className="product-stock">
                  <strong>{p.quantity}</strong>
                  <small>{t.products.inStock}</small>
                </span>
                <span className="product-channels">
                  {p.channels.length === 0 ? (
                    <span className="badge">{t.products.noChannel}</span>
                  ) : (
                    p.channels.map((c) => (
                      <span key={c} className="badge badge--channel">
                        {CHANNEL_LABEL[c]}
                      </span>
                    ))
                  )}
                  {p.warningCount > 0 && (
                    <span className="badge badge--warn" title={t.products.warningsTitle}>
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
