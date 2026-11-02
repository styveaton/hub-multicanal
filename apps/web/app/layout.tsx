import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Hub Multi-canal",
  description: "Publiez et synchronisez vos produits sur eBay, Amazon et TikTok Shop.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
