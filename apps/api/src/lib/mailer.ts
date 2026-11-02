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
  return {
    to,
    subject: `${inviterName} vous invite à rejoindre ${organizationName}`,
    text: [
      `${inviterName} vous invite à rejoindre ${organizationName} sur Hub Multi-canal.`,
      "",
      `Acceptez l'invitation : ${link}`,
      "",
      `Ce lien expire le ${expires}.`,
    ].join("\n"),
    html: `<p>${escapeHtml(inviterName)} vous invite à rejoindre <strong>${escapeHtml(organizationName)}</strong> sur Hub Multi-canal.</p>
<p><a href="${escapeHtml(link)}">Accepter l'invitation</a></p>
<p>Ce lien expire le ${expires}.</p>`,
  };
}
