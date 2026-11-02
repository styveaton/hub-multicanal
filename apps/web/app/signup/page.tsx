"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "../components/Alert";
import { AuthLayout } from "../components/AuthLayout";
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
    if (res.ok) router.push("/products");
    else setError(res.message);
  }

  return (
    <AuthLayout
      title="Créer votre compte"
      subtitle="Vous serez propriétaire de la boutique et pourrez inviter vos employés."
      footer={
        <>
          Déjà un compte ? <Link href="/login">Se connecter</Link>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          Votre nom
          <input className="input" name="name" required autoComplete="name" />
        </label>
        <label className="field">
          Nom de la boutique
          <input className="input" name="organizationName" required autoComplete="organization" />
        </label>
        <label className="field">
          Email
          <input className="input" name="email" type="email" required autoComplete="email" />
        </label>
        <label className="field">
          Mot de passe
          <input className="input" name="password" type="password" required minLength={8} autoComplete="new-password" />
          <span className="field-hint">8 caractères minimum</span>
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn btn--block" disabled={pending}>
          {pending ? "Création…" : "Créer mon compte"}
        </button>
      </form>
    </AuthLayout>
  );
}
