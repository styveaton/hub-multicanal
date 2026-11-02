"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { Alert } from "../../components/Alert";
import { AuthLayout } from "../../components/AuthLayout";
import { api, type Me } from "../../lib/api";

interface Preview {
  email: string;
  organizationName: string;
  userExists: boolean;
}

function AcceptInvitation() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) return setLoadError("Ce lien d'invitation est incomplet.");
    api<Preview>("/invitations/preview", { method: "POST", body: { token } }).then((res) => {
      if (res.ok) setPreview(res.data);
      else setLoadError(res.message);
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
      <AuthLayout title="Invitation indisponible" footer={<Link href="/login">Aller à la connexion</Link>}>
        <div style={{ marginTop: "1.25rem" }}>
          <Alert kind="error">{loadError}</Alert>
        </div>
      </AuthLayout>
    );
  }

  if (!preview) {
    return (
      <AuthLayout title="Invitation">
        <p className="muted" style={{ marginTop: "1rem" }}>
          Chargement…
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={`Rejoindre ${preview.organizationName}`}
      subtitle={
        preview.userExists
          ? `Vous avez déjà un compte OmniList (${preview.email}). Confirmez avec votre mot de passe.`
          : `Créez votre accès employé pour ${preview.email}.`
      }
    >
      <form className="form" onSubmit={onSubmit}>
        {!preview.userExists && (
          <label className="field">
            Votre nom
            <input className="input" name="name" required autoComplete="name" />
          </label>
        )}
        <label className="field">
          {preview.userExists ? "Mot de passe actuel" : "Choisissez un mot de passe"}
          <input
            className="input"
            name="password"
            type="password"
            required
            minLength={preview.userExists ? undefined : 8}
            autoComplete={preview.userExists ? "current-password" : "new-password"}
          />
          {!preview.userExists && <span className="field-hint">8 caractères minimum</span>}
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn btn--block" disabled={pending}>
          {pending ? "Validation…" : "Accepter l'invitation"}
        </button>
      </form>
    </AuthLayout>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<div className="loading">Chargement…</div>}>
      <AcceptInvitation />
    </Suspense>
  );
}
