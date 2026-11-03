"use client";

import { AlertTriangle, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CHANNELS, CHANNEL_LABEL, formatMoney, type Channel } from "@hub/shared";
import { Alert } from "../components/Alert";
import { AppShell } from "../components/AppShell";
import { PageLoading } from "../components/PageLoading";
import { useSession } from "../components/useSession";
import { useI18n } from "../i18n/I18nProvider";
import { api, parseMoney, type Order, type OrderStatus, type Page, type StockItem } from "../lib/api";

const STATUSES: OrderStatus[] = ["PAID", "SHIPPED", "COMPLETED", "CANCELLED", "REFUNDED"];
type Notice = { kind: "success" | "error"; text: string } | null;
const AUTO_REFERENCE = /^manual:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Vente en direct ou sur un canal pas encore branché : le stock baisse et les canaux suivent. */
function ManualSaleCard({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const o = t.ordersPage;
  const [items, setItems] = useState<StockItem[]>([]);
  const [channel, setChannel] = useState<Channel | "">("");
  const [sku, setSku] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [reference, setReference] = useState("");
  const [buyer, setBuyer] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);

  const loadStock = useCallback(async () => {
    const res = await api<{ items: StockItem[] }>("/stock");
    if (res.ok) setItems(res.data.items.filter((i) => i.quantity > 0));
  }, []);
  useEffect(() => void loadStock(), [loadStock]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const unitPriceCents = parseMoney(price);
    if (unitPriceCents == null) return setNotice({ kind: "error", text: o.priceInvalid });
    setPending(true);
    const res = await api<{ id: string }>("/orders", {
      method: "POST",
      body: {
        channel: channel || null,
        reference: reference.trim() || undefined,
        buyerName: buyer.trim() || undefined,
        lines: [{ sku, quantity: Number(quantity), unitPriceCents }],
      },
    });
    setPending(false);
    if (!res.ok) return setNotice({ kind: "error", text: res.message });
    setNotice({ kind: "success", text: o.saleSaved });
    setSku("");
    setQuantity("1");
    setPrice("");
    setReference("");
    setBuyer("");
    void loadStock();
    onSaved();
  }

  const selected = items.find((i) => i.sku === sku);
  return (
    <section className="card" aria-labelledby="sale-title">
      <div className="card-header">
        <div>
          <h2 id="sale-title">{o.saleTitle}</h2>
          <p className="muted">{o.saleHint}</p>
        </div>
      </div>
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          {o.saleChannel}
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as Channel | "")}>
            <option value="">{o.manual}</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {o.saleSku}
          <select className="input" value={sku} onChange={(e) => setSku(e.target.value)} required>
            <option value="">{o.saleSkuPlaceholder}</option>
            {items.map((i) => (
              <option key={i.sku} value={i.sku}>
                {i.title}
                {i.attributes ? ` · ${Object.values(i.attributes).join(" / ")}` : ""} · {i.sku} ({o.available(i.quantity)})
              </option>
            ))}
          </select>
        </label>
        <div className="form-row form-row--2">
          <label className="field">
            {o.saleQuantity}
            <input className="input" type="number" min={1} max={selected?.quantity} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </label>
          <label className="field">
            {o.salePrice}
            <input className="input" inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </label>
        </div>
        <div className="form-row form-row--2">
          <label className="field">
            {o.saleReference} <span className="field-optional">{t.common.optional}</span>
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
          </label>
          <label className="field">
            {o.saleBuyer} <span className="field-optional">{t.common.optional}</span>
            <input className="input" value={buyer} onChange={(e) => setBuyer(e.target.value)} maxLength={100} />
          </label>
        </div>
        {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
        <button className="btn" disabled={pending || !sku}>
          <Plus size={18} aria-hidden /> {o.saleSubmit}
        </button>
      </form>
    </section>
  );
}

export default function OrdersPage() {
  const { me, logout } = useSession();
  const { t, intl } = useI18n();
  const o = t.ordersPage;
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [list, setList] = useState<Page<Order> | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (channel) q.set("channel", channel);
    if (status) q.set("status", status);
    const res = await api<Page<Order>>(`/orders?${q}`);
    if (res.ok) setList(res.data);
  }, [channel, status]);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  async function cancel(order: Order) {
    if (!window.confirm(o.cancelConfirm)) return;
    const res = await api(`/orders/${order.id}/cancel`, { method: "POST" });
    setNotice(res.ok ? { kind: "success", text: o.cancelled } : { kind: "error", text: res.message });
    void load();
  }

  if (!me) return <PageLoading />;
  const canSell = me.permissions.includes("stock:manage");

  return (
    <AppShell me={me} active="orders" onLogout={logout}>
      <div className="page-header">
        <h1>{o.title}</h1>
        <p className="muted">{o.intro}</p>
      </div>

      <div className="page-grid">
        <div className="orders-col">
          <div className="toolbar">
            <label className="field field--inline">
              {o.filterChannel}
              <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">{o.allChannels}</option>
                <option value="manual">{o.manual}</option>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field--inline">
              {o.filterStatus}
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">{o.allStatuses}</option>
                {STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {o.statuses[st]}
                  </option>
                ))}
              </select>
            </label>
            {list && <span className="muted">{o.count(list.total)}</span>}
          </div>
          {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

          {list && list.items.length === 0 ? (
            <p className="empty">{o.empty}</p>
          ) : (
            <ul className="order-list">
              {list?.items.map((order) => (
                <li key={order.id} className="card order-card">
                  <div className="order-head">
                    <span className="badge badge--channel">{order.channel ? CHANNEL_LABEL[order.channel] : o.manual}</span>
                    <span className={`badge order-status order-status--${order.status.toLowerCase()}`}>{o.statuses[order.status]}</span>
                    {order.oversold && (
                      <span className="badge badge--danger">
                        <AlertTriangle size={12} aria-hidden /> {o.oversold}
                      </span>
                    )}
                    <span className="order-total">{formatMoney(order.totalCents, order.currency, intl)}</span>
                  </div>
                  <p className="order-meta muted">
                    {/* Vente saisie sans référence : l'identifiant technique n'aide personne, on le masque. */}
                    {!AUTO_REFERENCE.test(order.externalOrderId) && (
                      <>
                        <span className="mono">{order.externalOrderId.replace(/^manual:/, "")}</span>
                        {" · "}
                      </>
                    )}
                    {new Date(order.placedAt).toLocaleString(intl, { dateStyle: "medium", timeStyle: "short" })}
                    {order.buyerName ? ` · ${order.buyerName}` : ""}
                  </p>
                  <ul className="order-lines">
                    {order.lines.map((l) => (
                      <li key={l.sku}>
                        <span>
                          {l.quantity} × {l.title} <span className="mono">{l.sku}</span>
                        </span>
                        <span>{formatMoney(l.unitPriceCents, order.currency, intl)}</span>
                        {!l.matched && <small className="warn-text">{o.unmatched}</small>}
                        {l.oversoldQty > 0 && <small className="warn-text">{o.oversoldHint(l.oversoldQty)}</small>}
                      </li>
                    ))}
                  </ul>
                  {canSell && order.source === "MANUAL" && order.status !== "CANCELLED" && (
                    <button type="button" className="btn btn--danger-ghost" onClick={() => cancel(order)}>
                      {o.cancel}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {canSell && <ManualSaleCard onSaved={load} />}
      </div>
    </AppShell>
  );
}
