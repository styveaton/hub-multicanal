"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "../components/Alert";
import { AuthLayout } from "../components/AuthLayout";
import { api, type Me } from "../lib/api";

export default function LoginPage() {
  const router = useRouter();
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
      title="Bon retour"
      subtitle="Connectez-vous pour gérer vos annonces et votre stock."
      footer={
        <>
          Pas encore de compte ? <Link href="/signup">Créer un compte</Link>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          Email
          <input className="input" name="email" type="email" required autoComplete="email" />
        </label>
        <label className="field">
          Mot de passe
          <input className="input" name="password" type="password" required autoComplete="current-password" />
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn btn--block" disabled={pending}>
          {pending ? "Connexion…" : "Se connecter"}
        </button>
      </form>
    </AuthLayout>
  );
}
