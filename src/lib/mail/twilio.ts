import type { Mailer, OutboundMessage } from "../outbox";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** A Twilio number in international form, or an alphanumeric sender name such as "ClinicName". */
  from: string;
  /** Tests only. */
  baseUrl?: string;
}

/**
 * Turns a UK number as people write it into international form: "07700 900123" becomes "+447700900123".
 * Returns null for anything that cannot be a phone number.
 */
export function toE164(raw: string, defaultCountry = "44"): string | null {
  let t = raw.trim().replace(/[\s().-]/g, "");
  if (t.startsWith("00")) t = `+${t.slice(2)}`;
  // "+44 (0)7700 900123" is how many people write it: the 0 is the national prefix and is not dialled from abroad.
  if (t.startsWith("+440")) t = `+44${t.slice(4)}`;
  if (t.startsWith("+")) return /^\+[1-9]\d{7,14}$/.test(t) ? t : null;
  if (t.startsWith("0")) t = `+${defaultCountry}${t.slice(1)}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(t) ? t : null;
}

/** Sends text messages through Twilio's REST API. Errors are reduced to the status and Twilio's numeric code. */
export class TwilioSms implements Mailer {
  readonly name = "twilio";
  readonly isReal = true;

  constructor(private cfg: TwilioConfig) {}

  async send(msg: OutboundMessage): Promise<void> {
    if (msg.channel !== "sms") throw new Error("Twilio sends texts only");
    const to = toE164(msg.to);
    if (!to) throw new Error("Twilio: not a valid phone number");
    const base = this.cfg.baseUrl ?? "https://api.twilio.com";
    const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: this.cfg.from, Body: msg.body }).toString(),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new Error("Twilio: could not be reached");
    });
    if (!res.ok) {
      let code = "";
      try {
        code = String(((await res.json()) as { code?: number }).code ?? "");
      } catch {
        /* no body */
      }
      throw new Error(`Twilio ${res.status}${code ? ` code ${code}` : ""}`);
    }
  }
}
