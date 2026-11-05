import {
  ApiError,
  DEFAULT_ORIGIN,
  OMNILIST_ORIGINS,
  api,
  clearPairing,
  getPairing,
  pair,
  type ExtensionConfig,
  type TaskPayload,
  type TaskSummary,
} from "./api.js";
import { messages } from "./i18n.js";

/**
 * Fenêtre de l'extension. Phase 1 : le vendeur relie le navigateur, voit ses tâches, ouvre la page
 * du site et recopie les informations de la fiche ; il clique lui-même sur le bouton du site,
 * puis indique ici le résultat. Le remplissage automatique du formulaire viendra par site (phase 2).
 */

const t = messages(navigator.language);
const app = document.getElementById("app")!;
const deviceLabel = document.getElementById("device")!;
document.documentElement.lang = t.lang;

const CURRENT = "currentTask";

const CHANNEL_LABEL: Record<string, string> = {
  POSHMARK: "Poshmark",
  MERCARI: "Mercari",
  FACEBOOK_MARKETPLACE: "Facebook Marketplace",
  GRAILED: "Grailed",
};
const label = (channel: string) => CHANNEL_LABEL[channel] ?? channel;

// Petit constructeur d'éléments : pas de HTML injecté, tout le texte passe par textContent.
type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) el.className = className;
  Object.assign(el, rest);
  for (const c of children) if (c) el.append(c);
  return el;
}

function render(...nodes: Child[]) {
  app.replaceChildren(...nodes.filter((n): n is Node | string => Boolean(n)));
}

const note = (text: string, kind: "warn" | "error" | "ok" | "" = "") => h("p", { class: `note${kind ? ` note--${kind}` : ""}`, textContent: text });

function errorText(err: unknown) {
  const code = err instanceof ApiError ? err.code : "network_error";
  return t.errors[code] ?? t.errors.generic;
}

const getCurrent = async () => ((await chrome.storage.local.get(CURRENT))[CURRENT] as TaskPayload | undefined) ?? null;
const setCurrent = (task: TaskPayload | null) => (task ? chrome.storage.local.set({ [CURRENT]: task }) : chrome.storage.local.remove(CURRENT));
const refreshBadge = () => chrome.runtime.sendMessage({ type: "refresh" }).catch(() => undefined);

// ---------------------------------------------------------------------------
// Liaison du navigateur
// ---------------------------------------------------------------------------

function renderPairing(error?: string) {
  const token = h("input", { id: "token", type: "password", autocomplete: "off", spellcheck: false, required: true, placeholder: "omx_…" });
  const origin = h(
    "select",
    { id: "origin" },
    ...OMNILIST_ORIGINS.map((o) => h("option", { value: o, textContent: o === DEFAULT_ORIGIN ? "OmniList" : t.localServer, selected: o === DEFAULT_ORIGIN })),
  );
  const submit = h("button", { class: "btn", type: "submit", textContent: t.pair });
  const form = h(
    "form",
    { class: "detail" },
    h("h2", { textContent: t.pairTitle }),
    h("p", { class: "muted", textContent: t.pairHint }),
    h("label", { class: "field" }, t.token, token),
    h("label", { class: "field" }, t.server, origin),
    error ? note(error, "error") : null,
    submit,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await pair({ origin: origin.value, token: token.value.trim() });
      await refreshBadge();
      await renderHome();
    } catch (err) {
      renderPairing(errorText(err));
    }
  });
  deviceLabel.textContent = "";
  render(form);
}

// ---------------------------------------------------------------------------
// Liste des tâches
// ---------------------------------------------------------------------------

function siteWarnings(config: ExtensionConfig) {
  return config.sites.flatMap((s) => {
    if (!s.consented) return [];
    if (!s.enabled) return [note(t.siteDisabled(label(s.channel)), "warn")];
    if (s.paused) return [note(t.sitePaused(label(s.channel), t.pauseReasons[s.pauseReason ?? ""] ?? s.pauseReason ?? ""), "warn")];
    return [];
  });
}

function taskRow(task: TaskSummary, onOpen: (task: TaskSummary, button: HTMLButtonElement) => void) {
  const open = h("button", { class: "btn btn--sm", type: "button", textContent: task.status === "CLAIMED" ? t.resume : t.open });
  open.addEventListener("click", () => onOpen(task, open));
  return h(
    "li",
    { class: "task" },
    h("span", { class: "task-title", textContent: task.title, title: task.title }),
    open,
    h(
      "span",
      { class: "task-meta" },
      h("span", { class: `badge${task.type === "DELIST" ? " badge--delist" : ""}`, textContent: t.types[task.type] }),
      ` ${label(task.channel)} · ${task.sku}`,
      task.lastError ? ` · ${t.lastError}` : "",
    ),
  );
}

async function renderHome(flash?: { text: string; kind: "ok" | "error" | "warn" }) {
  const pairing = await getPairing();
  if (!pairing) return renderPairing();
  const current = await getCurrent();
  if (current) return renderTask(current, flash);

  render(h("p", { class: "muted", textContent: t.loading }));
  let config: ExtensionConfig;
  let tasks: TaskSummary[];
  try {
    [config, { items: tasks }] = await Promise.all([api.config(), api.tasks()]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderPairing(t.errors.unpaired);
    return render(note(errorText(err), "error"));
  }
  deviceLabel.textContent = config.device.name;

  const onOpen = async (task: TaskSummary, button: HTMLButtonElement) => {
    button.disabled = true;
    try {
      const payload = await api.claim(task.id);
      await setCurrent(payload);
      // Le vendeur voit la page du site s'ouvrir : rien ne se passe dans un onglet caché.
      if (payload.openUrl) await chrome.tabs.create({ url: payload.openUrl, active: true });
      await renderTask(payload);
    } catch (err) {
      button.disabled = false;
      await renderHome({ text: errorText(err), kind: "error" });
    }
  };

  const unpair = h("button", { class: "btn btn--ghost btn--sm", type: "button", textContent: t.unpair });
  unpair.addEventListener("click", async () => {
    if (!window.confirm(t.unpairConfirm)) return;
    await clearPairing();
    await refreshBadge();
    renderPairing();
  });

  render(
    flash ? note(flash.text, flash.kind) : null,
    ...siteWarnings(config),
    !config.sites.some((s) => s.consented) ? note(t.noSite) : null,
    h("h2", { textContent: t.tasksTitle(tasks.length) }),
    tasks.length === 0 ? h("p", { class: "empty", textContent: t.noTask }) : h("ul", { class: "tasks" }, ...tasks.map((task) => taskRow(task, onOpen))),
    h("div", { class: "row" }, unpair),
  );
}

// ---------------------------------------------------------------------------
// Tâche en cours
// ---------------------------------------------------------------------------

function copyRow(name: string, value: string) {
  const button = h("button", { class: "btn btn--secondary btn--sm", type: "button", textContent: t.copy });
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value);
    button.textContent = t.copied;
  });
  return h("div", { class: "copy-row" }, h("div", {}, h("span", { class: "label", textContent: name }), h("div", { class: "value", textContent: value })), button);
}

const money = (cents: number, currency: string) => new Intl.NumberFormat(t.lang, { style: "currency", currency }).format(cents / 100);

/** Lien de l'onglet actif, s'il est sur le site de la tâche : proposé comme lien de l'annonce. */
async function activeTabUrl(task: TaskPayload, hosts: string[]) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url ?? "");
    const onSite = hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return onSite && url.href !== task.openUrl ? url.href : "";
  } catch {
    return "";
  }
}

async function renderTask(task: TaskPayload, flash?: { text: string; kind: "ok" | "error" | "warn" }) {
  const site = label(task.channel);
  const config = await api.config().catch(() => null);
  if (config) deviceLabel.textContent = config.device.name;
  const hosts = config?.sites.find((s) => s.channel === task.channel)?.hosts ?? [];
  const p = task.product;

  const done = async (text: string, kind: "ok" | "warn" | "error" = "ok") => {
    await setCurrent(null);
    await refreshBadge();
    await renderHome({ text, kind });
  };
  const run = async (button: HTMLButtonElement, action: () => Promise<void>) => {
    button.disabled = true;
    try {
      await action();
    } catch (err) {
      button.disabled = false;
      // Tâche reprise par un autre navigateur ou révoquée : on revient à la liste.
      if (err instanceof ApiError && (err.code === "task_not_claimed" || err.code === "not_found")) return done(errorText(err), "error");
      await renderTask(task, { text: errorText(err), kind: "error" });
    }
  };

  const openSite = h("button", { class: "btn btn--secondary", type: "button", textContent: t.openSite(site) });
  openSite.disabled = !task.openUrl;
  openSite.addEventListener("click", () => task.openUrl && void chrome.tabs.create({ url: task.openUrl, active: true }));

  // Fin de tâche : le vendeur a cliqué lui-même sur le bouton du site.
  const urlInput = h("input", { type: "url", placeholder: `https://${hosts[0] ?? "…"}/…`, value: await activeTabUrl(task, hosts) });
  const finish = h("button", { class: "btn", type: "submit", textContent: task.type === "DELIST" ? t.finishDelist : t.finish });
  const finishForm = h(
    "form",
    { class: "detail" },
    task.type !== "DELIST" ? h("label", { class: "field" }, t.listingUrl, urlInput, h("span", { class: "muted", textContent: t.listingUrlHint })) : null,
    finish,
  );
  finishForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(finish, async () => {
      const listingUrl = urlInput.value.trim() || null;
      await api.complete(task.id, { listingUrl });
      await done(t.completed(site));
    });
  });

  // Problème sur le site : une alerte (CAPTCHA, avertissement…) met le site en pause.
  const reason = h("select", {}, ...Object.entries(t.failReasons).map(([value, text]) => h("option", { value, textContent: text })));
  const report = h("button", { class: "btn btn--secondary btn--sm", type: "button", textContent: t.report });
  report.addEventListener("click", () =>
    void run(report, async () => {
      const res = await api.fail(task.id, { code: reason.value });
      await done(res.paused ? t.pausedNow(site) : res.final ? t.failedFinal : t.failed, res.paused || res.final ? "warn" : "ok");
    }),
  );
  const release = h("button", { class: "btn btn--ghost btn--sm", type: "button", textContent: t.release });
  release.addEventListener("click", () =>
    void run(release, async () => {
      await api.release(task.id);
      await done(t.released, "ok");
    }),
  );

  render(
    flash ? note(flash.text, flash.kind) : null,
    h("h2", { textContent: `${t.types[task.type]} · ${site}` }),
    h("p", { class: "muted", textContent: t.taskHint[task.type](site) }),
    p
      ? h(
          "div",
          { class: "detail" },
          copyRow(t.fields.title, p.title),
          copyRow(t.fields.price, money(p.priceCents, p.currency)),
          copyRow(t.fields.description, p.description),
          p.brand ? copyRow(t.fields.brand, p.brand) : null,
          copyRow(t.fields.condition, t.conditions[p.condition] ?? p.condition),
          ...Object.entries(p.attributes).map(([k, v]) => copyRow(k, v)),
          h("div", { class: "photos" }, ...p.photos.map((url, i) => h("a", { href: url, target: "_blank", rel: "noreferrer", textContent: t.photo(i + 1) }))),
        )
      : null,
    h("div", { class: "row" }, openSite),
    finishForm,
    h("div", { class: "row" }, reason, report),
    h("div", { class: "row" }, release),
  );
}

void renderHome();
