import Link from "next/link";
import type { ReactNode } from "react";
import { BrandKeywords } from "./Brand";
import { Logo } from "./Logo";

/** Écrans inscription / connexion / invitation : panneau de marque navy + carte formulaire. */
export function AuthLayout({ title, subtitle, children, footer }: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <Link href="/" aria-label="OmniList, accueil">
          <Logo variant="inverse" size={40} />
        </Link>
        <div className="auth-brand-body">
          <h2>
            Publiez une fois.
            <br />
            <span style={{ color: "#4d82ff" }}>Vendez partout.</span>
          </h2>
          <p>
            Mettez à jour un produit une seule fois : annonces, stock et détails restent synchronisés sur tous vos
            canaux de vente.
          </p>
          <BrandKeywords dark />
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
          {children}
          {footer && <p className="auth-footer">{footer}</p>}
        </div>
      </main>
    </div>
  );
}
