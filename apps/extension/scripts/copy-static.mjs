// Copie les fichiers fixes (manifeste, fenêtre, styles) à côté du JavaScript compilé.
// Le dossier dist/ se charge tel quel dans Chrome : chrome://extensions › Charger l'extension non empaquetée.
// Version publiée : localhost est retiré du manifeste (aucune page locale ne peut parler à l'extension).
// Version de développement (site local) : `npm run build:dev -w @hub/extension`.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dev = process.argv.includes("--dev");
cpSync(resolve(root, "static"), resolve(root, "dist"), { recursive: true });

if (!dev) {
  const path = resolve(root, "dist", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const isLocal = (pattern) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(pattern);
  manifest.host_permissions = manifest.host_permissions.filter((p) => !isLocal(p));
  for (const script of manifest.content_scripts) script.matches = script.matches.filter((p) => !isLocal(p));
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
