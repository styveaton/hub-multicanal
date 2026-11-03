"use client";

import Link from "next/link";
import { AlertTriangle, ArrowLeft, Trash2 } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { Channel } from "@hub/shared";
import { Alert } from "../../components/Alert";
import { AppShell } from "../../components/AppShell";
import { ChannelPanel } from "../../components/products/ChannelPanel";
import { ProductForm } from "../../components/products/ProductForm";
import { PageLoading } from "../../components/PageLoading";
import { useSession } from "../../components/useSession";
import { useI18n } from "../../i18n/I18nProvider";
import { api, type ChannelSettings, type ProductDetail } from "../../lib/api";

type Tab = "master" | Channel;

function ProductEditor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const justCreated = useSearchParams().get("created") === "1";
  const { me, logout } = useSession();
  const { t } = useI18n();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("master");

  useEffect(() => {
    if (!me) return;
    api<ProductDetail>(`/products/${id}`).then((res) => (res.ok ? setProduct(res.data) : setError(res.message)));
  }, [me, id]);

  function onChannelSaved(updated: ChannelSettings) {
    setProduct((p) => (p ? { ...p, channels: p.channels.map((c) => (c.channel === updated.channel ? updated : c)) } : p));
  }

  async function onDelete() {
    if (!product || !window.confirm(t.productPage.confirmDelete(product.title))) return;
    const res = await api(`/products/${product.id}`, { method: "DELETE" });
    if (res.ok) router.replace("/products");
    else setError(res.message);
  }

  if (!me) return <PageLoading />;

  return (
    <AppShell me={me} active="products" onLogout={logout}>
      <Link href="/products" className="back-link">
        <ArrowLeft size={16} aria-hidden /> {t.products.title}
      </Link>

      {error && <Alert kind="error">{error}</Alert>}
      {!product && !error && <p className="muted">{t.common.loading}</p>}

      {product && (
        <>
          <div className="page-header page-header--actions">
            <div>
              <h1>{product.title}</h1>
              <p className="muted">
                {product.mode === "SINGLE"
                  ? t.products.singleItem(product.sku ?? "")
                  : t.products.variantsInStock(product.variants.length, product.quantity)}
              </p>
            </div>
            <button type="button" className="btn btn--danger-ghost" onClick={onDelete}>
              <Trash2 size={16} aria-hidden /> {t.productPage.delete}
            </button>
          </div>

          {justCreated && tab === "master" && (
            <div style={{ marginBottom: "1.25rem" }}>
              <Alert kind="success">{t.productPage.created}</Alert>
            </div>
          )}

          <div className="tabs" role="tablist" aria-label={t.productPage.tabsLabel}>
            <button type="button" role="tab" aria-selected={tab === "master"} className="tab" onClick={() => setTab("master")}>
              {t.productPage.master}
            </button>
            {product.channels.map((c) => (
              <button
                key={c.channel}
                type="button"
                role="tab"
                aria-selected={tab === c.channel}
                className={`tab${c.enabled ? "" : " tab--off"}`}
                onClick={() => setTab(c.channel)}
              >
                {c.label}
                {c.enabled && c.warnings.length > 0 && <AlertTriangle size={14} className="tab-warn" aria-label={t.productPage.toComplete} />}
                {!c.enabled && <span className="tab-state">{t.productPage.disabled}</span>}
              </button>
            ))}
          </div>

          <div role="tabpanel">
            {tab === "master" ? (
              <ProductForm key={product.updatedAt} product={product} onSaved={setProduct} />
            ) : (
              <ChannelPanel
                key={`${tab}-${product.updatedAt}`}
                product={product}
                settings={product.channels.find((c) => c.channel === tab)!}
                onSaved={onChannelSaved}
              />
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}

export default function ProductPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ProductEditor />
    </Suspense>
  );
}
