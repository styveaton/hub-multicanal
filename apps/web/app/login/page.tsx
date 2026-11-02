"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
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
    if (res.ok) router.push("/team");
    else setError(res.message);
  }

  return (
    <main>
      <h1>Se connecter</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Mot de passe
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={pending}>{pending ? "Connexion…" : "Se connecter"}</button>
      </form>
      <p>
        Pas encore de compte ? <Link href="/signup">Créer un compte</Link>
      </p>
    </main>
  );
}
