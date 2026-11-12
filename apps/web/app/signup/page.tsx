"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "../components/Alert";
import { AuthLayout } from "../components/AuthLayout";
import { useI18n } from "../i18n/I18nProvider";
import { api, type Me } from "../lib/api";

export default function SignupPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const res = await api<Me>("/auth/signup", {
      method: "POST",
      body: {
        name: form.get("name"),
        organizationName: form.get("organizationName"),
        email: form.get("email"),
        password: form.get("password"),
      },
    });
    // Succès : le bouton reste « en cours » jusqu'à l'arrivée sur Produits (pas de double clic).
    if (res.ok) return router.push("/products");
    setPending(false);
    setError(res.message);
  }

  return (
    <AuthLayout
      title={t.signup.title}
      subtitle={t.signup.subtitle}
      footer={
        <>
          {t.signup.haveAccount} <Link href="/login">{t.signup.loginLink}</Link>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          {t.common.yourName}
          <input className="input" name="name" required autoComplete="name" />
        </label>
        <label className="field">
          {t.signup.storeName}
          <input className="input" name="organizationName" required autoComplete="organization" />
        </label>
        <label className="field">
          {t.common.email}
          <input className="input" name="email" type="email" required autoComplete="email" />
        </label>
        <label className="field">
          {t.common.password}
          <input className="input" name="password" type="password" required minLength={8} autoComplete="new-password" />
          <span className="field-hint">{t.common.minPassword}</span>
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn btn--block" disabled={pending}>
          {pending ? t.signup.pending : t.signup.submit}
        </button>
      </form>
    </AuthLayout>
  );
}
