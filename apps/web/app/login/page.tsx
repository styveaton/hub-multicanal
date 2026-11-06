"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "../components/Alert";
import { AuthLayout } from "../components/AuthLayout";
import { useI18n } from "../i18n/I18nProvider";
import { api, type Me } from "../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const res = await api<Me>("/auth/login", {
      method: "POST",
      body: { email: form.get("email"), password: form.get("password") },
    });
    setPending(false);
    if (res.ok) router.push("/products");
    else setError(res.message);
  }

  return (
    <AuthLayout
      title={t.login.title}
      subtitle={t.login.subtitle}
      footer={
        <>
          {t.login.noAccount} <Link href="/signup">{t.login.signupLink}</Link>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          {t.common.email}
          <input className="input" name="email" type="email" required autoComplete="email" />
        </label>
        <label className="field">
          {t.common.password}
          <input className="input" name="password" type="password" required autoComplete="current-password" />
        </label>
        <Link href="/forgot-password" className="auth-forgot">
          {t.login.forgot}
        </Link>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn btn--block" disabled={pending}>
          {pending ? t.login.pending : t.login.submit}
        </button>
      </form>
    </AuthLayout>
  );
}
