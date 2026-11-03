"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { Alert } from "../../components/Alert";
import { AuthLayout } from "../../components/AuthLayout";
import { PageLoading } from "../../components/PageLoading";
import { useI18n } from "../../i18n/I18nProvider";
import { api, type Me } from "../../lib/api";

interface Preview {
  email: string;
  organizationName: string;
  userExists: boolean;
}

function AcceptInvitation() {
  const router = useRouter();
  const { t } = useI18n();
  const token = useSearchParams().get("token") ?? "";
  const [preview, setPreview] = useState<Preview | null>(null);
  // Code d'erreur (traduit à l'affichage, pour suivre un changement de langue).
  const [loadError, setLoadError] = useState<{ message: string } | "incomplete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) return setLoadError("incomplete");
    api<Preview>("/invitations/preview", { method: "POST", body: { token } }).then((res) => {
      if (res.ok) setPreview(res.data);
      else setLoadError({ message: res.message });
    });
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const res = await api<Me>("/invitations/accept", {
      method: "POST",
      body: { token, name: form.get("name") ?? undefined, password: form.get("password") },
    });
    setPending(false);
    if (res.ok) router.push("/products");
    else setError(res.message);
  }

  if (loadError) {
    return (
      <AuthLayout title={t.accept.unavailable} footer={<Link href="/login">{t.accept.goToLogin}</Link>}>
        <div style={{ marginTop: "1.25rem" }}>
          <Alert kind="error">{loadError === "incomplete" ? t.accept.incompleteLink : loadError.message}</Alert>
        </div>
      </AuthLayout>
    );
  }

  if (!preview) {
    return (
      <AuthLayout title={t.accept.loadingTitle}>
        <p className="muted" style={{ marginTop: "1rem" }}>
          {t.common.loading}
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t.accept.join(preview.organizationName)}
      subtitle={preview.userExists ? t.accept.existingUser(preview.email) : t.accept.newUser(preview.email)}
    >
      <form className="form" onSubmit={onSubmit}>
        {!preview.userExists && (
          <label className="field">
            {t.common.yourName}
            <input className="input" name="name" required autoComplete="name" />
          </label>
        )}
        <label className="field">
          {preview.userExists ? t.accept.currentPassword : t.accept.choosePassword}
          <input
            className="input"
            name="password"
            type="password"
            required
            minLength={preview.userExists ? undefined : 8}
            autoComplete={preview.userExists ? "current-password" : "new-password"}
          />
          {!preview.userExists && <span className="field-hint">{t.common.minPassword}</span>}
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn btn--block" disabled={pending}>
          {pending ? t.accept.pending : t.accept.submit}
        </button>
      </form>
    </AuthLayout>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AcceptInvitation />
    </Suspense>
  );
}
