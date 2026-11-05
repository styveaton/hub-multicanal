/**
 * Script de liaison, chargé seulement sur les pages OmniList (voir manifest.json).
 * La page Canaux envoie le jeton d'un navigateur qu'on vient de relier : on le passe à l'extension,
 * ce qui évite le copier-coller. Ce script ne lit rien d'autre sur la page.
 */
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { type?: unknown; token?: unknown } | null;
  if (data?.type !== "omnilist:device-token" || typeof data.token !== "string" || !data.token.startsWith("omx_")) return;
  chrome.runtime.sendMessage({ type: "pair", token: data.token, origin: window.location.origin }, (response: { ok: boolean } | undefined) => {
    window.postMessage({ type: "omnilist:extension-paired", ok: response?.ok === true }, window.location.origin);
  });
});
