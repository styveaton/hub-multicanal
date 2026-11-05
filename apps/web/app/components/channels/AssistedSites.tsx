"use client";

import { AlertTriangle, CheckCircle2, Copy, Laptop, PauseCircle, Puzzle } from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { CHANNEL_LABEL, type Channel } from "@hub/shared";
import { useI18n } from "../../i18n/I18nProvider";
import { api, type AssistedSiteState, type ExtensionDevice } from "../../lib/api";
import { Alert } from "../Alert";

type Notice = { kind: "success" | "error"; text: string } | null;

/** Écran des risques, à lire et cocher avant d'activer le site. */
function ConsentForm({ item, onDone, onCancel }: { item: AssistedSiteState; onDone: (text: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const p = t.assistedSites;
  const label = CHANNEL_LABEL[item.channel];
  const capId = useId();
  const [checked, setChecked] = useState(false);
  const [cap, setCap] = useState(String(item.defaultDailyCap));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const res = await api(`/extension/consents/${item.channel.toLowerCase()}`, {
      method: "POST",
      body: { version: item.consentVersion, accepted: true, dailyCap: Number(cap) },
    });
    setPending(false);
    if (!res.ok) return setError(res.message);
    onDone(p.activated(label));
  }

  return (
    <form className="form consent-form" onSubmit={submit}>
      <h3>{p.consentTitle(label)}</h3>
      <ul className="consent-points">
        {p.consentPoints(label).map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <label className="field" htmlFor={capId}>
        {p.dailyCap}
        <input
          id={capId}
          className="input consent-cap"
          type="number"
          inputMode="numeric"
          min={1}
          max={item.defaultDailyCap}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          required
        />
        <span className="field-hint">{p.dailyCapHint(item.defaultDailyCap)}</span>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>{p.consentCheck(label)}</span>
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="channel-actions">
        <button className="btn" disabled={!checked || pending}>
          {pending ? t.common.saving : p.consentConfirm}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          {t.common.cancel}
        </button>
      </div>
    </form>
  );
}

/** Un site assisté : état, plafond du jour, pause, accord. */
function AssistedSiteCard({ item, onChanged }: { item: AssistedSiteState; onChanged: () => void }) {
  const { t } = useI18n();
  const p = t.assistedSites;
  const label = CHANNEL_LABEL[item.channel];
  const c = item.consent;
  const capId = useId();
  const [consenting, setConsenting] = useState(false);
  const [cap, setCap] = useState(String(c?.dailyCap ?? item.defaultDailyCap));
  const [notice, setNotice] = useState<Notice>(null);
  const path = `/extension/consents/${item.channel.toLowerCase()}`;

  useEffect(() => setCap(String(c?.dailyCap ?? item.defaultDailyCap)), [c?.dailyCap, item.defaultDailyCap]);

  async function update(body: { dailyCap?: number; paused?: boolean }, success?: string) {
    setNotice(null);
    const res = await api(path, { method: "PATCH", body });
    if (!res.ok) return setNotice({ kind: "error", text: res.message });
    if (success) setNotice({ kind: "success", text: success });
    onChanged();
  }

  async function deactivate() {
    if (!window.confirm(p.deactivateConfirm(label))) return;
    const res = await api(path, { method: "DELETE" });
    if (!res.ok) return setNotice({ kind: "error", text: res.message });
    setNotice(null);
    onChanged();
  }

  const status = !item.site.enabled ? (
    <span className="badge badge--danger">{p.disabledByUs}</span>
  ) : c?.pausedAt ? (
    <span className="badge badge--warn">
      <PauseCircle size={14} aria-hidden /> {p.paused}
    </span>
  ) : c ? (
    <span className="badge badge--ok">
      <CheckCircle2 size={14} aria-hidden /> {p.on}
    </span>
  ) : (
    <span className="badge">{p.off}</span>
  );

  return (
    <li className="assisted-site">
      <div className="card-header">
        <div className="channel-card-title">
          <span className="channel-logo" aria-hidden>
            <Puzzle size={20} />
          </span>
          <div>
            <h3 id={`site-${item.channel}`}>{label}</h3>
            <span className="badge badge--channel">{t.channelsPage.assisted}</span>
          </div>
        </div>
        {status}
      </div>

      {!item.site.enabled && <p className="note note--warn">{p.disabledByUsHint}</p>}
      {c?.pausedAt && (
        <p className="note note--warn">
          <AlertTriangle size={16} aria-hidden /> {p.pausedBecause(p.pauseReasons[c.pauseReason ?? ""] ?? c.pauseReason ?? "")}
        </p>
      )}
      {item.openTasks > 0 && <p className="muted channel-count">{p.openTasks(item.openTasks)}</p>}
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      {c && (
        <form
          className="form channel-settings"
          onSubmit={(e) => {
            e.preventDefault();
            void update({ dailyCap: Number(cap) }, p.saved);
          }}
        >
          <label className="field" htmlFor={capId}>
            {p.dailyCap}
            <input
              id={capId}
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={item.defaultDailyCap}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              required
            />
            <span className="field-hint">{p.dailyCapHint(item.defaultDailyCap)}</span>
          </label>
          <button className="btn btn--secondary" disabled={!cap || Number(cap) === c.dailyCap}>
            {p.save}
          </button>
        </form>
      )}

      {consenting && !c ? (
        <ConsentForm
          item={item}
          onCancel={() => setConsenting(false)}
          onDone={(text) => {
            setConsenting(false);
            setNotice({ kind: "success", text });
            onChanged();
          }}
        />
      ) : (
        <div className="channel-actions">
          {!c && (
            <button className="btn" onClick={() => setConsenting(true)} disabled={!item.site.enabled} aria-describedby={`site-${item.channel}`}>
              {p.activate}
            </button>
          )}
          {c && (
            <button className="btn btn--secondary" onClick={() => void update({ paused: !c.pausedAt })}>
              {c.pausedAt ? p.resume : p.pause}
            </button>
          )}
          {c && (
            <button className="btn btn--danger-ghost" onClick={deactivate}>
              {p.deactivate}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Navigateurs reliés : liste, ajout (jeton affiché une fois), révocation. */
function DevicesCard() {
  const { t, intl } = useI18n();
  const p = t.assistedSites;
  const nameId = useId();
  const [devices, setDevices] = useState<ExtensionDevice[] | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    const res = await api<{ items: ExtensionDevice[] }>("/extension/devices");
    if (res.ok) setDevices(res.data.items);
  }, []);

  useEffect(() => void load(), [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    const res = await api<{ token: string }>("/extension/devices", { method: "POST", body: { name: name.trim() } });
    setPending(false);
    if (!res.ok) return setNotice({ kind: "error", text: res.message });
    setName("");
    setCopied(false);
    setToken(res.data.token);
    // L'extension, si elle est déjà installée sur cette page, récupère le jeton sans copier-coller.
    window.postMessage({ type: "omnilist:device-token", token: res.data.token }, window.location.origin);
    void load();
  }

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function revoke(device: ExtensionDevice) {
    if (!window.confirm(p.revokeConfirm(device.name))) return;
    const res = await api(`/extension/devices/${device.id}`, { method: "DELETE" });
    if (!res.ok) return setNotice({ kind: "error", text: res.message });
    void load();
  }

  const when = (iso: string) => new Date(iso).toLocaleString(intl, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className="card channel-card" aria-labelledby="devices-title">
      <div>
        <h2 id="devices-title">{p.devicesTitle}</h2>
        <p className="muted">{p.devicesIntro}</p>
      </div>

      {token && (
        <div className="device-token" role="status">
          <strong>{p.tokenTitle}</strong>
          <code className="mono">{token}</code>
          <span className="field-hint">{p.tokenHint}</span>
          <div className="channel-actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void copy()}>
              <Copy size={16} aria-hidden /> {copied ? p.copied : p.copy}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setToken(null)}>
              {p.done}
            </button>
          </div>
        </div>
      )}

      {devices && devices.length === 0 && <p className="empty">{p.devicesEmpty}</p>}
      {devices && devices.length > 0 && (
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id} className="list-item">
              <Laptop size={18} aria-hidden />
              <span className="list-item-body">
                <strong>{d.name}</strong>
                <small>
                  {d.lastSeenAt ? p.lastSeen(when(d.lastSeenAt)) : p.neverSeen}
                  {d.extensionVersion ? ` · ${p.version(d.extensionVersion)}` : ""}
                </small>
              </span>
              <button className="btn btn--danger-ghost" onClick={() => void revoke(d)}>
                {p.revoke}
              </button>
            </li>
          ))}
        </ul>
      )}

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      <form className="form channel-settings" onSubmit={add}>
        <label className="field" htmlFor={nameId}>
          {p.deviceName}
          <input
            id={nameId}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={p.deviceNamePlaceholder}
            maxLength={80}
            required
          />
        </label>
        <button className="btn" disabled={pending || !name.trim()}>
          {p.addDevice}
        </button>
      </form>
    </section>
  );
}

/** Section « Sites via l'extension » de la page Canaux. */
export function AssistedSites({ canManage, channels }: { canManage: boolean; channels: Channel[] }) {
  const { t } = useI18n();
  const p = t.assistedSites;
  const [items, setItems] = useState<AssistedSiteState[] | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ items: AssistedSiteState[] }>("/extension/consents");
    if (res.ok) setItems(res.data.items);
  }, []);

  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  return (
    <>
      <section className="card assisted-sites" aria-labelledby="assisted-title">
        <div>
          <h2 id="assisted-title">{p.title}</h2>
          <p className="muted">{p.intro}</p>
        </div>
        {canManage ? (
          <ul className="assisted-site-list">
            {items?.map((item) => (
              <AssistedSiteCard key={item.channel} item={item} onChanged={load} />
            ))}
          </ul>
        ) : (
          <>
            <ul className="channel-upcoming-list">
              {channels.map((ch) => (
                <li key={ch} className="channel-upcoming">
                  <span className="channel-logo channel-logo--muted" aria-hidden>
                    <Puzzle size={18} />
                  </span>
                  <span className="list-item-body">
                    <strong>{CHANNEL_LABEL[ch]}</strong>
                    <small>{t.channelsPage.assisted}</small>
                  </span>
                </li>
              ))}
            </ul>
            <p className="note">{p.readOnly}</p>
          </>
        )}
      </section>
      {canManage && <DevicesCard />}
    </>
  );
}
