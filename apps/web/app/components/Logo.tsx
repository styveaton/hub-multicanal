import { useId } from "react";

type Variant = "default" | "inverse";

// Sommets de l'hexagone (pointe en haut) et noeuds du réseau, autour du centre (60, 60).
const HEX = [
  [60, 36],
  [80.8, 48],
  [80.8, 72],
  [60, 84],
  [39.2, 72],
  [39.2, 48],
] as const;
const NODES = [
  [60, 23],
  [92, 41.5],
  [92, 78.5],
  [60, 97],
  [28, 78.5],
  [28, 41.5],
] as const;

const rhombus = (y: number) => `44,${y} 60,${y - 8.5} 76,${y} 60,${y + 8.5}`;

/**
 * Icône OmniList : flèches de synchronisation, hub hexagonal et pile de fiches produits.
 * Version vectorielle redessinée d'après la charte (docs/brand/charte-omnilist.jpg).
 * `inverse` : pour fond navy (barre d'app, icône d'application).
 */
export function LogoIcon({ size = 40, variant = "default", title }: { size?: number; variant?: Variant; title?: string }) {
  const id = useId().replace(/:/g, "");
  const ink = variant === "inverse" ? "#FFFFFF" : "#0B1F44";
  const hub = variant === "inverse" ? "#163063" : "#0B1F44";

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={`${id}a`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2563FF" />
          <stop offset="1" stopColor="#14B8A6" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#14B8A6" />
          <stop offset="1" stopColor="#2563FF" />
        </linearGradient>
      </defs>

      {/* Flèches de synchronisation */}
      <g fill="none" strokeWidth="7" strokeLinecap="round">
        <path d="M10.8 51.3A50 50 0 0 1 104.5 39.5" stroke={`url(#${id}a)`} />
        <path d="M109.2 68.7A50 50 0 0 1 15.5 80.5" stroke={`url(#${id}b)`} />
      </g>
      <path d="M96.5 37.5 L114 33 L110.5 51 Z" fill="#14B8A6" />
      <path d="M23.5 82.5 L6 87 L9.5 69 Z" fill="#2563FF" />

      {/* Réseau : rayons et noeuds */}
      <g stroke={ink} strokeWidth="4" strokeLinecap="round">
        {HEX.map(([x, y], i) => (
          <line key={i} x1={x} y1={y} x2={NODES[i]![0]} y2={NODES[i]![1]} />
        ))}
      </g>
      {NODES.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="5" fill={ink} />
      ))}

      {/* Hub hexagonal */}
      <polygon points={HEX.map((p) => p.join(",")).join(" ")} fill={hub} stroke={hub} strokeWidth="5" strokeLinejoin="round" />

      {/* Pile de fiches : teal, bleu, blanc + étiquette */}
      <polygon points={rhombus(68.5)} fill="#14B8A6" />
      <polygon points={rhombus(61.5)} fill="#2563FF" />
      <polygon points={rhombus(54)} fill="#FFFFFF" />
      <path d="M54 53.2 L61 49 L66.5 52 L59.5 56.2 Z" fill="#2563FF" />
      <circle cx="62.4" cy="51.6" r="1.1" fill="#FFFFFF" />
    </svg>
  );
}

/** Logo horizontal : icône + « OmniList » (Omni en navy, List en bleu). */
export function Logo({ size = 36, variant = "default", tagline = false }: { size?: number; variant?: Variant; tagline?: boolean }) {
  return (
    <span className={`logo logo--${variant}`}>
      <LogoIcon size={size} variant={variant} />
      <span className="logo-text">
        <span className="wordmark" style={{ fontSize: Math.round(size * 0.66) }}>
          Omni<span className="wordmark-accent">List</span>
        </span>
        {tagline && <span className="logo-tagline">List once. Sync everywhere.</span>}
      </span>
    </span>
  );
}
