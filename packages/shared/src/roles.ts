/**
 * US1 : rôles propriétaire et employé.
 * Règle : l'employé ne gère ni l'abonnement ni les connexions de canaux.
 */
export const ROLES = ["OWNER", "EMPLOYEE"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "products:manage",
  "orders:view",
  "stock:manage",
  "members:invite",
  "members:manage",
  "billing:manage",
  "channels:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  EMPLOYEE: new Set<Permission>(["products:manage", "orders:view", "stock:manage"]),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
