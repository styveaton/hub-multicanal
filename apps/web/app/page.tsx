"use client";

import Link from "next/link";
import { ArrowRight, Store } from "lucide-react";
import { BrandKeywords } from "./components/Brand";
import { Logo, LogoIcon } from "./components/Logo";
import { useI18n } from "./i18n/I18nProvider";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher";

// Canaux autour du hub (positions en % du visuel).
const CHANNELS = [
  { name: "eBay", x: 18, y: 20 },
  { name: "Amazon", x: 82, y: 20 },
  { name: "TikTok Shop", x: 18, y: 80 },
  { name: null, x: 82, y: 80 }, // « Et bientôt plus »
];

export default function Home() {
  const { t } = useI18n();
  return (
    <>
      <header className="site-header">
        <Logo size={40} />
        <nav>
          <LanguageSwitcher />
          <Link href="/login" className="btn btn--ghost">
            {t.home.login}
          </Link>
          <Link href="/signup" className="btn">
            {t.home.signup}
          </Link>
        </nav>
      </header>

      <main className="hero">
        <div className="hero-copy">
          <span className="eyebrow">List once. Sync everywhere.</span>
          <h1>
            {t.brand.headline1}
            <br />
            <span className="text-accent">{t.brand.headline2}</span>
          </h1>
          <p>{t.home.pitch}</p>
          <div className="hero-actions">
            <Link href="/signup" className="btn">
              {t.home.cta} <ArrowRight size={18} aria-hidden />
            </Link>
            <Link href="/login" className="btn btn--secondary">
              {t.home.login}
            </Link>
          </div>
          <BrandKeywords />
        </div>

        <div className="sync-visual" role="img" aria-label={t.home.visualLabel}>
          <svg className="sync-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {CHANNELS.map((c) => (
              <line
                key={`${c.x}-${c.y}`}
                x1="50"
                y1="50"
                x2={c.x}
                y2={c.y}
                stroke="#2563FF"
                strokeOpacity="0.35"
                strokeWidth="2"
                strokeDasharray="6 5"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          <div className="sync-hub">
            <LogoIcon size={132} />
          </div>
          {CHANNELS.map((c) => (
            <span key={`${c.x}-${c.y}`} className="channel-chip" style={{ left: `${c.x}%`, top: `${c.y}%` }}>
              <Store size={16} aria-hidden /> {c.name ?? t.home.moreSoon}
            </span>
          ))}
        </div>
      </main>
    </>
  );
}
