"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) return setError("Lien d'invitation incomplet.");
    api<Preview>("/invitations/preview", { method: "POST", body: { token } }).then((res) => {
      if (res.ok) setPreview(res.data);
      else setError(res.message);
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
    if (res.ok) router.push("/team");
    else setError(res.message);
  }

  if (!preview) {
    return <main>{error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>}</main>;
  }

  return (
    <main>
      <h1>Rejoindre {preview.organizationName}</h1>
      <p className="muted">Invitation pour {preview.email}</p>
      <form onSubmit={onSubmit}>
        {!preview.userExists && (
          <label>
            Votre nom
            <input name="name" required autoComplete="name" />
          </label>
        )}
        <label>
          {preview.userExists ? "Votre mot de passe actuel" : "Choisissez un mot de passe (8 caractères minimum)"}
          <input
            name="password"
            type="password"
            required
            minLength={preview.userExists ? undefined : 8}
            autoComplete={preview.userExists ? "current-password" : "new-password"}
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={pending}>{pending ? "Validation…" : "Accepter l'invitation"}</button>
      </form>
    </main>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<main className="muted">Chargement…</main>}>
      <AcceptInvitation />
    </Suspense>
  );
}
