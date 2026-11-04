import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "../components/Logo";
import { getLocale } from "../i18n/server";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import { PRIVACY, PRIVACY_CONTACT, PRIVACY_UPDATED } from "./content";

// Page publique (sans connexion) : son adresse est déclarée chez eBay, Etsy, Shopify…
export async function generateMetadata(): Promise<Metadata> {
  return { title: PRIVACY[await getLocale()].title };
}

export default async function PrivacyPage() {
  const locale = await getLocale();
  const c = PRIVACY[locale];
  return (
    <>
      <header className="site-header">
        <Link href="/" aria-label="OmniList">
          <Logo size={40} />
        </Link>
        <nav>
          <LanguageSwitcher />
        </nav>
      </header>
      <main className="legal">
        <h1>{c.title}</h1>
        <p className="muted">
          {c.updated} {PRIVACY_UPDATED[locale]}
        </p>
        <p>{c.intro}</p>
        {c.sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.items && (
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {section.paragraphs?.map((p) => <p key={p}>{p}</p>)}
          </section>
        ))}
        <p className="muted">
          <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a>
        </p>
      </main>
    </>
  );
}
