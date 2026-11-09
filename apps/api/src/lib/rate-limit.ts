/**
 * Limite stricte des routes publiques qui vérifient un mot de passe, un code ou un jeton,
 * ou qui envoient un email : 10 requêtes par IP toutes les 15 minutes.
 * S'ajoute à la limite générale posée dans app.ts (sans effet si elle est coupée).
 */
export const STRICT_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: "15 minutes" } } as const;
