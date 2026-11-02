import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Police de la charte : Inter (repli : Manrope, puis police système).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "OmniList · List once. Sync everywhere.", template: "%s · OmniList" },
  description: "Publiez une fois, vendez partout : annonces et stock synchronisés sur eBay, Amazon et TikTok Shop.",
  applicationName: "OmniList",
};

export const viewport = { themeColor: "#0B1F44" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
