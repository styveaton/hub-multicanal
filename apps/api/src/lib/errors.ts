/**
 * Erreur métier : renvoyée telle quelle au client par le gestionnaire d'erreurs de l'app,
 * sous la forme { error: code, ...details }.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}
