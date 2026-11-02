/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@hub/shared"],
  // Le front appelle l'API via /api/* : même origine, donc le cookie de session suit sans CORS.
  async rewrites() {
    const apiUrl = process.env.API_URL ?? "http://localhost:4000";
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};
export default nextConfig;
