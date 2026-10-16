import nodemailer, { type Transporter } from "nodemailer";
import type { Mailer, OutboundMessage } from "../outbox";

export interface SmtpConfig {
  host: string;
  port: number;
  /** true for implicit TLS (port 465). Otherwise the connection upgrades with STARTTLS and refuses to send in the clear. */
  secure: boolean;
  user?: string;
  pass?: string;
  /** "Clinic Name <appointments@clinic.example>" */
  from: string;
  replyTo?: string;
  /** Tests only: allow a plain, unencrypted local server. */
  allowInsecure?: boolean;
}

/**
 * Sends email through any SMTP service (a UK or EU provider, or your own relay). Errors are reduced to a status
 * code, because a provider's message usually repeats the recipient's address.
 */
export class SmtpMailer implements Mailer {
  readonly name = "smtp";
  readonly isReal = true;
  private transport: Transporter;

  constructor(private cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: !cfg.secure && !cfg.allowInsecure,
      ignoreTLS: !!cfg.allowInsecure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (msg.channel !== "email") throw new Error("SMTP sends email only");
    const domain = /@([^>\s]+)>?\s*$/.exec(this.cfg.from)?.[1] ?? "fettle.invalid";
    try {
      await this.transport.sendMail({
        from: this.cfg.from,
        to: msg.to,
        replyTo: this.cfg.replyTo,
        subject: msg.subject,
        text: msg.body,
        // The same outbox row always carries the same Message-ID, so a receiver can drop a repeat.
        messageId: `<${msg.id}@${domain}>`,
        headers: { "X-Fettle-Kind": msg.kind, "Auto-Submitted": "auto-generated" },
      });
    } catch (err) {
      const e = err as { responseCode?: number; code?: string };
      throw new Error(`SMTP ${e.responseCode ?? e.code ?? "error"}`);
    }
  }
}
