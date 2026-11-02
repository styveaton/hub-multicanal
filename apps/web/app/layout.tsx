import type { ReactNode } from "react";

export const metadata = {
  title: "Hub Multi-canal",
  description: "Publiez et synchronisez vos produits sur eBay, Amazon et TikTok Shop.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
