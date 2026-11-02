import nodemailer from "nodemailer";
import type { Env } from "../env.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Envoi SMTP réel (Mailpit en local, fournisseur d'emails en staging/production). */
export function createSmtpMailer(env: Env): Mailer {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return {
    async send(message) {
      await transport.sendMail({ from: env.MAIL_FROM, ...message });
    },
  };
}

/** Garde les emails en mémoire, pour les tests. */
export class MemoryMailer implements Mailer {
  sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function invitationEmail(params: {
  to: string;
  organizationName: string;
  inviterName: string;
  link: string;
  expiresAt: Date;
}): MailMessage {
  const { to, organizationName, inviterName, link, expiresAt } = params;
  const expires = expiresAt.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const inviter = escapeHtml(inviterName);
  const org = escapeHtml(organizationName);
  const href = escapeHtml(link);
  return {
    to,
    subject: `${inviterName} vous invite à rejoindre ${organizationName} sur OmniList`,
    text: [
      `${inviterName} vous invite à rejoindre ${organizationName} sur OmniList.`,
      "",
      `Acceptez l'invitation : ${link}`,
      "",
      `Ce lien expire le ${expires}.`,
      "",
      "OmniList · List once. Sync everywhere.",
    ].join("\n"),
    html: brandedEmail(`
      <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${BRAND.navy};">Rejoignez ${org}</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:${BRAND.muted};">
        ${inviter} vous invite à rejoindre l'équipe de <strong style="color:${BRAND.navy};">${org}</strong> sur OmniList,
        pour gérer les annonces et le stock de la boutique.
      </p>
      <a href="${href}" style="display:inline-block;background:${BRAND.blue};color:#ffffff;font-weight:600;font-size:15px;text-decoration:none;padding:12px 22px;border-radius:8px;">Accepter l'invitation</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${BRAND.muted};">
        Ce lien expire le ${expires}. Si le bouton ne fonctionne pas, copiez cette adresse :<br>
        <a href="${href}" style="color:${BRAND.blue};word-break:break-all;">${href}</a>
      </p>`),
  };
}

// Couleurs de la charte OmniList (docs/CHARTE.md).
const BRAND = { navy: "#0B1F44", blue: "#2563FF", muted: "#5B6B86", surface: "#F3F6FB", border: "#DCE3EF" };

/** Gabarit commun des emails : en-tête navy avec le nom OmniList, carte blanche, pied avec le slogan. */
function brandedEmail(content: string): string {
  return `<!doctype html>
<html lang="fr"><body style="margin:0;padding:0;background:${BRAND.surface};font-family:Inter,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.surface};padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="background:${BRAND.navy};border-radius:12px 12px 0 0;padding:20px 28px;">
        <span style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;">Omni<span style="color:#4D82FF;">List</span></span>
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid ${BRAND.border};border-top:0;border-radius:0 0 12px 12px;padding:32px 28px;">
        ${content}
      </td></tr>
      <tr><td align="center" style="padding:20px 12px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.muted};">
        List once. Sync everywhere.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
