// Copie les fichiers fixes (manifeste, fenêtre, styles) à côté du JavaScript compilé.
// Le dossier dist/ se charge tel quel dans Chrome : chrome://extensions › Charger l'extension non empaquetée.
import { cpSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
cpSync(resolve(root, "static"), resolve(root, "dist"), { recursive: true });
