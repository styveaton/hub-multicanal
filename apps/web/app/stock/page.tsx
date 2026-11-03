"use client";

import { ImageOff, Minus, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CHANNEL_LABEL } from "@hub/shared";
import { Alert } from "../components/Alert";
import { AppShell } from "../components/AppShell";
import { PageLoading } from "../components/PageLoading";
import { useSession } from "../components/useSession";
import { useI18n } from "../i18n/I18nProvider";
import { api, type Page, type StockItem, type SyncLogEntry, type SyncLogType } from "../lib/api";

type Filter = "all" | "low" | "out";
type Notice = { kind: "success" | "error"; text: string } | null;

const LOG_TYPES: SyncLogType[] = ["SALE", "RESTOCK", "ADJUSTMENT", "OVERSOLD", "UNKNOWN_SKU", "CHANNEL_UPDATE", "CHANNEL_ERROR"];

/** Ligne de stock : − / + et saisie d'une nouvelle valeur. */
function StockRow({ item, low, onChanged }: { item: StockItem; low: number; onChanged: (n: Notice) => void }) {
  const { t } = useI18n();
  const s = t.stockPage;
  const [value, setValue] = useState(String(item.quantity));
  const [pending, setPending] = useState(false);
  useEffect(() => setValue(String(item.quantity)), [item.quantity]);

  async function adjust(body: { delta: number } | { set: number }) {
    setPending(true);
    const res = await api<{ sku: string; quantity: number }>(`/stock/${encodeURIComponent(item.sku)}/adjust`, { method: "POST", body });
    setPending(false);
    onChanged(res.ok ? { kind: "success", text: s.saved(item.sku, res.data.quantity) } : { kind: "error", text: res.message });
  }

  function onSet(event: FormEvent) {
    event.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return onChanged({ kind: "error", text: t.validation.quantity_invalid });
    if (n !== item.quantity) void adjust({ set: n });
  }

  const variant = item.attributes ? Object.values(item.attributes).join(" / ") : null;
  return (
    <li className="stock-row">
      <Link href={`/products/${item.productId}`} className="stock-item">
        <span className="product-thumb">
          {item.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api${item.photoUrl}`} alt="" />
          ) : (
            <ImageOff size={20} aria-hidden />
          )}
        </span>
        <span className="product-main">
          <strong>{item.title}</strong>
          <small>
            {variant ? `${variant} · ` : ""}
            <span className="mono">{item.sku}</span>
          </small>
        </span>
      </Link>
      <span className="stock-channels">
        {item.channels.length === 0
          ? s.noChannel
          : item.channels.map((c) => (
              <span key={c} className="badge badge--channel">
                {CHANNEL_LABEL[c]}
              </span>
            ))}
      </span>
      <form className="stock-qty" onSubmit={onSet}>
        {item.quantity === 0 ? (
          <span className="badge badge--danger">{s.out}</span>
        ) : item.quantity <= low ? (
          <span className="badge badge--warn">{s.low}</span>
        ) : null}
        <button type="button" className="icon-btn icon-btn--light" onClick={() => adjust({ delta: -1 })} disabled={pending || item.quantity === 0} aria-label={s.remove(item.sku)}>
          <Minus size={16} />
        </button>
        <input className="input input--sm stock-input" type="number" min={0} step={1} value={value} onChange={(e) => setValue(e.target.value)} aria-label={s.setLabel(item.sku)} />
        <button type="button" className="icon-btn icon-btn--light" onClick={() => adjust({ delta: 1 })} disabled={pending} aria-label={s.add(item.sku)}>
          <Plus size={16} />
        </button>
        {value !== String(item.quantity) && (
          <button className="btn btn--secondary btn--sm" disabled={pending}>
            {s.apply}
          </button>
        )}
      </form>
    </li>
  );
}

function StockTab() {
  const { t } = useI18n();
  const s = t.stockPage;
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ lowStock: number; items: StockItem[] } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ filter });
    if (query.trim()) q.set("q", query.trim());
    const res = await api<{ lowStock: number; items: StockItem[] }>(`/stock?${q}`);
    if (res.ok) setData(res.data);
  }, [filter, query]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  const onChanged = (n: Notice) => {
    setNotice(n);
    void load();
  };

  return (
    <>
      <div className="toolbar">
        <label className="search">
          <Search size={18} aria-hidden />
          <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={s.searchPlaceholder} aria-label={s.searchPlaceholder} />
        </label>
        <div className="seg-filter" role="group">
          {(["all", "low", "out"] as const).map((f) => (
            <button key={f} type="button" className="seg-filter-item" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? s.filterAll : f === "low" ? s.filterLow(data?.lowStock ?? 2) : s.filterOut}
            </button>
          ))}
        </div>
      </div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {!data ? null : data.items.length === 0 ? (
        <p className="empty">{s.empty}</p>
      ) : (
        <ul className="stock-list">
          {data.items.map((item) => (
            <StockRow key={item.sku} item={item} low={data.lowStock} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </>
  );
}

function LogTab() {
  const { t, intl } = useI18n();
  const s = t.stockPage;
  const [type, setType] = useState<SyncLogType | "">("");
  const [entries, setEntries] = useState<SyncLogEntry[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const q = new URLSearchParams({ page: String(page), pageSize: "50" });
    if (type) q.set("type", type);
    void api<Page<SyncLogEntry>>(`/stock/log?${q}`).then((res) => {
      if (!res.ok) return;
      setTotal(res.data.total);
      setEntries((prev) => (page === 1 ? res.data.items : [...prev, ...res.data.items]));
    });
  }, [type, page]);

  return (
    <>
      <div className="toolbar">
        <label className="field field--inline">
          {s.logFilterType}
          <select
            className="input"
            value={type}
            onChange={(e) => {
              setPage(1);
              setType(e.target.value as SyncLogType | "");
            }}
          >
            <option value="">{s.logFilterAll}</option>
            {LOG_TYPES.map((lt) => (
              <option key={lt} value={lt}>
                {s.logTypes[lt]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {entries.length === 0 ? (
        <p className="empty">{s.logEmpty}</p>
      ) : (
        <ul className="sync-log">
          {entries.map((e) => (
            <li key={e.id} className={`sync-log-item sync-log-item--${e.type.toLowerCase()}`}>
              <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString(intl, { dateStyle: "short", timeStyle: "medium" })}</time>
              <span className="badge sync-log-type">{s.logTypes[e.type]}</span>
              <span className="sync-log-channel">{e.channel ? CHANNEL_LABEL[e.channel] : s.direct}</span>
              <span className="sync-log-body">
                {e.sku && <span className="mono">{e.sku}</span>}
                {e.delta != null && <strong className={e.delta < 0 ? "neg" : "pos"}>{e.delta > 0 ? `+${e.delta}` : e.delta}</strong>}
                {e.quantityAfter != null && <small>{s.after(e.quantityAfter)}</small>}
                {e.message && <small>{s.logMessage(e.message)}</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {entries.length < total && (
        <button type="button" className="btn btn--secondary" onClick={() => setPage((p) => p + 1)}>
          {s.more}
        </button>
      )}
    </>
  );
}

export default function StockPage() {
  const { me, logout } = useSession();
  const { t } = useI18n();
  const s = t.stockPage;
  const [tab, setTab] = useState<"stock" | "log">("stock");

  if (!me) return <PageLoading />;
  return (
    <AppShell me={me} active="stock" onLogout={logout}>
      <div className="page-header">
        <h1>{s.title}</h1>
        <p className="muted">{s.intro}</p>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className="tab" aria-selected={tab === "stock"} onClick={() => setTab("stock")}>
          {s.tabStock}
        </button>
        <button type="button" role="tab" className="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>
          {s.tabLog}
        </button>
      </div>
      <div role="tabpanel">{tab === "stock" ? <StockTab /> : <LogTab />}</div>
    </AppShell>
  );
}
