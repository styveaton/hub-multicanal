"use client";

import { AlertTriangle, CheckCircle2, ExternalLink, Plug, Puzzle, Store } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { US_STATES } from "@hub/shared";
import { Alert } from "../components/Alert";
import { AppShell } from "../components/AppShell";
import { PageLoading } from "../components/PageLoading";
import { useSession } from "../components/useSession";
import { useI18n } from "../i18n/I18nProvider";
import { api, type ChannelOverview } from "../lib/api";

type Notice = { kind: "success" | "error"; text: string } | null;

/** Carte d'un canal branché (Depop, Shopify, WooCommerce) : connexion, réglages, déconnexion. */
function ConnectedChannelCard({ item, canManage, onChanged }: { item: ChannelOverview; canManage: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const p = t.channelsPage;
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [state, setState] = useState(item.connection?.settings.shipFromState ?? "");
  const c = item.connection;
  const isDepop = item.channel === "DEPOP";
  const isShopify = item.channel === "SHOPIFY";
  const isWoo = item.channel === "WOOCOMMERCE";
  const [shop, setShop] = useState(c?.account ?? "");
  const [woo, setWoo] = useState({ storeUrl: c?.account ?? "", consumerKey: "", consumerSecret: "" });
  const showConnect = canManage && (!c || c.status === "NEEDS_REAUTH");

  /** Depop et Shopify : page d'accord du canal. WooCommerce : clés vérifiées tout de suite. */
  async function connect(event?: FormEvent) {
    event?.preventDefault();
    setPending(true);
    setNotice(null);
    const body = isShopify ? { shop } : isWoo ? woo : undefined;
    const res = await api<{ url?: string; connected?: boolean }>(`/channels/${item.channel.toLowerCase()}/connect`, { method: "POST", body });
    if (!res.ok) {
      setPending(false);
      return setNotice({ kind: "error", text: res.message });
    }
    if (res.data.url) return window.location.assign(res.data.url);
    setPending(false);
    setWoo((w) => ({ ...w, consumerKey: "", consumerSecret: "" }));
    setNotice({ kind: "success", text: p.connected(item.label) });
    onChanged();
  }

  async function saveState(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const res = await api(`/channels/${item.channel.toLowerCase()}/settings`, { method: "PUT", body: { shipFromState: state } });
    setNotice(res.ok ? { kind: "success", text: p.saved } : { kind: "error", text: res.message });
    if (res.ok) onChanged();
  }

  async function disconnect() {
    if (!window.confirm(p.disconnectConfirm(item.label))) return;
    const res = await api(`/channels/${item.channel.toLowerCase()}`, { method: "DELETE" });
    if (!res.ok) return setNotice({ kind: "error", text: res.message });
    onChanged();
  }

  return (
    <section className="card channel-card channel-card--live" aria-labelledby={`ch-${item.channel}`}>
      <div className="card-header">
        <div className="channel-card-title">
          <span className="channel-logo" aria-hidden>
            <Store size={20} />
          </span>
          <div>
            <h2 id={`ch-${item.channel}`}>{item.label}</h2>
            <span className="badge badge--channel">{p.api}</span>
          </div>
        </div>
        {c?.status === "CONNECTED" && (
          <span className="badge badge--ok">
            <CheckCircle2 size={14} aria-hidden /> {isDepop && c.username ? p.connectedAs(c.username) : c.username ? p.connectedShop(c.username) : p.connected(item.label)}
          </span>
        )}
      </div>

      {item.testMode && item.available && <p className="note note--info">{p.testMode}</p>}
      {!item.available && <p className="note">{p.unavailable(item.label)}</p>}
      {c?.account && <p className="muted channel-account">{p.connectedTo(c.account)}</p>}
      {c?.status === "NEEDS_REAUTH" && (
        <p className="note note--warn">
          <AlertTriangle size={16} aria-hidden /> {p.needsReauth}
        </p>
      )}

      {isDepop && c && (
        <form className="form channel-settings" onSubmit={saveState}>
          <label className="field">
            {p.shipFrom}
            <select className="input" value={state} onChange={(e) => setState(e.target.value)} disabled={!canManage} required>
              <option value="">{p.shipFromPlaceholder}</option>
              {US_STATES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <span className="field-hint">{p.shipFromHint}</span>
          </label>
          {canManage && (
            <button className="btn btn--secondary" disabled={!state || state === c.settings.shipFromState}>
              {p.save}
            </button>
          )}
        </form>
      )}

      {c && item.listedCount > 0 && <p className="muted channel-count">{p.listed(item.listedCount)}</p>}
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      {showConnect && isShopify && item.available && (
        <form className="form channel-settings" onSubmit={connect} id={`connect-${item.channel}`}>
          <label className="field">
            {p.shopField}
            <input className="input" value={shop} onChange={(e) => setShop(e.target.value)} placeholder={p.shopPlaceholder} required autoComplete="off" />
            <span className="field-hint">{p.shopHint}</span>
          </label>
        </form>
      )}

      {showConnect && isWoo && item.available && (
        <form className="form channel-settings" onSubmit={connect} id={`connect-${item.channel}`}>
          <label className="field">
            {p.wooUrl}
            <input
              className="input"
              type="url"
              inputMode="url"
              value={woo.storeUrl}
              onChange={(e) => setWoo({ ...woo, storeUrl: e.target.value })}
              placeholder={p.wooUrlPlaceholder}
              required
            />
          </label>
          <div className="form-row form-row--2">
            <label className="field">
              {p.wooKey}
              <input className="input mono" value={woo.consumerKey} onChange={(e) => setWoo({ ...woo, consumerKey: e.target.value })} required autoComplete="off" spellCheck={false} />
            </label>
            <label className="field">
              {p.wooSecret}
              <input
                className="input mono"
                type="password"
                value={woo.consumerSecret}
                onChange={(e) => setWoo({ ...woo, consumerSecret: e.target.value })}
                required
                autoComplete="off"
              />
            </label>
          </div>
          <span className="field-hint">{item.testMode ? p.wooTestHint : p.wooHint}</span>
        </form>
      )}

      {canManage && (
        <div className="channel-actions">
          {showConnect && isWoo && (
            <button className="btn" type="submit" form={`connect-${item.channel}`} disabled={pending || !item.available}>
              <Plug size={18} aria-hidden /> {pending ? p.checking : c ? p.reconnect : p.wooConnect}
            </button>
          )}
          {showConnect && !isWoo && (
            <button
              className="btn"
              type={isShopify ? "submit" : "button"}
              form={isShopify ? `connect-${item.channel}` : undefined}
              onClick={isShopify ? undefined : () => void connect()}
              disabled={pending || !item.available}
            >
              <Plug size={18} aria-hidden /> {pending ? p.connecting : c ? p.reconnect : p.connect(item.label)}
              {!pending && <ExternalLink size={14} aria-hidden />}
            </button>
          )}
          {c && (
            <button className="btn btn--danger-ghost" onClick={disconnect}>
              {p.disconnect}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Canal pas encore branché : type de connexion prévu. */
function UpcomingChannelCard({ item }: { item: ChannelOverview }) {
  const { t } = useI18n();
  const p = t.channelsPage;
  return (
    <li className="channel-upcoming">
      <span className="channel-logo channel-logo--muted" aria-hidden>
        {item.integration === "api" ? <Store size={18} /> : <Puzzle size={18} />}
      </span>
      <span className="list-item-body">
        <strong>{item.label}</strong>
        <small>{item.integration === "api" ? p.api : p.assisted}</small>
      </span>
      <span className="badge badge--soon">{p.soon}</span>
    </li>
  );
}

export default function ChannelsPage() {
  const { me, logout } = useSession();
  const { t } = useI18n();
  const p = t.channelsPage;
  const [items, setItems] = useState<ChannelOverview[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    const res = await api<{ canManage: boolean; items: ChannelOverview[] }>("/channels");
    if (res.ok) {
      setItems(res.data.items);
      setCanManage(res.data.canManage);
    }
  }, []);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  // Retour de la page d'accord du canal : ?connected=depop ou ?error=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    const label = (params.get("channel") ?? connected ?? "").replace(/^\w/, (ch) => ch.toUpperCase());
    setNotice(
      connected
        ? { kind: "success", text: p.connected(label) }
        : { kind: "error", text: p.errors[error ?? ""] ?? t.errors.generic },
    );
    window.history.replaceState(null, "", "/channels");
  }, [p, t]);

  if (!me || !items) return <PageLoading />;
  const live = items.filter((i) => i.supported);
  const upcoming = items.filter((i) => !i.supported);

  return (
    <AppShell me={me} active="channels" onLogout={logout}>
      <div className="page-header">
        <h1>{p.title}</h1>
        <p className="muted">{p.intro}</p>
      </div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {!canManage && <p className="note">{p.ownerOnly}</p>}

      <div className="channels-grid">
        {live.map((item) => (
          <ConnectedChannelCard key={item.channel} item={item} canManage={canManage} onChanged={load} />
        ))}
        <section className="card" aria-label={p.soon}>
          <ul className="channel-upcoming-list">
            {upcoming.map((item) => (
              <UpcomingChannelCard key={item.channel} item={item} />
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
