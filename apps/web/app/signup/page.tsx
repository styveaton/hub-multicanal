"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, type Me } from "../lib/api";

export default function SignupPage() {
  const router = useRouter();
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
    setPending(false);
    if (res.ok) router.push("/team");
    else setError(res.message);
  }

  return (
    <main>
      <h1>Créer un compte</h1>
      <p className="muted">Vous serez propriétaire de la boutique et pourrez inviter vos employés.</p>
      <form onSubmit={onSubmit}>
        <label>
          Votre nom
          <input name="name" required autoComplete="name" />
        </label>
        <label>
          Nom de la boutique
          <input name="organizationName" required autoComplete="organization" />
        </label>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Mot de passe (8 caractères minimum)
          <input name="password" type="password" required minLength={8} autoComplete="new-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={pending}>{pending ? "Création…" : "Créer mon compte"}</button>
      </form>
      <p>
        Déjà un compte ? <Link href="/login">Se connecter</Link>
      </p>
    </main>
  );
}
