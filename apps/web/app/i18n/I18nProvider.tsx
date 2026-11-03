"use client";

import { createContext, useContext, type ReactNode } from "react";
import { INTL_LOCALE, type Locale } from "@hub/shared";
import { setApiMessages } from "../lib/api";
import { MESSAGES, type Messages } from "./index";

interface I18n {
  locale: Locale;
  /** Locale complète pour Intl, ex. « fr-FR ». */
  intl: string;
  t: Messages;
}

const I18nContext = createContext<I18n | null>(null);

/** Fournit la langue choisie par le serveur (cookie ou navigateur) à toutes les pages. */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const t = MESSAGES[locale];
  // Les messages d'erreur de l'API suivent la langue de l'interface.
  setApiMessages(t);
  return <I18nContext.Provider value={{ locale, intl: INTL_LOCALE[locale], t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n doit être utilisé dans <I18nProvider>");
  return value;
}
