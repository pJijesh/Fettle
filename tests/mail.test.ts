import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { SmtpMailer } from "@/lib/mail/smtp";
import { TwilioSms, toE164 } from "@/lib/mail/twilio";
import { RoutingMailer, createMailer } from "@/lib/mail";
import { DevMailer, type OutboundMessage } from "@/lib/outbox";
import { platformSetup } from "./platform.helpers";
import { createPlatform } from "@/lib/platform";

const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({ id: "m-1", clinicId: "c", channel: "email", to: "pat@example.com", subject: "Your appointment", body: "See you Monday at 9.", kind: "confirmation", ...over });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function smtpServer(opts: { reject?: boolean; auth?: boolean } = {}) {
  const got: { from: string; to: string[]; raw: string; user?: string }[] = [];
  const server = new SMTPServer({
    authOptional: !opts.auth,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth(auth, _s, cb) {
      if (auth.username === "u" && auth.password === "p") cb(null, { user: auth.username });
      else cb(new Error("bad credentials"));
    },
    onRcptTo(_a, _s, cb) {
      if (opts.reject) {
        const e = Object.assign(new Error("550 Mailbox pat@example.com does not exist"), { responseCode: 550 });
        return cb(e);
      }
      cb();
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c) => (raw += c));
      stream.on("end", () => {
        got.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw, user: (session.user as string | undefined) });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { port: (server.server.address() as AddressInfo).port, got };
}

async function twilioServer(reply: { status: number; body?: unknown } = { status: 201, body: { sid: "SM1" } }) {
  const seen: { url: string; auth: string; form: URLSearchParams }[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", form: new URLSearchParams(b) });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("SMTP email", () => {
  it("delivers a plain-text message with the sender, a stable Message-ID and no leaked extras", async () => {
    const s = await smtpServer({ auth: true });
    const m = new SmtpMailer({ host: "127.0.0.1", port: s.port, secure: false, user: "u", pass: "p", from: "Test Physio <appointments@clinic.test>", replyTo: "front@clinic.test", allowInsecure: true });
    await m.send(msg());
    expect(s.got).toHaveLength(1);
    expect(s.got[0].to).toEqual(["pat@example.com"]);
    expect(s.got[0].user).toBe("u");
    const mail = await simpleParser(s.got[0].raw);
    expect(mail.subject).toBe("Your appointment");
    expect(mail.text).toContain("See you Monday at 9.");
    expect(mail.from?.text).toContain("appointments@clinic.test");
    expect(mail.replyTo?.text).toContain("front@clinic.test");
    expect(mail.messageId).toBe("<m-1@clinic.test>");
    expect(mail.headers.get("auto-submitted")).toBe("auto-generated");
  });

  it("fails with the status code only, never the provider's text, which repeats the address", async () => {
    const s = await smtpServer({ reject: true });
    const m = new SmtpMailer({ host: "127.0.0.1", port: s.port, secure: false, from: "a@clinic.test", allowInsecure: true });
    const err = await m.send(msg()).catch((e) => e as Error);
    expect(String(err)).toBe("Error: SMTP 550");
    expect(String(err)).not.toContain("pat@example.com");
  });

  it("refuses wrong credentials and texts, and will not talk plain-text to a server that offers no encryption", async () => {
    const s = await smtpServer({ auth: true });
    const bad = new SmtpMailer({ host: "127.0.0.1", port: s.port, secure: false, user: "u", pass: "nope", from: "a@clinic.test", allowInsecure: true });
    await expect(bad.send(msg())).rejects.toThrow(/^SMTP/);
    await expect(bad.send(msg({ channel: "sms", to: "07700900123" }))).rejects.toThrow(/email only/);
    const strict = new SmtpMailer({ host: "127.0.0.1", port: s.port, secure: false, user: "u", pass: "p", from: "a@clinic.test" });
    await expect(strict.send(msg())).rejects.toThrow(/^SMTP/);
    expect(s.got).toHaveLength(0);
  });
});

describe("Twilio texts", () => {
  it("normalises UK numbers", () => {
    expect(toE164("07700 900123")).toBe("+447700900123");
    expect(toE164("+44 (0)7700 900123")).toBe("+447700900123"); // the bracketed 0 is the national prefix
    expect(toE164("+447700900123")).toBe("+447700900123");
    expect(toE164("00447700900123")).toBe("+447700900123");
    expect(toE164("7700900123")).toBeNull();
    expect(toE164("0")).toBeNull();
    expect(toE164("not a number")).toBeNull();
  });

  it("posts the message with basic auth and an international number", async () => {
    const t = await twilioServer();
    const m = new TwilioSms({ accountSid: "AC123", authToken: "tok", from: "TestPhysio", baseUrl: t.base });
    await m.send(msg({ channel: "sms", to: "07700 900123", body: "Reminder: Monday 9am" }));
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0].url).toBe("/2010-04-01/Accounts/AC123/Messages.json");
    expect(t.seen[0].auth).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`);
    expect(Object.fromEntries(t.seen[0].form)).toEqual({ To: "+447700900123", From: "TestPhysio", Body: "Reminder: Monday 9am" });
  });

  it("reports the status and Twilio's code but not its message, and refuses emails and bad numbers", async () => {
    const t = await twilioServer({ status: 400, body: { code: 21211, message: "The 'To' number +447700900123 is not a valid phone number" } });
    const m = new TwilioSms({ accountSid: "AC123", authToken: "tok", from: "X", baseUrl: t.base });
    const err = await m.send(msg({ channel: "sms", to: "07700900123" })).catch((e) => e as Error);
    expect(String(err)).toBe("Error: Twilio 400 code 21211");
    await expect(m.send(msg())).rejects.toThrow(/texts only/);
    await expect(m.send(msg({ channel: "sms", to: "nonsense" }))).rejects.toThrow(/valid phone/);
    expect(t.seen).toHaveLength(1);
  });

  it("copes with the service being unreachable", async () => {
    const m = new TwilioSms({ accountSid: "AC", authToken: "t", from: "X", baseUrl: "http://127.0.0.1:1" });
    await expect(m.send(msg({ channel: "sms", to: "07700900123" }))).rejects.toThrow("Twilio: could not be reached");
  });
});

describe("choosing providers", () => {
  it("uses the development mailer when nothing is set", () => {
    const m = createMailer({});
    expect(m).toBeInstanceOf(DevMailer);
    expect(m.isReal).toBe(false);
  });

  it("builds real providers from the environment and routes by channel", async () => {
    const m = createMailer({ SMTP_HOST: "smtp.example", SMTP_FROM: "a@b.test", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "X" }) as RoutingMailer;
    expect(m.isReal).toBe(true);
    expect(m.channels).toEqual({ email: true, sms: true });
    const emailOnly = createMailer({ SMTP_HOST: "smtp.example", SMTP_FROM: "a@b.test" }) as RoutingMailer;
    await expect(emailOnly.send(msg({ channel: "sms", to: "07700900123" }))).rejects.toThrow("No text provider is set up");
  });

  it("refuses a half-filled configuration at start-up", () => {
    expect(() => createMailer({ SMTP_HOST: "smtp.example" })).toThrow(/SMTP_FROM/);
    expect(() => createMailer({ SMTP_HOST: "h", SMTP_FROM: "a@b.test", SMTP_USER: "u" })).toThrow(/both SMTP_USER and SMTP_PASS/);
    expect(() => createMailer({ SMTP_HOST: "h", SMTP_FROM: "a@b.test", SMTP_PORT: "abc" })).toThrow(/SMTP_PORT/);
    expect(() => createMailer({ TWILIO_ACCOUNT_SID: "AC1" })).toThrow(/together/);
  });
});

describe("through the outbox", () => {
  it("a queued confirmation reaches the SMTP server once, and a rejected one is retried and then recorded without the address", async () => {
    const s = await platformSetup();
    const smtp = await smtpServer();
    const real = createPlatform(s.db, { now: () => s.clock.now, baseUrl: () => "https://clinic.test", mailer: new SmtpMailer({ host: "127.0.0.1", port: smtp.port, secure: false, from: "Test <a@clinic.test>", allowInsecure: true }) });
    await real.outbox.queue({ clinicId: s.clinicId, channel: "email", to: "pat@example.com", subject: "Hello", body: "Body", kind: "confirmation", key: "k1" });
    expect(await real.outbox.queue({ clinicId: s.clinicId, channel: "email", to: "pat@example.com", subject: "Hello", body: "Body", kind: "confirmation", key: "k1" })).toBe(false);
    await real.tick();
    await real.tick();
    expect(smtp.got).toHaveLength(1);
    expect((await real.outbox.list(s.clinicId)).find((m) => m.kind === "confirmation" && m.to_addr === "pat@example.com" && m.subject === "Hello")?.status).toBe("sent");

    const bad = await smtpServer({ reject: true });
    const failing = createPlatform(s.db, { now: () => s.clock.now, baseUrl: () => "https://clinic.test", mailer: new SmtpMailer({ host: "127.0.0.1", port: bad.port, secure: false, from: "a@clinic.test", allowInsecure: true }) });
    await failing.outbox.queue({ clinicId: s.clinicId, channel: "email", to: "pat@example.com", subject: "Second", body: "Body", kind: "reminder", key: "k2" });
    const out = await failing.tick();
    expect(out.failed).toBe(1);
    const row = (await failing.outbox.list(s.clinicId)).find((m) => m.subject === "Second")!;
    expect(row.status).toBe("queued"); // will be retried
    expect(row.error).toBe("SMTP 550");
  });
});
