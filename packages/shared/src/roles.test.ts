import { describe, expect, it } from "vitest";
import { PERMISSIONS, can } from "./roles.js";

describe("permissions US1", () => {
  it("le propriétaire a toutes les permissions", () => {
    for (const p of PERMISSIONS) expect(can("OWNER", p)).toBe(true);
  });

  it("l'employé ne gère ni l'abonnement ni les canaux", () => {
    expect(can("EMPLOYEE", "billing:manage")).toBe(false);
    expect(can("EMPLOYEE", "channels:manage")).toBe(false);
  });

  it("l'employé ne peut ni inviter ni gérer les membres", () => {
    expect(can("EMPLOYEE", "members:invite")).toBe(false);
    expect(can("EMPLOYEE", "members:manage")).toBe(false);
  });

  it("l'employé gère produits et stock et voit les commandes", () => {
    expect(can("EMPLOYEE", "products:manage")).toBe(true);
    expect(can("EMPLOYEE", "stock:manage")).toBe(true);
    expect(can("EMPLOYEE", "orders:view")).toBe(true);
  });
});
