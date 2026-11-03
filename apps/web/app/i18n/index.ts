import type { Locale } from "@hub/shared";
import en from "./en";
import fr, { type Messages } from "./fr";

export type { Messages };

export const MESSAGES: Record<Locale, Messages> = { fr, en };
