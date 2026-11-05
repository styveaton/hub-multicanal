import { ApiError, api, getPairing, isOmnilistOrigin, pair, type ExtensionMessage } from "./api.js";

/**
 * Service worker : badge du nombre de tâches, relevé périodique, liaison envoyée par la page OmniList.
 * Il n'ouvre aucune page de site et n'agit jamais en arrière-plan sur un site.
 */

const ALARM = "refresh-tasks";
const REFRESH_MINUTES = 5;

async function refreshBadge() {
  if (!(await getPairing())) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  try {
    const { items } = await api.tasks();
    await chrome.action.setBadgeBackgroundColor({ color: "#1f5eff" });
    await chrome.action.setBadgeText({ text: items.length === 0 ? "" : items.length > 99 ? "99+" : String(items.length) });
  } catch (err) {
    // Jeton révoqué : la liaison vient d'être effacée. Autre erreur (réseau) : on réessaiera.
    await chrome.action.setBadgeText({ text: err instanceof ApiError && err.status === 401 ? "" : "!" });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: REFRESH_MINUTES });
  void refreshBadge();
});
chrome.runtime.onStartup.addListener(() => void refreshBadge());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void refreshBadge();
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (message.type === "refresh") {
    void refreshBadge().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "pair") {
    // Seule la page OmniList elle-même (script de liaison) peut transmettre un jeton.
    const fromOmnilist = sender.tab != null && sender.origin != null && isOmnilistOrigin(sender.origin) && sender.origin === message.origin;
    if (!fromOmnilist || !message.token.startsWith("omx_")) {
      sendResponse({ ok: false, error: "forbidden" });
      return false;
    }
    pair({ origin: message.origin, token: message.token })
      .then(async (config) => {
        await refreshBadge();
        sendResponse({ ok: true, device: config.device.name });
      })
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof ApiError ? err.code : "network_error" }));
    return true;
  }
  return false;
});
