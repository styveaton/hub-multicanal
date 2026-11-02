"use client";

import { Check, Mail, Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert } from "../components/Alert";
import { AppShell, ROLE_LABEL, initials } from "../components/AppShell";
import { api, type Invitation, type Me } from "../lib/api";

// Droits US1 par rôle (même règle que packages/shared/src/roles.ts).
const RIGHTS: Array<{ label: string; owner: boolean; employee: boolean }> = [
  { label: "Produits et annonces", owner: true, employee: true },
  { label: "Stock", owner: true, employee: true },
  { label: "Commandes (consultation)", owner: true, employee: true },
  { label: "Équipe et invitations", owner: true, employee: false },
  { label: "Connexion des canaux", owner: true, employee: false },
  { label: "Abonnement", owner: true, employee: false },
];

function RightsCard({ role }: { role: Me["role"] }) {
  const Mark = ({ ok }: { ok: boolean }) =>
    ok ? <Check size={18} className="yes" aria-label="Oui" /> : <Minus size={18} className="no" aria-label="Non" />;
  return (
    <section className="card" aria-labelledby="rights-title">
      <div className="card-header">
        <div>
          <h2 id="rights-title">Rôles et droits</h2>
          <p className="muted">
            Vous êtes <strong>{ROLE_LABEL[role].toLowerCase()}</strong> de cette boutique.
          </p>
        </div>
      </div>
      <table className="rights">
        <thead>
          <tr>
            <th scope="col">Accès</th>
            <th scope="col">Propriétaire</th>
            <th scope="col">Employé</th>
          </tr>
        </thead>
        <tbody>
          {RIGHTS.map((r) => (
            <tr key={r.label}>
              <th scope="row" style={{ fontWeight: 500 }}>
                {r.label}
              </th>
              <td>
                <Mark ok={r.owner} />
              </td>
              <td>
                <Mark ok={r.employee} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function TeamPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
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
    setMessage({ kind: "success", text: `Invitation envoyée à ${res.data.email}.` });
    void loadInvitations();
  }

  async function onRevoke(invitation: Invitation) {
    const res = await api(`/invitations/${invitation.id}`, { method: "DELETE" });
    setMessage(
      res.ok
        ? { kind: "success", text: `Invitation de ${invitation.email} annulée.` }
        : { kind: "error", text: res.message },
    );
    void loadInvitations();
  }

  async function onLogout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (!me) return <div className="loading">Chargement…</div>;

  return (
    <AppShell me={me} active="team" onLogout={onLogout}>
      <div className="page-header">
        <h1>Équipe</h1>
        <p className="muted">
          {canInvite
            ? "Invitez vos employés : ils gèrent les annonces et le stock, vous gardez la main sur l'abonnement et les canaux."
            : `Vous faites partie de l'équipe de ${me.organization.name}. L'abonnement, les canaux et l'équipe sont gérés par le propriétaire.`}
        </p>
      </div>

      <div className="page-grid">
        {canInvite ? (
          <div style={{ display: "grid", gap: "1.25rem" }}>
            <section className="card" aria-labelledby="invite-title">
              <div className="card-header">
                <div>
                  <h2 id="invite-title">Inviter un employé</h2>
                  <p className="muted">Un email avec un lien valable 7 jours lui sera envoyé.</p>
                </div>
              </div>
              <form className="form" onSubmit={onInvite}>
                <div className="form-row">
                  <label className="field">
                    Email de l&apos;employé
                    <input className="input" name="email" type="email" required placeholder="prenom@boutique.fr" />
                  </label>
                  <button className="btn" disabled={pending}>
                    <Plus size={18} aria-hidden /> {pending ? "Envoi…" : "Inviter"}
                  </button>
                </div>
                {message && <Alert kind={message.kind}>{message.text}</Alert>}
              </form>
            </section>

            <section className="card" aria-labelledby="pending-title">
              <div className="card-header">
                <h2 id="pending-title">Invitations en attente</h2>
                <span className="badge">{invitations.length}</span>
              </div>
              {invitations.length === 0 ? (
                <p className="empty">Aucune invitation en attente.</p>
              ) : (
                <ul className="list">
                  {invitations.map((inv) => (
                    <li key={inv.id} className="list-item">
                      <span className="avatar avatar--light" aria-hidden>
                        <Mail size={16} />
                      </span>
                      <span className="list-item-body">
                        <strong>{inv.email}</strong>
                        <small>
                          {ROLE_LABEL[inv.role]} · expire le {new Date(inv.expiresAt).toLocaleDateString("fr-FR")}
                        </small>
                      </span>
                      <button className="btn btn--danger-ghost" onClick={() => onRevoke(inv)}>
                        Annuler
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : (
          <section className="card" aria-labelledby="me-title">
            <div className="list-item" style={{ padding: 0 }}>
              <span className="avatar" aria-hidden>
                {initials(me.user.name ?? me.user.email)}
              </span>
              <span className="list-item-body">
                <strong id="me-title">{me.user.name ?? me.user.email}</strong>
                <small>{me.user.email}</small>
              </span>
              <span className="badge badge--employee">{ROLE_LABEL[me.role]}</span>
            </div>
          </section>
        )}

        <RightsCard role={me.role} />
      </div>
    </AppShell>
  );
}
