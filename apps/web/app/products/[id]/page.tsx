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
import { useSession } from "../../components/useSession";
import { api, type ChannelSettings, type ProductDetail } from "../../lib/api";

type Tab = "master" | Channel;

function ProductEditor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const justCreated = useSearchParams().get("created") === "1";
  const { me, logout } = useSession();
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
    if (!product || !window.confirm(`Supprimer « ${product.title} » et ses photos ? Cette action est définitive.`)) return;
    const res = await api(`/products/${product.id}`, { method: "DELETE" });
    if (res.ok) router.replace("/products");
    else setError(res.message);
  }

  if (!me) return <div className="loading">Chargement…</div>;

  return (
    <AppShell me={me} active="products" onLogout={logout}>
      <Link href="/products" className="back-link">
        <ArrowLeft size={16} aria-hidden /> Produits
      </Link>

      {error && <Alert kind="error">{error}</Alert>}
      {!product && !error && <p className="muted">Chargement…</p>}

      {product && (
        <>
          <div className="page-header page-header--actions">
            <div>
              <h1>{product.title}</h1>
              <p className="muted">
                {product.mode === "SINGLE" ? `SKU ${product.sku} · article unique` : `${product.variants.length} variantes · ${product.quantity} en stock`}
              </p>
            </div>
            <button type="button" className="btn btn--danger-ghost" onClick={onDelete}>
              <Trash2 size={16} aria-hidden /> Supprimer
            </button>
          </div>

          {justCreated && tab === "master" && (
            <div style={{ marginBottom: "1.25rem" }}>
              <Alert kind="success">Produit créé. Ajustez maintenant le titre, la catégorie et le prix pour chaque canal.</Alert>
            </div>
          )}

          <div className="tabs" role="tablist" aria-label="Fiche produit">
            <button type="button" role="tab" aria-selected={tab === "master"} className="tab" onClick={() => setTab("master")}>
              Fiche maître
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
                {c.enabled && c.warnings.length > 0 && <AlertTriangle size={14} className="tab-warn" aria-label="Réglages à compléter" />}
                {!c.enabled && <span className="tab-state">désactivé</span>}
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
    <Suspense fallback={<div className="loading">Chargement…</div>}>
      <ProductEditor />
    </Suspense>
  );
}
