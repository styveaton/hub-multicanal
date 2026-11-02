"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Invitation, type Me } from "../lib/api";

const ROLE_LABEL = { OWNER: "Propriétaire", EMPLOYEE: "Employé" } as const;

export default function TeamPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const canInvite = me?.permissions.includes("members:invite") ?? false;

  const loadInvitations = useCallback(async () => {
    const res = await api<Invitation[]>("/invitations");
    if (res.ok) setInvitations(res.data);
  }, []);

  useEffect(() => {
    api<Me>("/auth/me").then((res) => {
      if (!res.ok) return router.replace("/login");
      setMe(res.data);
      if (res.data.permissions.includes("members:invite")) void loadInvitations();
    });
  }, [router, loadInvitations]);

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const email = String(new FormData(formEl).get("email"));
    setPending(true);
    setMessage(null);
    const res = await api<Invitation>("/invitations", { method: "POST", body: { email } });
    setPending(false);
    if (!res.ok) return setMessage({ kind: "error", text: res.message });
    formEl.reset();
    setMessage({ kind: "ok", text: `Invitation envoyée à ${res.data.email}.` });
    void loadInvitations();
  }

  async function onRevoke(id: string) {
    const res = await api(`/invitations/${id}`, { method: "DELETE" });
    if (!res.ok) setMessage({ kind: "error", text: res.message });
    void loadInvitations();
  }

  async function onLogout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (!me) return <main className="muted">Chargement…</main>;

  return (
    <main>
      <h1>{me.organization.name}</h1>
      <p className="muted">
        Connecté en tant que {me.user.name ?? me.user.email} · {ROLE_LABEL[me.role]}
      </p>

      {canInvite ? (
        <>
          <h2>Inviter un employé</h2>
          <form onSubmit={onInvite} className="row">
            <label>
              Email
              <input name="email" type="email" required placeholder="employe@exemple.fr" />
            </label>
            <button disabled={pending}>{pending ? "Envoi…" : "Inviter"}</button>
          </form>
          {message && (
            <p className={message.kind === "error" ? "error" : "muted"} role="status">
              {message.text}
            </p>
          )}

          <h2>Invitations en attente</h2>
          {invitations.length === 0 ? (
            <p className="muted">Aucune invitation en attente.</p>
          ) : (
            <ul className="list">
              {invitations.map((inv) => (
                <li key={inv.id}>
                  <span>
                    {inv.email}
                    <br />
                    <small className="muted">
                      Expire le {new Date(inv.expiresAt).toLocaleDateString("fr-FR")}
                    </small>
                  </span>
                  <button className="secondary" onClick={() => onRevoke(inv.id)}>
                    Annuler
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted">
          En tant qu&apos;employé, vous gérez les produits et le stock. L&apos;abonnement, les canaux de vente et
          l&apos;équipe sont gérés par le propriétaire.
        </p>
      )}

      <p>
        <button className="secondary" onClick={onLogout}>
          Se déconnecter
        </button>
      </p>
    </main>
  );
}
