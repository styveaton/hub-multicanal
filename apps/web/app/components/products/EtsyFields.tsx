"use client";

import { ETSY_WHEN_MADE, ETSY_WHO_MADE, type EtsyDetails, type EtsyWhenMade, type EtsyWhoMade } from "@hub/shared";
import { useI18n } from "../../i18n/I18nProvider";

/** Champs obligatoires d'Etsy : qui a fabriqué l'objet, et quand (avant 2007 = vintage). */
export function EtsyFields({ details, onChange }: { details: EtsyDetails; onChange: (d: EtsyDetails) => void }) {
  const { t, locale } = useI18n();
  const e = t.channel.etsy;
  const name = (o: { en: string; fr: string }) => (locale === "fr" ? o.fr : o.en);

  return (
    <div className="form-row form-row--2">
      <label className="field">
        {e.whoMade}
        <select
          className="input"
          value={details.whoMade ?? ""}
          onChange={(ev) => onChange({ ...details, whoMade: (ev.target.value || undefined) as EtsyWhoMade | undefined })}
        >
          <option value="">{e.choose}</option>
          {ETSY_WHO_MADE.map((o) => (
            <option key={o.id} value={o.id}>
              {name(o)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {e.whenMade}
        <select
          className="input"
          value={details.whenMade ?? ""}
          onChange={(ev) => onChange({ ...details, whenMade: (ev.target.value || undefined) as EtsyWhenMade | undefined })}
        >
          <option value="">{e.choose}</option>
          {ETSY_WHEN_MADE.map((o) => (
            <option key={o.id} value={o.id}>
              {name(o)}
            </option>
          ))}
        </select>
        <span className="field-hint">{e.whenMadeHint}</span>
      </label>
    </div>
  );
}
