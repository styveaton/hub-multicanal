"use client";

import { Check, Mail, Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert } from "../components/Alert";
import { AppShell, initials } from "../components/AppShell";
import { PageLoading } from "../components/PageLoading";
import { useI18n } from "../i18n/I18nProvider";
import { api, type Invitation, type Me } from "../lib/api";

// Droits US1 par rôle (même règle que packages/shared/src/roles.ts).
const RIGHTS = [
  { key: "products", owner: true, employee: true },
  { key: "stock", owner: true, employee: true },
  { key: "orders", owner: true, employee: true },
  { key: "team", owner: true, employee: false },
  { key: "channels", owner: true, employee: false },
  { key: "billing", owner: true, employee: false },
] as const;

function RightsCard({ role }: { role: Me["role"] }) {
  const { t } = useI18n();
  const Mark = ({ ok }: { ok: boolean }) =>
    ok ? <Check size={18} className="yes" aria-label={t.common.yes} /> : <Minus size={18} className="no" aria-label={t.common.no} />;
  return (
    <section className="card" aria-labelledby="rights-title">
      <div className="card-header">
        <div>
          <h2 id="rights-title">{t.team.rightsTitle}</h2>
          <p className="muted">
            {t.team.youAre} <strong>{t.roles[role].toLowerCase()}</strong> {t.team.ofStore}
          </p>
        </div>
      </div>
      <table className="rights">
        <thead>
          <tr>
            <th scope="col">{t.team.access}</th>
            <th scope="col">{t.roles.OWNER}</th>
            <th scope="col">{t.roles.EMPLOYEE}</th>
          </tr>
        </thead>
        <tbody>
          {RIGHTS.map((r) => (
            <tr key={r.key}>
              <th scope="row" style={{ fontWeight: 500 }}>
                {t.team.rights[r.key]}
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

type Message = { kind: "error"; text: string } | { kind: "success"; action: "invited" | "revoked"; email: string };

export default function TeamPage() {
  const router = useRouter();
  const { t, intl } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
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
    setMessage({ kind: "success", action: "invited", email: res.data.email });
    void loadInvitations();
  }

  async function onRevoke(invitation: Invitation) {
    const res = await api(`/invitations/${invitation.id}`, { method: "DELETE" });
    setMessage(res.ok ? { kind: "success", action: "revoked", email: invitation.email } : { kind: "error", text: res.message });
    void loadInvitations();
  }

  async function onLogout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (!me) return <PageLoading />;

  return (
    <AppShell me={me} active="team" onLogout={onLogout}>
      <div className="page-header">
        <h1>{t.team.title}</h1>
        <p className="muted">{canInvite ? t.team.ownerIntro : t.team.employeeIntro(me.organization.name)}</p>
      </div>

      <div className="page-grid">
        {canInvite ? (
          <div style={{ display: "grid", gap: "1.25rem" }}>
            <section className="card" aria-labelledby="invite-title">
              <div className="card-header">
                <div>
                  <h2 id="invite-title">{t.team.inviteTitle}</h2>
                  <p className="muted">{t.team.inviteHint}</p>
                </div>
              </div>
              <form className="form" onSubmit={onInvite}>
                <div className="form-row">
                  <label className="field">
                    {t.team.inviteEmail}
                    <input className="input" name="email" type="email" required placeholder={t.team.invitePlaceholder} />
                  </label>
                  <button className="btn" disabled={pending}>
                    <Plus size={18} aria-hidden /> {pending ? t.team.invitePending : t.team.invite}
                  </button>
                </div>
                {message && (
                  <Alert kind={message.kind}>
                    {message.kind === "error" ? message.text : t.team[message.action](message.email)}
                  </Alert>
                )}
              </form>
            </section>

            <section className="card" aria-labelledby="pending-title">
              <div className="card-header">
                <h2 id="pending-title">{t.team.pendingTitle}</h2>
                <span className="badge">{invitations.length}</span>
              </div>
              {invitations.length === 0 ? (
                <p className="empty">{t.team.noPending}</p>
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
                          {t.roles[inv.role]} · {t.team.expires(new Date(inv.expiresAt).toLocaleDateString(intl))}
                        </small>
                      </span>
                      <button className="btn btn--danger-ghost" onClick={() => onRevoke(inv)}>
                        {t.common.cancel}
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
              <span className="badge badge--employee">{t.roles[me.role]}</span>
            </div>
          </section>
        )}

        <RightsCard role={me.role} />
      </div>
    </AppShell>
  );
}
