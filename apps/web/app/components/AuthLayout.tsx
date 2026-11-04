"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import { BrandKeywords } from "./Brand";
import { Logo } from "./Logo";

/** Écrans inscription / connexion / invitation : panneau de marque navy + carte formulaire. */
export function AuthLayout({ title, subtitle, children, footer }: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { brand, common } = useI18n().t;
  return (
    <div className="auth">
      <aside className="auth-brand">
        <Link href="/" aria-label={brand.home}>
          <Logo variant="inverse" size={40} />
        </Link>
        <div className="auth-brand-body">
          <h2>
            {brand.headline1}
            <br />
            <span style={{ color: "#4d82ff" }}>{brand.headline2}</span>
          </h2>
          <p>{brand.authPitch}</p>
          <BrandKeywords dark />
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-lang">
            <LanguageSwitcher />
          </div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
          {children}
          {footer && <p className="auth-footer">{footer}</p>}
        </div>
        <p className="auth-legal">
          <Link href="/privacy">{common.privacy}</Link>
        </p>
      </main>
    </div>
  );
}
