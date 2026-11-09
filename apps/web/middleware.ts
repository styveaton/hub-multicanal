import { NextResponse, type NextRequest } from "next/server";

/**
 * Politique de sécurité du contenu (CSP) des pages, avec un jeton (« nonce ») neuf à chaque requête :
 * seuls les scripts de Next.js, marqués de ce jeton, peuvent s'exécuter. Un script injecté dans une page
 * (XSS) est bloqué par le navigateur. Les pages sont déjà rendues à la demande (langue lue dans les cookies),
 * ce qui permet à Next.js de poser le jeton sur ses propres scripts.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' : les scripts chargés par un script autorisé le sont aussi. En dev, React a besoin d'eval.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Attributs style="…" produits par React : à garder tant que des styles en ligne existent.
    "style-src 'self' 'unsafe-inline'",
    // Photos servies par /api, aperçus locaux (blob:) et petites images en data:.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  // Next.js lit la CSP de la requête pour trouver le nonce et le poser sur ses scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Pas sur /api (relayé tel quel vers l'API) ni sur les fichiers statiques.
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|icon.svg|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
