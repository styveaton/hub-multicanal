"use client";

import Link from "next/link";
import { BarChart3, CreditCard, Layers, LogOut, Receipt, Share2, Tag, Users, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import type { Me } from "../lib/api";
import { Logo } from "./Logo";
import { SiteFooter } from "./SiteFooter";

type NavKey = "products" | "stock" | "orders" | "channels" | "analytics" | "team" | "billing";

interface NavItem {
  key: NavKey;
  icon: LucideIcon;
  href?: string; // absent : écran pas encore disponible
  permission?: string; // masqué si le rôle n'a pas cette permission
}

// Ordre repris de la charte (Listings, Inventory, Channels, Analytics).
const NAV: NavItem[] = [
  { key: "products", icon: Tag, href: "/products" },
  { key: "stock", icon: Layers, href: "/stock", permission: "stock:manage" },
  { key: "orders", icon: Receipt, href: "/orders", permission: "orders:view" },
  { key: "channels", icon: Share2, href: "/channels", permission: "channels:manage" },
  { key: "analytics", icon: BarChart3 },
  { key: "team", icon: Users, href: "/team" },
  { key: "billing", icon: CreditCard, permission: "billing:manage" },
];

export const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

export function AppShell({ me, active, onLogout, children }: {
  me: Me;
  active: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const displayName = me.user.name ?? me.user.email;
  const items = NAV.filter((item) => !item.permission || me.permissions.includes(item.permission));

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <Link href="/products" aria-label="OmniList">
            <Logo variant="inverse" size={34} />
          </Link>
          <nav className="app-nav" aria-label={t.nav.main}>
            {items.map(({ key, icon: Icon, href }) => {
              const label = t.nav[key];
              return href ? (
                <Link key={key} href={href} className="nav-item" aria-current={key === active ? "page" : undefined}>
                  <Icon size={17} aria-hidden /> {label}
                </Link>
              ) : (
                <span key={key} className="nav-item" aria-disabled="true" title={t.nav.soon(label)}>
                  <Icon size={17} aria-hidden /> {label}
                </span>
              );
            })}
          </nav>
          <div className="app-user">
            <LanguageSwitcher dark />
            <span className="app-user-name">
              {displayName}
              <small>
                {me.organization.name} · {t.roles[me.role]}
              </small>
            </span>
            <span className="avatar" aria-hidden>
              {initials(displayName)}
            </span>
            <button className="icon-btn" onClick={onLogout} aria-label={t.nav.logout} title={t.nav.logout}>
              <LogOut size={18} aria-hidden />
            </button>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
      <SiteFooter />
    </>
  );
}
