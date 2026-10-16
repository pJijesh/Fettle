import { DevMailer, type Mailer, type OutboundMessage } from "../outbox";
import { SmtpMailer } from "./smtp";
import { TwilioSms } from "./twilio";

/** Sends each message through the provider for its channel. A channel with no provider fails loudly, not silently. */
export class RoutingMailer implements Mailer {
  readonly isReal = true;
  constructor(private email: Mailer | null, private sms: Mailer | null) {}
  get name(): string {
    return [this.email && `email:${this.email.name}`, this.sms && `sms:${this.sms.name}`].filter(Boolean).join(" ");
  }
  get channels(): { email: boolean; sms: boolean } {
    return { email: !!this.email, sms: !!this.sms };
  }
  send(msg: OutboundMessage): Promise<void> {
    const m = msg.channel === "email" ? this.email : this.sms;
    if (!m) return Promise.reject(new Error(`No ${msg.channel === "email" ? "email" : "text"} provider is set up`));
    return m.send(msg);
  }
}

type Env = Record<string, string | undefined>;

/**
 * Chooses providers from the environment. With nothing set the development mailer is used, which sends nothing.
 * A half-filled configuration is an error at start-up rather than a message that quietly never arrives.
 *
 *   Email: SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE=1 for port 465, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_REPLY_TO
 *   Text:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 */
export function createMailer(env: Env = process.env): Mailer {
  let email: Mailer | null = null;
  let sms: Mailer | null = null;

  if (env.SMTP_HOST) {
    if (!env.SMTP_FROM) throw new Error("SMTP_HOST is set but SMTP_FROM is not. Set the sender address, for example: Clinic Name <appointments@yourclinic.co.uk>");
    if (!!env.SMTP_USER !== !!env.SMTP_PASS) throw new Error("Set both SMTP_USER and SMTP_PASS, or neither");
    const port = Number(env.SMTP_PORT || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT must be a port number");
    email = new SmtpMailer({ host: env.SMTP_HOST, port, secure: env.SMTP_SECURE === "1" || port === 465, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM, replyTo: env.SMTP_REPLY_TO || undefined });
  }

  const t = [env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM];
  if (t.some(Boolean)) {
    if (!t.every(Boolean)) throw new Error("Texts need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM together");
    sms = new TwilioSms({ accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN!, from: env.TWILIO_FROM! });
  }

  return email || sms ? new RoutingMailer(email, sms) : new DevMailer();
}
