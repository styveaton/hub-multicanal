"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { PageLoading } from "../../components/PageLoading";
import { ProductForm } from "../../components/products/ProductForm";
import { useSession } from "../../components/useSession";
import { useI18n } from "../../i18n/I18nProvider";

export default function NewProductPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { me, logout } = useSession();
  if (!me) return <PageLoading />;

  return (
    <AppShell me={me} active="products" onLogout={logout}>
      <Link href="/products" className="back-link">
        <ArrowLeft size={16} aria-hidden /> {t.products.title}
      </Link>
      <div className="page-header">
        <h1>{t.newProduct.title}</h1>
        <p className="muted">{t.newProduct.intro}</p>
      </div>
      <ProductForm onSaved={(p) => router.push(`/products/${p.id}?created=1`)} />
    </AppShell>
  );
}
