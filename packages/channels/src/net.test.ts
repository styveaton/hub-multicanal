import { describe, expect, it } from "vitest";
import { HostNotAllowedError, assertPublicHost, isInternalHostname, isPrivateAddress } from "./net.js";
import { WooClient, normalizeStoreUrl } from "./woocommerce/client.js";

/** Garde SSRF : le serveur n'appelle jamais son propre réseau à partir d'une adresse saisie. */

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:7f00:1", "pas-une-ip",
  ])("refuse %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700::1111", "::ffff:808:808"])("accepte %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("isInternalHostname", () => {
  it.each(["localhost", "10.0.0.5", "[::1]", "db", "nas.local", "api.internal", "app.localhost"])("refuse %s", (h) =>
    expect(isInternalHostname(h)).toBe(true),
  );
  it("accepte un vrai domaine", () => expect(isInternalHostname("boutique.example.com")).toBe(false));
});

describe("assertPublicHost", () => {
  const resolvesTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address }));

  it("accepte un nom qui mène à une IP publique", async () => {
    await expect(assertPublicHost("boutique.example.com", resolvesTo("93.184.216.34"))).resolves.toBeUndefined();
  });

  it("refuse un nom public qui mène au réseau interne (même une seule adresse)", async () => {
    await expect(assertPublicHost("piege.example.com", resolvesTo("93.184.216.34", "10.0.0.5"))).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(assertPublicHost("meta.example.com", resolvesTo("169.254.169.254"))).rejects.toBeInstanceOf(HostNotAllowedError);
  });

  it("refuse un nom introuvable", async () => {
    const fail = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicHost("inconnu.example.com", fail)).rejects.toBeInstanceOf(HostNotAllowedError);
  });
});

describe("normalizeStoreUrl", () => {
  it("garde une vraie boutique en https", () => {
    expect(normalizeStoreUrl("boutique.example.com/")).toBe("https://boutique.example.com");
  });

  it.each(["https://10.0.0.5", "https://169.254.169.254", "https://[::1]", "https://localhost", "http://boutique.example.com", "https://a:b@boutique.example.com", "https://nas.local"])(
    "refuse %s",
    (url) => expect(normalizeStoreUrl(url)).toBeNull(),
  );

  it("permet http://localhost pour le faux WooCommerce local", () => {
    expect(normalizeStoreUrl("http://localhost:4000", true)).toBe("http://localhost:4000");
  });
});

describe("WooClient avec vérification de l'hôte", () => {
  const store = { url: "https://piege.example.com", key: "ck", secret: "cs" };

  it("n'appelle pas une boutique dont le nom mène au réseau interne", async () => {
    let called = false;
    const client = new WooClient({
      fetch: (async () => {
        called = true;
        return new Response("{}");
      }) as typeof fetch,
      checkHost: () => assertPublicHost("piege.example.com", async () => [{ address: "10.0.0.5" }]),
    });
    await expect(client.getCurrency(store)).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(called).toBe(false);
  });

  it("refuse de suivre les redirections", async () => {
    let init: RequestInit | undefined;
    const client = new WooClient({
      fetch: (async (_url: string, i?: RequestInit) => {
        init = i;
        return new Response(JSON.stringify({ code: "EUR" }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      checkHost: async () => undefined,
    });
    await client.getCurrency({ ...store, url: "https://boutique.example.com" });
    expect(init?.redirect).toBe("error");
  });
});
