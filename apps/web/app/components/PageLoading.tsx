"use client";

import { useI18n } from "../i18n/I18nProvider";

/** Écran d'attente plein page (session ou données en cours de chargement). */
export function PageLoading() {
  return <div className="loading">{useI18n().t.common.loading}</div>;
}
