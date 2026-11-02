"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { ProductForm } from "../../components/products/ProductForm";
import { useSession } from "../../components/useSession";

export default function NewProductPage() {
  const router = useRouter();
  const { me, logout } = useSession();
  if (!me) return <div className="loading">Chargement…</div>;

  return (
    <AppShell me={me} active="products" onLogout={logout}>
      <Link href="/products" className="back-link">
        <ArrowLeft size={16} aria-hidden /> Produits
      </Link>
      <div className="page-header">
        <h1>Nouveau produit</h1>
        <p className="muted">Créez la fiche maître. Vous l&apos;adapterez ensuite à chaque canal.</p>
      </div>
      <ProductForm onSaved={(p) => router.push(`/products/${p.id}?created=1`)} />
    </AppShell>
  );
}
