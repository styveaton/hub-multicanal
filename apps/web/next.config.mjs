/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@hub/shared"],
  // Le front appelle l'API via /api/* : même origine, donc le cookie de session suit sans CORS.
  async rewrites() {
    const apiUrl = process.env.API_URL ?? "http://localhost:4000";
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
  // N'annonce pas « Next.js » dans les réponses.
  poweredByHeader: false,
  // En-têtes de sécurité sur toutes les réponses (pages et /api). La CSP des pages est posée par middleware.ts.
  async headers() {
    const security = [
      // Le site ne peut pas être affiché dans un cadre d'un autre site (clics piégés).
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      // Les liens d'invitation contiennent un jeton : jamais d'adresse complète envoyée aux autres sites.
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Caméra pour les photos produits ; le reste est coupé.
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ];
    if (process.env.NODE_ENV === "production") {
      security.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
    }
    return [{ source: "/:path*", headers: security }];
  },
};
export default nextConfig;
