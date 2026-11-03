import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { MESSAGES } from "./i18n";
import { I18nProvider } from "./i18n/I18nProvider";
import { getLocale } from "./i18n/server";
import "./globals.css";

// Police de la charte : Inter (repli : Manrope, puis police système).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const t = MESSAGES[await getLocale()];
  return {
    title: { default: t.meta.title, template: "%s · OmniList" },
    description: t.meta.description,
    applicationName: "OmniList",
  };
}

export const viewport = { themeColor: "#0B1F44" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Langue choisie sur le serveur : la page arrive directement dans la langue du navigateur, sans clignotement.
  const locale = await getLocale();
  return (
    <html lang={locale} className={inter.variable}>
      <body>
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
