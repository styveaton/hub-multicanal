"use client";

import Link from "next/link";
import { BarChart3, CreditCard, Layers, LogOut, Share2, Tag, Users, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Me } from "../lib/api";
import { Logo } from "./Logo";

interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  href?: string; // absent : écran pas encore disponible
  permission?: string; // masqué si le rôle n'a pas cette permission
}

// Ordre et libellés repris de la charte (Listings, Inventory, Channels, Analytics).
const NAV: NavItem[] = [
  { key: "products", label: "Produits", icon: Tag, href: "/products" },
  { key: "stock", label: "Stock", icon: Layers },
  { key: "channels", label: "Canaux", icon: Share2, permission: "channels:manage" },
  { key: "analytics", label: "Analytique", icon: BarChart3 },
  { key: "team", label: "Équipe", icon: Users, href: "/team" },
  { key: "billing", label: "Abonnement", icon: CreditCard, permission: "billing:manage" },
];

export const ROLE_LABEL = { OWNER: "Propriétaire", EMPLOYEE: "Employé" } as const;

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
  const displayName = me.user.name ?? me.user.email;
  const items = NAV.filter((item) => !item.permission || me.permissions.includes(item.permission));

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <Link href="/products" aria-label="OmniList">
            <Logo variant="inverse" size={34} />
          </Link>
          <nav className="app-nav" aria-label="Navigation principale">
            {items.map(({ key, label, icon: Icon, href }) =>
              href ? (
                <Link key={key} href={href} className="nav-item" aria-current={key === active ? "page" : undefined}>
                  <Icon size={17} aria-hidden /> {label}
                </Link>
              ) : (
                <span key={key} className="nav-item" aria-disabled="true" title={`${label} : bientôt disponible`}>
                  <Icon size={17} aria-hidden /> {label}
                </span>
              ),
            )}
          </nav>
          <div className="app-user">
            <span className="app-user-name">
              {displayName}
              <small>
                {me.organization.name} · {ROLE_LABEL[me.role]}
              </small>
            </span>
            <span className="avatar" aria-hidden>
              {initials(displayName)}
            </span>
            <button className="icon-btn" onClick={onLogout} aria-label="Se déconnecter" title="Se déconnecter">
              <LogOut size={18} aria-hidden />
            </button>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
