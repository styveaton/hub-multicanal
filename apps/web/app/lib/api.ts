export interface Me {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; name: string };
  role: "OWNER" | "EMPLOYEE";
  permissions: string[];
}

export interface Invitation {
  id: string;
  email: string;
  role: "OWNER" | "EMPLOYEE";
  status: string;
  expiresAt: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

const MESSAGES: Record<string, string> = {
  email_taken: "Un compte existe déjà avec cet email.",
  invalid_credentials: "Email ou mot de passe incorrect.",
  validation_error: "Vérifiez les champs (mot de passe : 8 caractères minimum).",
  already_member: "Cette personne fait déjà partie de l'équipe.",
  invalid_invitation: "Ce lien d'invitation n'est plus valable.",
  invitation_expired: "Ce lien d'invitation a expiré. Demandez une nouvelle invitation.",
  name_required: "Indiquez votre nom.",
  weak_password: "Le mot de passe doit faire au moins 8 caractères.",
  email_failed: "L'email n'a pas pu être envoyé. Réessayez.",
  forbidden: "Vous n'avez pas les droits pour cette action.",
  unauthenticated: "Vous devez être connecté.",
};

/** Appelle l'API via le proxy /api (cookie de session inclus). */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return { ok: true, data: undefined as T };
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, data: data as T };
  const code = (data as { error?: string }).error ?? "";
  return { ok: false, status: res.status, message: MESSAGES[code] ?? "Une erreur est survenue." };
}
