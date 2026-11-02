"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "../lib/api";

/** Charge l'utilisateur connecté ; renvoie vers /login sinon. */
export function useSession() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api<Me>("/auth/me").then((res) => {
      if (res.ok) setMe(res.data);
      else router.replace("/login");
    });
  }, [router]);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }, [router]);

  return { me, logout };
}
