import type { FillData, FillField, FillResult } from "./types.js";

/**
 * Remplit le formulaire Poshmark (création ou modification d'annonce) dans l'onglet ouvert par le vendeur.
 *
 * Injectée par chrome.scripting au clic du vendeur sur « Remplir » : la fonction doit rester autonome
 * (aucune variable ni import extérieur), car Chrome n'en copie que le texte.
 * Elle ne clique jamais sur « List », « Next » ou « Save Draft » : c'est le vendeur qui publie.
 * Catégorie, taille, couleur et prix d'origine restent au vendeur (listes propres à Poshmark).
 *
 * Repères relevés sur poshmark.com/create-listing le 9 novembre 2026 (version 1).
 */
export async function fillPoshmark(data: FillData): Promise<FillResult> {
  const filled: FillField[] = [];
  const missed: FillField[] = [];
  const result = (stop: FillResult["stop"]): FillResult => ({ stop, filled, missed });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  if (!/(^|\.)poshmark\.com$/.test(location.hostname)) return result("wrong_page");
  // Alerte du site : on s'arrête sans rien toucher.
  if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="captcha"], #px-captcha')) return result("captcha");

  const title = document.querySelector<HTMLInputElement>('input[data-vv-name="title"]');
  const description = document.querySelector<HTMLTextAreaElement>('textarea[data-vv-name="description"]');
  if (!title || !description) return result("form_not_found");

  // Le site est en Vue : on passe par le « setter » natif puis on prévient le site, comme une saisie.
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  };
  const fill = (field: FillField, el: HTMLInputElement | HTMLTextAreaElement | null, value: string | null) => {
    if (value === null || value === "") return;
    if (!el) return void missed.push(field);
    setValue(el, value);
    filled.push(field);
  };

  // Photos : seulement pour une nouvelle annonce sans photo (on ne remplace pas celles du vendeur).
  if (data.mode === "LIST" && data.photos.length > 0) {
    const input = document.querySelector<HTMLInputElement>('input#img-file-input, input[name="img-file-input"]');
    const hasPhotos = document.querySelector(".listing-editor__covershot img, [data-et-name='listingEditorImageSection'] img") !== null;
    if (input && !hasPhotos) {
      const transfer = new DataTransfer();
      for (const photo of data.photos.slice(0, 16)) {
        const bytes = Uint8Array.from(atob(photo.base64), (c) => c.charCodeAt(0));
        transfer.items.add(new File([bytes], photo.name, { type: photo.type }));
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      filled.push("photos");
      // Poshmark peut ouvrir une fenêtre de recadrage : le vendeur la valide.
      await sleep(800);
    } else if (!input) missed.push("photos");
  }

  fill("title", title, data.title);
  fill("description", description, data.description);

  // État : liste déroulante maison, une entrée par état (data-et-prop-content).
  const conditionCode = ({ NEW: "nwt", USED_LIKE_NEW: "uln", USED_GOOD: "ug", USED_FAIR: "uf" } as Record<string, string>)[data.condition];
  const conditionItem = conditionCode
    ? document.querySelector<HTMLElement>(`[data-et-name="listing_condition"][data-et-prop-content="${conditionCode}"]`)
    : null;
  if (conditionItem) {
    conditionItem.closest('[data-test="dropdown"]')?.querySelector<HTMLElement>(".dropdown__selector")?.click();
    await sleep(150);
    conditionItem.click();
    filled.push("condition");
  } else missed.push("condition");

  // Marque : on la saisit ; le vendeur choisit la suggestion de Poshmark si elle apparaît.
  fill("brand", document.querySelector<HTMLInputElement>('[data-et-name="listingEditorBrandSection"] input[type="text"]'), data.brand);

  // Prix en dollars entiers (le champ n'accepte que des chiffres).
  if (data.priceCents === null) missed.push("price");
  else fill("price", document.querySelector<HTMLInputElement>('input[data-vv-name="listingPrice"]'), String(Math.round(data.priceCents / 100)));

  fill("sku", document.querySelector<HTMLInputElement>('input[data-vv-name="sku"]'), data.sku);

  title.scrollIntoView({ block: "center" });
  return result(null);
}
