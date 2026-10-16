import { normaliseVatNumber } from "./vat";
import type { CardProvider } from "./payments/stripe";
import crypto from "node:crypto";
import type { SessionUser } from "./accounts";
import type { Db } from "./db";
import { DomainError } from "./errors";
import type { Scheduling } from "./scheduling";
import { dayBounds, formatLocal, isDate, utcToZoned, zonedToUtc } from "./tz";
import type { Issue } from "./validation";

export type PayerType = "self" | "insurer";
export type PaymentMethod = "cash" | "card" | "bank_transfer" | "cheque" | "insurer" | "other";
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "card", "bank_transfer", "cheque", "insurer", "other"];
export type InvoiceStatus = "unpaid" | "part_paid" | "paid" | "overdue" | "credited" | "credit_note";

export interface BillingSettings {
  invoicePrefix: string;
  creditPrefix: string;
  /** VAT rate in basis points (2000 = 20%). Zero for a practice that is not VAT registered. */
  vatRateBp: number;
  /** UK VAT registration number, "GB" and digits. Required whenever the VAT rate is above zero. */
  vatNumber: string;
  billingDetails: string;
  paymentTermsDays: number;
}

export interface InvoiceLine {
  position: number;
  description: string;
  quantity: number;
  unitPence: number;
  netPence: number;
  vatBp: number;
  vatPence: number;
}

export interface PaymentRow {
  id: string;
  amountPence: number;
  method: PaymentMethod;
  receivedAt: string;
  reference: string;
  reversesPaymentId: string | null;
  /** True when a later entry has reversed this payment. */
  reversed: boolean;
  recordedBy: string;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  kind: "invoice" | "credit_note";
  patientId: string;
  patientName: string;
  issuedAt: string;
  dueAt: string;
  totalPence: number;
  paidPence: number;
  balancePence: number;
  status: InvoiceStatus;
  payerType: PayerType;
  payerName: string;
}

export interface InvoiceView extends InvoiceSummary {
  appointmentId: string | null;
  creditsInvoiceId: string | null;
  creditsNumber: string | null;
  creditedById: string | null;
  creditedByNumber: string | null;
  claimRef: string;
  note: string;
  /** The VAT number printed on this invoice. Empty when no VAT was charged. */
  vatNumber: string;
  subtotalPence: number;
  vatPence: number;
  createdBy: string;
  lines: InvoiceLine[];
  payments: PaymentRow[];
}

export interface BillingSummary {
  from: string;
  to: string;
  invoicedPence: number;
  creditedPence: number;
  collectedPence: number;
  byMethod: { method: PaymentMethod; pence: number }[];
  /** Money still owed on every open invoice, whatever its date. */
  outstandingPence: number;
  overduePence: number;
  invoiceCount: number;
}

export interface LineInput {
  description: string;
  quantity: number;
  unitPence: number;
}

export interface InvoiceInput {
  patientId: string;
  lines: LineInput[];
  payerType?: PayerType;
  payerName?: string;
  claimRef?: string;
  note?: string;
  appointmentId?: string | null;
}

const MAX_LINES = 50;
const MAX_UNIT = 10_000_000; // £100,000
const MAX_QTY = 1000;
const MAX_NET = 100_000_000; // £1,000,000 per line, safely inside a 32-bit column
const PREFIX = /^[A-Z0-9-]{1,8}$/;

function issue(path: string, message: string): Issue {
  return { path, message };
}

function vatOn(net: number, bp: number): number {
  return Math.round((net * bp) / 10_000);
}

interface Row {
  [k: string]: unknown;
}

/**
 * Invoices, payments and credit notes.
 *
 * Everything here is append-only (the database role cannot update or delete these tables). Invoice numbers
 * run without gaps because the counter is advanced in the same transaction that writes the invoice. A mistake
 * is corrected by a credit note, which is allowed only while nothing has been paid on the invoice; a payment
 * taken in error is reversed by a negative entry.
 *
 * Billing is open to the owner and to reception; clinicians are not given access to the takings.
 */
export class Billing {
  private card: CardProvider | null = null;

  constructor(
    private db: Db,
    private scheduling: Scheduling,
    private now: () => Date = () => new Date(),
  ) {}

  /** Switches on card payment links. Without a provider there are none. */
  setCardProvider(card: CardProvider | null) {
    this.card = card;
  }

  get cardPaymentsEnabled(): boolean {
    return this.card !== null;
  }

  private ts() {
    return this.now().toISOString();
  }

  private allow(actor: SessionUser) {
    if (actor.role === "clinician") throw new DomainError("forbidden", "Billing is handled by the owner and reception");
  }

  // ---------------------------------------------------------------- settings

  async getSettings(clinicId: string): Promise<BillingSettings> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get<Row>(
        "SELECT invoice_prefix, credit_prefix, vat_rate_bp, vat_number, billing_details, payment_terms_days FROM clinics WHERE id = ?",
        [clinicId],
      );
      if (!r) throw new DomainError("not_found", "Clinic not found");
      return {
        invoicePrefix: r.invoice_prefix as string,
        creditPrefix: r.credit_prefix as string,
        vatRateBp: Number(r.vat_rate_bp),
        vatNumber: r.vat_number as string,
        billingDetails: r.billing_details as string,
        paymentTermsDays: Number(r.payment_terms_days),
      };
    });
  }

  async saveSettings(actor: SessionUser, input: BillingSettings): Promise<void> {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can change billing settings");
    const issues: Issue[] = [];
    const inv = input.invoicePrefix.trim().toUpperCase();
    const cn = input.creditPrefix.trim().toUpperCase();
    if (!PREFIX.test(inv)) issues.push(issue("invoicePrefix", "Use up to 8 letters, numbers or hyphens"));
    if (!PREFIX.test(cn)) issues.push(issue("creditPrefix", "Use up to 8 letters, numbers or hyphens"));
    if (PREFIX.test(inv) && inv === cn) issues.push(issue("creditPrefix", "Credit notes need a different prefix from invoices"));
    if (!Number.isInteger(input.vatRateBp) || input.vatRateBp < 0 || input.vatRateBp > 10_000) issues.push(issue("vatRate", "Enter a VAT rate from 0 to 100"));
    const vatNumber = input.vatNumber.trim() ? normaliseVatNumber(input.vatNumber) : "";
    if (vatNumber === null) issues.push(issue("vatNumber", "That does not look like a UK VAT number. It is nine digits, for example GB 980 7806 84"));
    else if (!vatNumber && input.vatRateBp > 0) issues.push(issue("vatNumber", "Enter your VAT registration number. An invoice that charges VAT must show it"));
    if (!Number.isInteger(input.paymentTermsDays) || input.paymentTermsDays < 0 || input.paymentTermsDays > 365) issues.push(issue("paymentTermsDays", "Enter 0 to 365 days"));
    if (input.billingDetails.length > 1000) issues.push(issue("billingDetails", "Keep the details under 1,000 characters"));
    if (issues.length) throw new DomainError("validation", "Check the billing settings", issues);
    await this.db.scope(actor.clinicId, async () => {
      await this.db.run(
        "UPDATE clinics SET invoice_prefix = ?, credit_prefix = ?, vat_rate_bp = ?, vat_number = ?, billing_details = ?, payment_terms_days = ? WHERE id = ?",
        [inv, cn, input.vatRateBp, vatNumber ?? "", input.billingDetails.trim(), input.paymentTermsDays, actor.clinicId],
      );
      await this.scheduling.audit(actor.clinicId, actor.email, "billing.settings_changed", "clinic", { vatRateBp: input.vatRateBp });
    });
  }

  // ---------------------------------------------------------------- invoices

  /** Takes the next number for invoices or credit notes. Runs inside the caller's transaction, so a failure leaves no gap. */
  private async nextNumber(clinicId: string, kind: "invoice" | "credit_note"): Promise<string> {
    const col = kind === "invoice" ? "next_invoice_number" : "next_credit_number";
    const pre = kind === "invoice" ? "invoice_prefix" : "credit_prefix";
    const r = await this.db.get<{ n: string | number; prefix: string }>(
      `UPDATE clinics SET ${col} = ${col} + 1 WHERE id = ? RETURNING ${col} - 1 AS n, ${pre} AS prefix`,
      [clinicId],
    );
    if (!r) throw new DomainError("not_found", "Clinic not found");
    return `${r.prefix}-${String(Number(r.n)).padStart(6, "0")}`;
  }

  private lineIssues(lines: LineInput[]): Issue[] {
    const issues: Issue[] = [];
    if (!lines.length) issues.push(issue("lines", "Add at least one line"));
    if (lines.length > MAX_LINES) issues.push(issue("lines", `No more than ${MAX_LINES} lines`));
    lines.forEach((l, i) => {
      if (!l.description.trim() || l.description.length > 200) issues.push(issue(`lines.${i}.description`, "Describe the line in up to 200 characters"));
      if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY) issues.push(issue(`lines.${i}.quantity`, `Quantity must be 1 to ${MAX_QTY}`));
      if (!Number.isInteger(l.unitPence) || l.unitPence < 1 || l.unitPence > MAX_UNIT) issues.push(issue(`lines.${i}.unitPence`, "Enter a price above £0"));
      else if (Number.isInteger(l.quantity) && l.quantity * l.unitPence > MAX_NET) issues.push(issue(`lines.${i}.unitPence`, "That line comes to too much"));
    });
    return issues;
  }

  async createInvoice(actor: SessionUser, input: InvoiceInput): Promise<string> {
    this.allow(actor);
    const issues = this.lineIssues(input.lines);
    const payerType = input.payerType ?? "self";
    const payerName = (input.payerName ?? "").trim();
    if (payerType !== "self" && payerType !== "insurer") issues.push(issue("payerType", "Choose who pays"));
    if (payerType === "insurer" && !payerName) issues.push(issue("payerName", "Enter the insurer's name"));
    if (payerName.length > 120) issues.push(issue("payerName", "Keep the name under 120 characters"));
    if ((input.claimRef ?? "").length > 80) issues.push(issue("claimRef", "Keep the reference under 80 characters"));
    if ((input.note ?? "").length > 500) issues.push(issue("note", "Keep the note under 500 characters"));
    if (issues.length) throw new DomainError("validation", "Check the invoice", issues);

    return this.db.scope(actor.clinicId, async () => {
      const patient = await this.db.get("SELECT 1 FROM patients WHERE id = ? AND clinic_id = ?", [input.patientId, actor.clinicId]);
      if (!patient) throw new DomainError("not_found", "Patient not found");
      if (input.appointmentId) {
        const a = await this.db.get("SELECT patient_id FROM appointments WHERE id = ? AND clinic_id = ?", [input.appointmentId, actor.clinicId]);
        if (!a) throw new DomainError("not_found", "Appointment not found");
        if (a.patient_id !== input.patientId) throw new DomainError("validation", "That appointment belongs to a different patient");
        await this.db.lock(`appt-invoice:${input.appointmentId}`);
        if (await this.liveInvoiceFor(input.appointmentId)) {
          throw new DomainError("conflict", "This appointment already has an invoice. Cancel it with a credit note before issuing another.");
        }
      }
      const settings = await this.getSettings(actor.clinicId);
      if (settings.vatRateBp > 0 && !settings.vatNumber) {
        throw new DomainError("invalid_state", "VAT is switched on but no VAT registration number is saved. Add it in Settings, under Billing, then issue the invoice.");
      }
      const vatNumber = settings.vatRateBp > 0 ? settings.vatNumber : "";

      const lines = input.lines.map((l, i) => {
        const net = l.quantity * l.unitPence;
        return { position: i + 1, description: l.description.trim(), quantity: l.quantity, unitPence: l.unitPence, netPence: net, vatBp: settings.vatRateBp, vatPence: vatOn(net, settings.vatRateBp) };
      });
      const subtotal = lines.reduce((s, l) => s + l.netPence, 0);
      const vat = lines.reduce((s, l) => s + l.vatPence, 0);
      const issued = this.now();
      const due = new Date(issued.getTime() + settings.paymentTermsDays * 86_400_000);
      const id = crypto.randomUUID();
      const number = await this.nextNumber(actor.clinicId, "invoice");
      await this.db.run(
        `INSERT INTO invoices (id, clinic_id, number, kind, patient_id, appointment_id, credits_invoice_id, payer_type, payer_name, claim_ref, note,
           issued_at, due_at, subtotal_pence, vat_pence, total_pence, created_by, vat_number)
         VALUES (?, ?, ?, 'invoice', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, actor.clinicId, number, input.patientId, input.appointmentId ?? null, payerType, payerName, (input.claimRef ?? "").trim(), (input.note ?? "").trim(),
          issued.toISOString(), due.toISOString(), subtotal, vat, subtotal + vat, actor.email, vatNumber],
      );
      await this.insertLines(actor.clinicId, id, lines);
      await this.scheduling.audit(actor.clinicId, actor.email, "invoice.issued", "invoice", { invoiceId: id, number, totalPence: subtotal + vat });
      return id;
    });
  }

  private async insertLines(clinicId: string, invoiceId: string, lines: InvoiceLine[]) {
    for (const l of lines) {
      await this.db.run(
        "INSERT INTO invoice_lines (id, clinic_id, invoice_id, position, description, quantity, unit_pence, net_pence, vat_bp, vat_pence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), clinicId, invoiceId, l.position, l.description, l.quantity, l.unitPence, l.netPence, l.vatBp, l.vatPence],
      );
    }
  }

  /** The invoice for an appointment that has not been cancelled by a credit note, if there is one. */
  private async liveInvoiceFor(appointmentId: string): Promise<string | null> {
    const r = await this.db.get<{ id: string }>(
      `SELECT i.id FROM invoices i WHERE i.appointment_id = ? AND i.kind = 'invoice'
         AND NOT EXISTS (SELECT 1 FROM invoices c WHERE c.credits_invoice_id = i.id)`,
      [appointmentId],
    );
    return r?.id ?? null;
  }

  async liveInvoiceForAppointment(clinicId: string, appointmentId: string): Promise<InvoiceSummary | null> {
    return this.db.scope(clinicId, async () => {
      const id = await this.liveInvoiceFor(appointmentId);
      if (!id) return null;
      return this.summaryOf(clinicId, id);
    });
  }

  /** Invoices an attended appointment at the price of its appointment type. */
  async invoiceForAppointment(
    actor: SessionUser,
    appointmentId: string,
    opts: { payerType?: PayerType; payerName?: string; claimRef?: string } = {},
  ): Promise<string> {
    this.allow(actor);
    return this.db.scope(actor.clinicId, async () => {
      const a = await this.scheduling.getAppointment(actor.clinicId, appointmentId);
      if (a.status !== "completed" && a.status !== "arrived") {
        throw new DomainError("invalid_state", "Only an appointment that has been attended can be invoiced");
      }
      const type = await this.scheduling.getType(actor.clinicId, a.typeId);
      if (type.pricePence <= 0) {
        throw new DomainError("validation", `${type.name} has no price yet. Set one in Settings, or write the invoice by hand.`);
      }
      const clinic = await this.scheduling.clinic(actor.clinicId);
      const when = formatLocal(a.startAt, clinic.timezone, "date");
      return this.createInvoice(actor, {
        patientId: a.patientId,
        appointmentId: a.id,
        lines: [{ description: `${type.name} with ${a.clinicianName}, ${when}`, quantity: 1, unitPence: type.pricePence }],
        payerType: opts.payerType,
        payerName: opts.payerName,
        claimRef: opts.claimRef,
      });
    });
  }

  // ---------------------------------------------------------------- reading

  private status(r: { kind: string; total: number; paid: number; due: string; creditedBy: string | null }): InvoiceStatus {
    if (r.kind === "credit_note") return "credit_note";
    if (r.creditedBy) return "credited";
    if (r.paid >= r.total) return "paid";
    if (new Date(r.due).getTime() < this.now().getTime()) return "overdue";
    return r.paid > 0 ? "part_paid" : "unpaid";
  }

  private toSummary(r: Row): InvoiceSummary {
    const total = Number(r.total_pence);
    const paid = Number(r.paid);
    const creditedBy = (r.credited_by_id as string | null) ?? null;
    const kind = r.kind as "invoice" | "credit_note";
    const status = this.status({ kind, total, paid, due: r.due_at as string, creditedBy });
    return {
      id: r.id as string,
      number: r.number as string,
      kind,
      patientId: r.patient_id as string,
      patientName: `${r.first_name} ${r.last_name}`,
      issuedAt: r.issued_at as string,
      dueAt: r.due_at as string,
      totalPence: total,
      paidPence: paid,
      // A credited invoice and its credit note cancel; neither owes anything.
      balancePence: kind === "credit_note" || creditedBy ? 0 : total - paid,
      status,
      payerType: r.payer_type as PayerType,
      payerName: r.payer_name as string,
    };
  }

  private static readonly SUMMARY_SQL = `
    SELECT i.*, p.first_name, p.last_name,
      COALESCE((SELECT SUM(x.amount_pence) FROM payments x WHERE x.invoice_id = i.id), 0)::int AS paid,
      (SELECT c.id FROM invoices c WHERE c.credits_invoice_id = i.id) AS credited_by_id
    FROM invoices i JOIN patients p ON p.id = i.patient_id AND p.clinic_id = i.clinic_id`;

  private async summaryOf(clinicId: string, id: string): Promise<InvoiceSummary> {
    const r = await this.db.get<Row>(`${Billing.SUMMARY_SQL} WHERE i.id = ? AND i.clinic_id = ?`, [id, clinicId]);
    if (!r) throw new DomainError("not_found", "Invoice not found");
    return this.toSummary(r);
  }

  async getInvoice(clinicId: string, id: string): Promise<InvoiceView> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get<Row>(`${Billing.SUMMARY_SQL} WHERE i.id = ? AND i.clinic_id = ?`, [id, clinicId]);
      if (!r) throw new DomainError("not_found", "Invoice not found");
      const base = this.toSummary(r);
      const lines = (await this.db.all<Row>("SELECT * FROM invoice_lines WHERE invoice_id = ? AND clinic_id = ? ORDER BY position", [id, clinicId])).map((l) => ({
        position: Number(l.position),
        description: l.description as string,
        quantity: Number(l.quantity),
        unitPence: Number(l.unit_pence),
        netPence: Number(l.net_pence),
        vatBp: Number(l.vat_bp),
        vatPence: Number(l.vat_pence),
      }));
      const pay = await this.db.all<Row>(
        `SELECT x.*, EXISTS (SELECT 1 FROM payments y WHERE y.reverses_payment_id = x.id) AS reversed
         FROM payments x WHERE x.invoice_id = ? AND x.clinic_id = ? ORDER BY x.received_at, x.created_at, x.id`,
        [id, clinicId],
      );
      const payments: PaymentRow[] = pay.map((p) => ({
        id: p.id as string,
        amountPence: Number(p.amount_pence),
        method: p.method as PaymentMethod,
        receivedAt: p.received_at as string,
        reference: p.reference as string,
        reversesPaymentId: (p.reverses_payment_id as string | null) ?? null,
        reversed: !!p.reversed,
        recordedBy: p.recorded_by as string,
      }));
      const credited = r.credited_by_id
        ? await this.db.get<{ number: string }>("SELECT number FROM invoices WHERE id = ? AND clinic_id = ?", [r.credited_by_id, clinicId])
        : undefined;
      const credits = r.credits_invoice_id
        ? await this.db.get<{ number: string }>("SELECT number FROM invoices WHERE id = ? AND clinic_id = ?", [r.credits_invoice_id, clinicId])
        : undefined;
      return {
        ...base,
        appointmentId: (r.appointment_id as string | null) ?? null,
        creditsInvoiceId: (r.credits_invoice_id as string | null) ?? null,
        creditsNumber: credits?.number ?? null,
        creditedById: (r.credited_by_id as string | null) ?? null,
        creditedByNumber: credited?.number ?? null,
        claimRef: r.claim_ref as string,
        note: r.note as string,
        vatNumber: (r.vat_number as string) ?? "",
        subtotalPence: Number(r.subtotal_pence),
        vatPence: Number(r.vat_pence),
        createdBy: r.created_by as string,
        lines,
        payments,
      };
    });
  }

  async listInvoices(
    clinicId: string,
    opts: { status?: "outstanding" | "paid" | "all"; patientId?: string; from?: string; to?: string; limit?: number } = {},
  ): Promise<InvoiceSummary[]> {
    return this.db.scope(clinicId, async () => {
      const where = ["i.clinic_id = ?"];
      const params: unknown[] = [clinicId];
      if (opts.patientId) {
        where.push("i.patient_id = ?");
        params.push(opts.patientId);
      }
      if (opts.from || opts.to) {
        const tz = (await this.scheduling.clinic(clinicId)).timezone;
        if (opts.from) {
          if (!isDate(opts.from)) throw new DomainError("validation", "Choose a valid start date");
          where.push("i.issued_at >= ?");
          params.push(dayBounds(opts.from, tz).start.toISOString());
        }
        if (opts.to) {
          if (!isDate(opts.to)) throw new DomainError("validation", "Choose a valid end date");
          where.push("i.issued_at < ?");
          params.push(dayBounds(opts.to, tz).end.toISOString());
        }
      }
      const rows = await this.db.all<Row>(`${Billing.SUMMARY_SQL} WHERE ${where.join(" AND ")} ORDER BY i.issued_at DESC, i.number DESC LIMIT ?`, [
        ...params,
        Math.min(opts.limit ?? 500, 1000),
      ]);
      const all = rows.map((r) => this.toSummary(r));
      const status = opts.status ?? "all";
      if (status === "outstanding") return all.filter((i) => i.kind === "invoice" && i.balancePence > 0);
      if (status === "paid") return all.filter((i) => i.status === "paid");
      return all;
    });
  }

  /** What a patient currently owes: invoices less credit notes less payments. */
  async patientBalance(clinicId: string, patientId: string): Promise<number> {
    return this.db.scope(clinicId, async () => {
      const t = await this.db.get<{ n: string | number }>("SELECT COALESCE(SUM(total_pence), 0) AS n FROM invoices WHERE clinic_id = ? AND patient_id = ?", [clinicId, patientId]);
      const p = await this.db.get<{ n: string | number }>(
        "SELECT COALESCE(SUM(x.amount_pence), 0) AS n FROM payments x JOIN invoices i ON i.id = x.invoice_id AND i.clinic_id = x.clinic_id WHERE x.clinic_id = ? AND i.patient_id = ?",
        [clinicId, patientId],
      );
      return Number(t?.n ?? 0) - Number(p?.n ?? 0);
    });
  }

  // ---------------------------------------------------------------- payments

  async recordPayment(
    actor: SessionUser,
    invoiceId: string,
    input: { amountPence: number; method: PaymentMethod; receivedOn?: string; reference?: string },
  ): Promise<string> {
    this.allow(actor);
    const issues: Issue[] = [];
    if (!Number.isInteger(input.amountPence) || input.amountPence <= 0) issues.push(issue("amount", "Enter an amount above £0"));
    if (!PAYMENT_METHODS.includes(input.method)) issues.push(issue("method", "Choose how it was paid"));
    if ((input.reference ?? "").length > 80) issues.push(issue("reference", "Keep the reference under 80 characters"));
    if (input.receivedOn !== undefined && input.receivedOn !== "" && !isDate(input.receivedOn)) issues.push(issue("receivedOn", "Choose a valid date"));
    if (issues.length) throw new DomainError("validation", "Check the payment", issues);

    return this.db.scope(actor.clinicId, async () => {
      await this.db.lock(`invoice:${invoiceId}`);
      const inv = await this.summaryOf(actor.clinicId, invoiceId);
      if (inv.kind !== "invoice") throw new DomainError("invalid_state", "A credit note cannot be paid");
      if (inv.status === "credited") throw new DomainError("invalid_state", "This invoice has been cancelled by a credit note");
      if (input.amountPence > inv.balancePence) {
        throw new DomainError("validation", "That is more than is owed on this invoice", [issue("amount", "Enter no more than the balance")]);
      }
      const tz = (await this.scheduling.clinic(actor.clinicId)).timezone;
      let received = this.now();
      if (input.receivedOn) {
        if (input.receivedOn > utcToZoned(this.now(), tz).date) throw new DomainError("validation", "A payment cannot be dated in the future", [issue("receivedOn", "Choose today or earlier")]);
        const at = zonedToUtc(input.receivedOn, 12 * 60, tz);
        if (!at) throw new DomainError("validation", "Choose a valid date", [issue("receivedOn", "Choose a valid date")]);
        received = at;
      }
      const id = crypto.randomUUID();
      await this.db.run(
        `INSERT INTO payments (id, clinic_id, invoice_id, amount_pence, method, received_at, reference, reverses_payment_id, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [id, actor.clinicId, invoiceId, input.amountPence, input.method, received.toISOString(), (input.reference ?? "").trim(), actor.email, this.ts()],
      );
      await this.scheduling.audit(actor.clinicId, actor.email, "payment.recorded", "invoice", { invoiceId, paymentId: id, amountPence: input.amountPence, method: input.method });
      return id;
    });
  }

  /**
   * A link the patient opens to pay what is owed on an invoice by card, on the card provider's own page. Card
   * details never touch Fettle. The money is recorded when the provider tells us it has been paid (see
   * applyCardPayment), not when the link is made.
   */
  async createCardLink(actor: SessionUser, invoiceId: string, baseUrl: string): Promise<{ url: string; amountPence: number }> {
    this.allow(actor);
    if (!this.card) throw new DomainError("invalid_state", "Card payments are not switched on for this clinic");
    const card = this.card;
    const inv = await this.db.scope(actor.clinicId, () => this.summaryOf(actor.clinicId, invoiceId));
    if (inv.kind !== "invoice") throw new DomainError("invalid_state", "A credit note cannot be paid");
    if (inv.status === "credited") throw new DomainError("invalid_state", "This invoice has been cancelled by a credit note");
    if (inv.balancePence <= 0) throw new DomainError("invalid_state", "Nothing is owed on this invoice");
    if (inv.balancePence < 30) throw new DomainError("invalid_state", "Card payments need at least £0.30. Record this one another way");
    if (inv.payerType === "insurer") throw new DomainError("invalid_state", "This invoice is billed to an insurer, not the patient");
    // The network call happens outside any open transaction.
    const session = await card.createCheckout({
      amountPence: inv.balancePence,
      description: `Invoice ${inv.number}`,
      invoiceId,
      clinicId: actor.clinicId,
      successUrl: `${baseUrl}/pay/thanks`,
      cancelUrl: `${baseUrl}/pay/cancelled`,
      idempotencyKey: `${invoiceId}:${inv.balancePence}:${Math.floor(this.now().getTime() / 600_000)}`,
      expiresAt: new Date(this.now().getTime() + 24 * 3_600_000),
    });
    await this.db.scope(actor.clinicId, () => this.scheduling.audit(actor.clinicId, actor.email, "payment.link_created", "invoice", { invoiceId, amountPence: inv.balancePence }));
    return { url: session.url, amountPence: inv.balancePence };
  }

  /**
   * Records a card payment the provider reports as complete. Safe to call twice for the same payment. If the money
   * cannot be applied (the invoice was cancelled, already paid another way, or does not exist) nothing is
   * recorded and the case is written to the audit log for a person to deal with, usually by refunding in the
   * provider's dashboard. The caller must already have verified that the notification is genuine.
   */
  async applyCardPayment(clinicId: string, p: { invoiceId: string; amountPence: number; externalId: string; paidAt?: Date }): Promise<"recorded" | "duplicate" | "unapplied"> {
    if (!Number.isInteger(p.amountPence) || p.amountPence <= 0 || !p.externalId) throw new DomainError("validation", "Not a valid card payment");
    return this.db.scope(clinicId, async () => {
      await this.db.lock(`invoice:${p.invoiceId}`);
      if (await this.db.get("SELECT 1 FROM payments WHERE clinic_id = ? AND external_id = ?", [clinicId, p.externalId])) return "duplicate";
      const unapplied = async (reason: string) => {
        await this.scheduling.audit(clinicId, "stripe", "payment.unapplied", "invoice", { invoiceId: p.invoiceId, amountPence: p.amountPence, externalId: p.externalId, reason });
        return "unapplied" as const;
      };
      const row = await this.db.get<Row>(`${Billing.SUMMARY_SQL} WHERE i.id = ? AND i.clinic_id = ?`, [p.invoiceId, clinicId]);
      if (!row) return unapplied("invoice not found");
      const inv = this.toSummary(row);
      if (inv.kind !== "invoice") return unapplied("not an invoice");
      if (inv.status === "credited") return unapplied("invoice was cancelled");
      if (p.amountPence > inv.balancePence) return unapplied("more than the balance owed");
      await this.db.run(
        `INSERT INTO payments (id, clinic_id, invoice_id, amount_pence, method, received_at, reference, reverses_payment_id, recorded_by, created_at, external_id)
         VALUES (?, ?, ?, ?, 'card', ?, 'Card payment (Stripe)', NULL, 'stripe', ?, ?)`,
        [crypto.randomUUID(), clinicId, p.invoiceId, p.amountPence, (p.paidAt ?? this.now()).toISOString(), this.ts(), p.externalId],
      );
      await this.scheduling.audit(clinicId, "stripe", "payment.recorded", "invoice", { invoiceId: p.invoiceId, amountPence: p.amountPence, method: "card", externalId: p.externalId });
      return "recorded";
    });
  }

  /** Takes back a payment entered in error. The original stays on the record; a negative entry cancels it. */
  async reversePayment(actor: SessionUser, paymentId: string, reason: string): Promise<string> {
    this.allow(actor);
    if (!reason.trim()) throw new DomainError("validation", "Say why", [issue("reason", "Give a reason")]);
    if (reason.length > 200) throw new DomainError("validation", "Keep the reason short", [issue("reason", "Keep it under 200 characters")]);
    return this.db.scope(actor.clinicId, async () => {
      const p = await this.db.get<Row>("SELECT * FROM payments WHERE id = ? AND clinic_id = ?", [paymentId, actor.clinicId]);
      if (!p) throw new DomainError("not_found", "Payment not found");
      if (p.reverses_payment_id) throw new DomainError("invalid_state", "That entry is itself a reversal");
      await this.db.lock(`invoice:${p.invoice_id}`);
      const done = await this.db.get("SELECT 1 FROM payments WHERE reverses_payment_id = ? AND clinic_id = ?", [paymentId, actor.clinicId]);
      if (done) throw new DomainError("conflict", "This payment has already been reversed");
      const id = crypto.randomUUID();
      await this.db.run(
        `INSERT INTO payments (id, clinic_id, invoice_id, amount_pence, method, received_at, reference, reverses_payment_id, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, actor.clinicId, p.invoice_id, -Number(p.amount_pence), p.method, this.ts(), `Reversal: ${reason.trim()}`, paymentId, actor.email, this.ts()],
      );
      await this.scheduling.audit(actor.clinicId, actor.email, "payment.reversed", "invoice", { invoiceId: p.invoice_id, paymentId, reason: reason.trim() });
      return id;
    });
  }

  // ---------------------------------------------------------------- credit notes

  /**
   * Cancels a whole invoice. The credit note repeats its lines with the amounts negated and takes its own
   * number. Allowed only when nothing is held against the invoice: reverse any payments first.
   */
  async creditInvoice(actor: SessionUser, invoiceId: string, reason: string): Promise<string> {
    this.allow(actor);
    if (!reason.trim()) throw new DomainError("validation", "Say why", [issue("reason", "Give a reason")]);
    if (reason.length > 300) throw new DomainError("validation", "Keep the reason short", [issue("reason", "Keep it under 300 characters")]);
    return this.db.scope(actor.clinicId, async () => {
      await this.db.lock(`invoice:${invoiceId}`);
      const inv = await this.getInvoice(actor.clinicId, invoiceId);
      if (inv.kind !== "invoice") throw new DomainError("invalid_state", "A credit note cannot be credited");
      if (inv.creditedById) throw new DomainError("conflict", "This invoice has already been cancelled");
      if (inv.paidPence !== 0) {
        throw new DomainError("invalid_state", "Payments are recorded against this invoice. Reverse them first, then cancel the invoice.");
      }
      const id = crypto.randomUUID();
      const number = await this.nextNumber(actor.clinicId, "credit_note");
      const now = this.now().toISOString();
      await this.db.run(
        `INSERT INTO invoices (id, clinic_id, number, kind, patient_id, appointment_id, credits_invoice_id, payer_type, payer_name, claim_ref, note,
           issued_at, due_at, subtotal_pence, vat_pence, total_pence, created_by, vat_number)
         VALUES (?, ?, ?, 'credit_note', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, actor.clinicId, number, inv.patientId, inv.appointmentId, invoiceId, inv.payerType, inv.payerName, inv.claimRef, reason.trim(), now, now,
          -inv.subtotalPence, -inv.vatPence, -inv.totalPence, actor.email, inv.vatNumber],
      );
      await this.insertLines(
        actor.clinicId,
        id,
        inv.lines.map((l) => ({ ...l, quantity: -l.quantity, netPence: -l.netPence, vatPence: -l.vatPence })),
      );
      await this.scheduling.audit(actor.clinicId, actor.email, "invoice.credited", "invoice", { invoiceId, creditNoteId: id, number, reason: reason.trim() });
      return id;
    });
  }

  // ---------------------------------------------------------------- figures

  async summary(clinicId: string, from: string, to: string): Promise<BillingSummary> {
    if (!isDate(from) || !isDate(to) || to < from) throw new DomainError("validation", "Choose a start date that is on or before the end date");
    return this.db.scope(clinicId, async () => {
      const tz = (await this.scheduling.clinic(clinicId)).timezone;
      const a = dayBounds(from, tz).start.toISOString();
      const b = dayBounds(to, tz).end.toISOString();
      const n = async (sql: string, params: unknown[]) => Number((await this.db.get<{ n: string | number }>(sql, params))?.n ?? 0);
      const invoiced = await n("SELECT COALESCE(SUM(total_pence),0) AS n FROM invoices WHERE clinic_id = ? AND kind = 'invoice' AND issued_at >= ? AND issued_at < ?", [clinicId, a, b]);
      const count = await n("SELECT COUNT(*) AS n FROM invoices WHERE clinic_id = ? AND kind = 'invoice' AND issued_at >= ? AND issued_at < ?", [clinicId, a, b]);
      const credited = await n("SELECT COALESCE(-SUM(total_pence),0) AS n FROM invoices WHERE clinic_id = ? AND kind = 'credit_note' AND issued_at >= ? AND issued_at < ?", [clinicId, a, b]);
      const methods = await this.db.all<{ method: PaymentMethod; n: string | number }>(
        "SELECT method, SUM(amount_pence) AS n FROM payments WHERE clinic_id = ? AND received_at >= ? AND received_at < ? GROUP BY method ORDER BY method",
        [clinicId, a, b],
      );
      const byMethod = methods.map((m) => ({ method: m.method, pence: Number(m.n) })).filter((m) => m.pence !== 0);
      const open = `SELECT i.total_pence - COALESCE((SELECT SUM(x.amount_pence) FROM payments x WHERE x.invoice_id = i.id), 0) AS bal, i.due_at
                    FROM invoices i WHERE i.clinic_id = ? AND i.kind = 'invoice'
                      AND NOT EXISTS (SELECT 1 FROM invoices c WHERE c.credits_invoice_id = i.id)`;
      const outstanding = await n(`SELECT COALESCE(SUM(bal),0) AS n FROM (${open}) q WHERE bal > 0`, [clinicId]);
      const overdue = await n(`SELECT COALESCE(SUM(bal),0) AS n FROM (${open}) q WHERE bal > 0 AND due_at < ?`, [clinicId, this.ts()]);
      return {
        from,
        to,
        invoicedPence: invoiced,
        creditedPence: credited,
        collectedPence: byMethod.reduce((s, m) => s + m.pence, 0),
        byMethod,
        outstandingPence: outstanding,
        overduePence: overdue,
        invoiceCount: count,
      };
    });
  }
}
