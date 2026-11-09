import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Garde contre les appels du serveur vers son propre réseau (SSRF).
 * Utilisée pour les adresses saisies par les marchands (sites WooCommerce).
 */

/** Adresse privée, locale ou réservée : jamais appelée depuis le serveur. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) return isPrivateV4(ip);
  if (isIP(ip) !== 6) return true; // illisible : refusée
  // IPv4 dans IPv6 (::ffff:10.0.0.1, ::ffff:a00:1).
  const mapped = ip.match(/^::ffff:(.+)$/)?.[1];
  if (mapped) {
    if (isIP(mapped) === 4) return isPrivateV4(mapped);
    const hex = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
      return isPrivateV4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
    return true;
  }
  if (ip === "::" || ip === "::1") return true;
  const first = parseInt(ip.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 adresses locales uniques
    (first & 0xffc0) === 0xfe80 || // fe80::/10 lien local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    ip.startsWith("64:ff9b:") || // NAT64
    ip.startsWith("2001:db8:") // documentation
  );
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // lien local, métadonnées des clouds
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast et réservé
  );
}

/** Nom d'hôte manifestement interne, refusé sans même le résoudre. */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(h)) return true; // un site marchand a un nom de domaine, pas une IP
  return h === "localhost" || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(h) || !h.includes(".");
}

export type Lookup = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Vérifie qu'un nom d'hôte ne mène qu'à des adresses publiques.
 * Lève `HostNotAllowedError` sinon (nom interne, IP privée, ou nom introuvable).
 */
export async function assertPublicHost(hostname: string, lookup: Lookup = defaultLookup): Promise<void> {
  if (isInternalHostname(hostname)) throw new HostNotAllowedError(hostname);
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new HostNotAllowedError(hostname);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw new HostNotAllowedError(hostname);
}

export class HostNotAllowedError extends Error {
  constructor(readonly hostname: string) {
    super(`adresse non autorisée : ${hostname}`);
  }
}
