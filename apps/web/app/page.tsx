import Link from "next/link";
import { ArrowRight, Store } from "lucide-react";
import { BrandKeywords } from "./components/Brand";
import { Logo, LogoIcon } from "./components/Logo";

// Canaux autour du hub (positions en % du visuel).
const CHANNELS = [
  { name: "eBay", x: 18, y: 20 },
  { name: "Amazon", x: 82, y: 20 },
  { name: "TikTok Shop", x: 18, y: 80 },
  { name: "Et bientôt plus", x: 82, y: 80 },
];

export default function Home() {
  return (
    <>
      <header className="site-header">
        <Logo size={40} />
        <nav>
          <Link href="/login" className="btn btn--ghost">
            Se connecter
          </Link>
          <Link href="/signup" className="btn">
            Créer un compte
          </Link>
        </nav>
      </header>

      <main className="hero">
        <div className="hero-copy">
          <span className="eyebrow">List once. Sync everywhere.</span>
          <h1>
            Publiez une fois.
            <br />
            <span className="text-accent">Vendez partout.</span>
          </h1>
          <p>
            Créez, mettez à jour et synchronisez vos produits sur tous vos canaux de vente. Annonces, stock et détails
            restent alignés, sans double vente.
          </p>
          <div className="hero-actions">
            <Link href="/signup" className="btn">
              Créer mon compte <ArrowRight size={18} aria-hidden />
            </Link>
            <Link href="/login" className="btn btn--secondary">
              Se connecter
            </Link>
          </div>
          <BrandKeywords />
        </div>

        <div className="sync-visual" role="img" aria-label="Un produit synchronisé vers eBay, Amazon et TikTok Shop">
          <svg className="sync-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {CHANNELS.map((c) => (
              <line
                key={c.name}
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
            <span key={c.name} className="channel-chip" style={{ left: `${c.x}%`, top: `${c.y}%` }}>
              <Store size={16} aria-hidden /> {c.name}
            </span>
          ))}
        </div>
      </main>
    </>
  );
}
