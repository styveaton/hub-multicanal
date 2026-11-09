/** Données passées au remplissage d'un formulaire de site (sérialisables : elles traversent chrome.scripting). */
export interface FillPhoto {
  name: string;
  type: string;
  /** Contenu du fichier, en base64. */
  base64: string;
}

export interface FillData {
  /** LIST : nouvelle annonce ; UPDATE : annonce existante (les photos ne sont pas touchées). */
  mode: "LIST" | "UPDATE";
  title: string;
  description: string;
  brand: string | null;
  condition: string;
  /** Prix en cents, dans la devise du site. null : devise différente, le vendeur saisit le prix. */
  priceCents: number | null;
  sku: string;
  photos: FillPhoto[];
}

/** Champs que le remplissage connaît (pour les messages de l'extension). */
export type FillField = "photos" | "title" | "description" | "condition" | "brand" | "price" | "sku";

export interface FillResult {
  /** Arrêt : page inattendue ou alerte du site. Rien n'a été rempli. */
  stop: "wrong_page" | "form_not_found" | "captcha" | null;
  filled: FillField[];
  /** Champs que le remplissage n'a pas pu remplir : le vendeur les complète. */
  missed: FillField[];
}
