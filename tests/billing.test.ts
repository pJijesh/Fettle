import { describe, expect, it } from "vitest";
import { formatPence, parsePounds } from "@/lib/money";
import { platformSetup, PW, type PlatformSetup } from "./platform.helpers";
import type { SessionUser } from "@/lib/accounts";

const MON_9 = "2026-10-19T08:00:00.000Z";

async function attended(s: PlatformSetup, typeId = s.initial.id, startAt = MON_9) {
  const id = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId, startAt, source: "staff" });
  await s.p.scheduling.markCompleted(s.clinicId, "u", id);
  return id;
}

async function priced(s: PlatformSetup, pence = 6000) {
  await s.p.scheduling.saveType(s.clinicId, "u", { id: s.initial.id, name: s.initial.name, durationMin: s.initial.durationMin, bufferMin: s.initial.bufferMin, onlineBookable: s.initial.onlineBookable, colour: s.initial.colour, pricePence: pence });
}

async function reception(s: PlatformSetup): Promise<SessionUser> {
  const id = await s.p.accounts.createUser(s.owner, { name: "Rae Reception", email: "rae@example.com", password: PW, role: "reception" });
  return { id, clinicId: s.clinicId, name: "Rae Reception", email: "rae@example.com", role: "reception" };
}

const manual = (s: PlatformSetup, over: Partial<Parameters<PlatformSetup["p"]["billing"]["createInvoice"]>[1]> = {}) => ({
  patientId: s.patient,
  lines: [{ description: "Sports massage", quantity: 1, unitPence: 5000 }],
  ...over,
});

describe("money", () => {
  it("formats and parses pence", () => {
    expect(formatPence(0)).toBe("£0.00");
    expect(formatPence(123456)).toBe("£1,234.56");
    expect(formatPence(-5000)).toBe("-£50.00");
    expect(parsePounds("60")).toBe(6000);
    expect(parsePounds("£1,200.5")).toBe(120050);
    expect(parsePounds("12.345")).toBeNull();
    expect(parsePounds("-3")).toBeNull();
    expect(parsePounds("abc")).toBeNull();
    expect(parsePounds("")).toBeNull();
  });
});

describe("prices and settings", () => {
  it("keeps a price on an appointment type and leaves it alone when a save omits it", async () => {
    const s = await platformSetup();
    await priced(s, 6500);
    expect((await s.p.scheduling.getType(s.clinicId, s.initial.id)).pricePence).toBe(6500);
    await s.p.scheduling.saveType(s.clinicId, "u", { id: s.initial.id, name: "Initial assessment", durationMin: 45, bufferMin: 0, onlineBookable: true, colour: s.initial.colour });
    expect((await s.p.scheduling.getType(s.clinicId, s.initial.id)).pricePence).toBe(6500);
    await expect(s.p.scheduling.saveType(s.clinicId, "u", { id: s.initial.id, name: "x", durationMin: 45, bufferMin: 0, onlineBookable: true, colour: s.initial.colour, pricePence: -1 })).rejects.toThrow();
  });

  it("lets only the owner change billing settings, and checks them", async () => {
    const s = await platformSetup();
    const rae = await reception(s);
    const ok = { invoicePrefix: "fx", creditPrefix: "cr", vatRateBp: 2000, billingDetails: "Fettle Physio\nPay by bank transfer", paymentTermsDays: 7 };
    await expect(s.p.billing.saveSettings(rae, ok)).rejects.toThrow(/owner/);
    await s.p.billing.saveSettings(s.owner, ok);
    expect(await s.p.billing.getSettings(s.clinicId)).toMatchObject({ invoicePrefix: "FX", creditPrefix: "CR", vatRateBp: 2000, paymentTermsDays: 7 });
    await expect(s.p.billing.saveSettings(s.owner, { ...ok, creditPrefix: "FX" })).rejects.toThrow(/Check the billing/);
    await expect(s.p.billing.saveSettings(s.owner, { ...ok, invoicePrefix: "bad prefix!" })).rejects.toThrow();
    await expect(s.p.billing.saveSettings(s.owner, { ...ok, vatRateBp: 10_001 })).rejects.toThrow();
  });
});

describe("invoices", () => {
  it("invoices an attended appointment at its type's price, with a number and a due date", async () => {
    const s = await platformSetup();
    await priced(s, 6000);
    const a = await attended(s);
    const id = await s.p.billing.invoiceForAppointment(s.owner, a);
    const inv = await s.p.billing.getInvoice(s.clinicId, id);
    expect(inv.number).toBe("INV-000001");
    expect(inv.totalPence).toBe(6000);
    expect(inv.status).toBe("unpaid");
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0].description).toMatch(/Initial assessment with Olive Owner/);
    expect(new Date(inv.dueAt).getTime() - new Date(inv.issuedAt).getTime()).toBe(14 * 86_400_000);
    expect(inv.patientName).toBe("Pat Jones");
  });

  it("refuses a future or cancelled appointment, a type with no price, and a second invoice", async () => {
    const s = await platformSetup();
    const booked = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    await priced(s, 6000);
    await expect(s.p.billing.invoiceForAppointment(s.owner, booked)).rejects.toThrow(/attended/);
    await s.p.scheduling.markCompleted(s.clinicId, "u", booked);
    const unpriced = await attended(s, s.followUp.id, "2026-10-20T08:00:00.000Z");
    await expect(s.p.billing.invoiceForAppointment(s.owner, unpriced)).rejects.toThrow(/no price/);
    await s.p.billing.invoiceForAppointment(s.owner, booked);
    await expect(s.p.billing.invoiceForAppointment(s.owner, booked)).rejects.toThrow(/already has an invoice/);
  });

  it("charges VAT per line at the clinic's rate and rounds to the penny", async () => {
    const s = await platformSetup();
    await s.p.billing.saveSettings(s.owner, { invoicePrefix: "INV", creditPrefix: "CN", vatRateBp: 2000, billingDetails: "", paymentTermsDays: 14 });
    const id = await s.p.billing.createInvoice(s.owner, manual(s, { lines: [{ description: "Insoles", quantity: 3, unitPence: 1999 }, { description: "Tape", quantity: 1, unitPence: 333 }] }));
    const inv = await s.p.billing.getInvoice(s.clinicId, id);
    expect(inv.subtotalPence).toBe(3 * 1999 + 333);
    expect(inv.lines.map((l) => l.vatPence)).toEqual([1199, 67]);
    expect(inv.vatPence).toBe(1266);
    expect(inv.totalPence).toBe(inv.subtotalPence + inv.vatPence);
  });

  it("numbers invoices one after another with no gaps, even when one fails", async () => {
    const s = await platformSetup();
    const a = await s.p.billing.createInvoice(s.owner, manual(s));
    await expect(s.p.billing.createInvoice(s.owner, manual(s, { patientId: "missing" }))).rejects.toThrow(/Patient not found/);
    const b = await s.p.billing.createInvoice(s.owner, manual(s));
    const nums = [(await s.p.billing.getInvoice(s.clinicId, a)).number, (await s.p.billing.getInvoice(s.clinicId, b)).number];
    expect(nums).toEqual(["INV-000001", "INV-000002"]);
  });

  it("hands out unique numbers to invoices created at the same moment", async () => {
    const s = await platformSetup();
    const ids = await Promise.all(Array.from({ length: 6 }, () => s.p.billing.createInvoice(s.owner, manual(s))));
    const numbers = await Promise.all(ids.map(async (i) => (await s.p.billing.getInvoice(s.clinicId, i)).number));
    expect(new Set(numbers).size).toBe(6);
    expect([...numbers].sort()).toEqual(["INV-000001", "INV-000002", "INV-000003", "INV-000004", "INV-000005", "INV-000006"]);
  });

  it("checks the lines and the payer", async () => {
    const s = await platformSetup();
    await expect(s.p.billing.createInvoice(s.owner, manual(s, { lines: [] }))).rejects.toThrow(/Check the invoice/);
    await expect(s.p.billing.createInvoice(s.owner, manual(s, { lines: [{ description: " ", quantity: 1, unitPence: 100 }] }))).rejects.toThrow();
    await expect(s.p.billing.createInvoice(s.owner, manual(s, { lines: [{ description: "x", quantity: 0, unitPence: 100 }] }))).rejects.toThrow();
    await expect(s.p.billing.createInvoice(s.owner, manual(s, { lines: [{ description: "x", quantity: 1, unitPence: 0 }] }))).rejects.toThrow();
    await expect(s.p.billing.createInvoice(s.owner, manual(s, { lines: [{ description: "x", quantity: 1000, unitPence: 10_000_000 }] }))).rejects.toThrow();
    await expect(s.p.billing.createInvoice(s.owner, manual(s, { payerType: "insurer" }))).rejects.toThrow(/Check the invoice/);
    const ok = await s.p.billing.createInvoice(s.owner, manual(s, { payerType: "insurer", payerName: "Bupa", claimRef: "C-123" }));
    expect(await s.p.billing.getInvoice(s.clinicId, ok)).toMatchObject({ payerType: "insurer", payerName: "Bupa", claimRef: "C-123" });
  });

  it("is open to reception and closed to clinicians", async () => {
    const s = await platformSetup();
    const rae = await reception(s);
    const sam: SessionUser = { id: s.secondId, clinicId: s.clinicId, name: "Sam Clinician", email: "sam@example.com", role: "clinician" };
    await expect(s.p.billing.createInvoice(sam, manual(s))).rejects.toThrow(/owner and reception/);
    await expect(s.p.billing.createInvoice(rae, manual(s))).resolves.toBeTruthy();
  });
});

describe("payments", () => {
  it("tracks part-payment, then paid, and refuses to take more than is owed", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    await s.p.billing.recordPayment(s.owner, id, { amountPence: 2000, method: "cash" });
    let inv = await s.p.billing.getInvoice(s.clinicId, id);
    expect(inv).toMatchObject({ status: "part_paid", paidPence: 2000, balancePence: 3000 });
    await expect(s.p.billing.recordPayment(s.owner, id, { amountPence: 3001, method: "card" })).rejects.toThrow(/more than is owed/);
    await s.p.billing.recordPayment(s.owner, id, { amountPence: 3000, method: "card", reference: "ch_123" });
    inv = await s.p.billing.getInvoice(s.clinicId, id);
    expect(inv).toMatchObject({ status: "paid", balancePence: 0 });
    await expect(s.p.billing.recordPayment(s.owner, id, { amountPence: 1, method: "cash" })).rejects.toThrow(/more than is owed/);
  });

  it("does not overpay when two payments arrive together", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    const results = await Promise.allSettled([
      s.p.billing.recordPayment(s.owner, id, { amountPence: 5000, method: "card" }),
      s.p.billing.recordPayment(s.owner, id, { amountPence: 5000, method: "card" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await s.p.billing.getInvoice(s.clinicId, id)).paidPence).toBe(5000);
  });

  it("checks amount, method and date", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    await expect(s.p.billing.recordPayment(s.owner, id, { amountPence: 0, method: "cash" })).rejects.toThrow(/Check the payment/);
    await expect(s.p.billing.recordPayment(s.owner, id, { amountPence: 10.5, method: "cash" })).rejects.toThrow();
    await expect(s.p.billing.recordPayment(s.owner, id, { amountPence: 100, method: "bitcoin" as never })).rejects.toThrow();
    await expect(s.p.billing.recordPayment(s.owner, id, { amountPence: 100, method: "cash", receivedOn: "2026-12-25" })).rejects.toThrow(/future/);
    await expect(s.p.billing.recordPayment(s.owner, id, { amountPence: 100, method: "cash", receivedOn: "not a date" })).rejects.toThrow();
    await s.p.billing.recordPayment(s.owner, id, { amountPence: 100, method: "cash", receivedOn: "2026-10-10" });
    const [p] = (await s.p.billing.getInvoice(s.clinicId, id)).payments;
    expect(p.receivedAt.slice(0, 10)).toBe("2026-10-10");
  });

  it("becomes overdue after the due date and not before", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    expect((await s.p.billing.getInvoice(s.clinicId, id)).status).toBe("unpaid");
    s.clock.now = new Date(s.clock.now.getTime() + 15 * 86_400_000);
    expect((await s.p.billing.getInvoice(s.clinicId, id)).status).toBe("overdue");
    await s.p.billing.recordPayment(s.owner, id, { amountPence: 5000, method: "bank_transfer" });
    expect((await s.p.billing.getInvoice(s.clinicId, id)).status).toBe("paid");
  });

  it("reverses a payment once, keeping both entries on the record", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    const pay = await s.p.billing.recordPayment(s.owner, id, { amountPence: 5000, method: "card" });
    await expect(s.p.billing.reversePayment(s.owner, pay, "")).rejects.toThrow(/Say why/);
    await s.p.billing.reversePayment(s.owner, pay, "Card declined");
    const inv = await s.p.billing.getInvoice(s.clinicId, id);
    expect(inv).toMatchObject({ paidPence: 0, balancePence: 5000, status: "unpaid" });
    expect(inv.payments).toHaveLength(2);
    expect(inv.payments.find((p) => p.id === pay)!.reversed).toBe(true);
    await expect(s.p.billing.reversePayment(s.owner, pay, "again")).rejects.toThrow(/already been reversed/);
    const reversal = inv.payments.find((p) => p.reversesPaymentId)!;
    await expect(s.p.billing.reversePayment(s.owner, reversal.id, "x")).rejects.toThrow(/itself a reversal/);
  });
});

describe("credit notes", () => {
  it("cancels an unpaid invoice with a numbered credit note that mirrors it", async () => {
    const s = await platformSetup();
    await s.p.billing.saveSettings(s.owner, { invoicePrefix: "INV", creditPrefix: "CN", vatRateBp: 2000, billingDetails: "", paymentTermsDays: 14 });
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    await expect(s.p.billing.creditInvoice(s.owner, id, "")).rejects.toThrow(/Say why/);
    const cn = await s.p.billing.creditInvoice(s.owner, id, "Raised against the wrong patient");
    const credit = await s.p.billing.getInvoice(s.clinicId, cn);
    expect(credit).toMatchObject({ number: "CN-000001", kind: "credit_note", totalPence: -6000, subtotalPence: -5000, vatPence: -1000, creditsNumber: "INV-000001", status: "credit_note" });
    expect(credit.lines[0]).toMatchObject({ quantity: -1, netPence: -5000, vatPence: -1000 });
    const original = await s.p.billing.getInvoice(s.clinicId, id);
    expect(original).toMatchObject({ status: "credited", balancePence: 0, creditedByNumber: "CN-000001" });
    expect(await s.p.billing.patientBalance(s.clinicId, s.patient)).toBe(0);
    await expect(s.p.billing.recordPayment(s.owner, id, { amountPence: 100, method: "cash" })).rejects.toThrow(/cancelled/);
    await expect(s.p.billing.creditInvoice(s.owner, id, "again")).rejects.toThrow(/already been cancelled/);
    await expect(s.p.billing.creditInvoice(s.owner, cn, "x")).rejects.toThrow(/credit note cannot be credited/);
  });

  it("will not cancel an invoice with money on it until the payment is reversed", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    const pay = await s.p.billing.recordPayment(s.owner, id, { amountPence: 1000, method: "cash" });
    await expect(s.p.billing.creditInvoice(s.owner, id, "mistake")).rejects.toThrow(/Reverse them first/);
    await s.p.billing.reversePayment(s.owner, pay, "Refunded");
    await expect(s.p.billing.creditInvoice(s.owner, id, "mistake")).resolves.toBeTruthy();
  });

  it("frees the appointment to be invoiced again", async () => {
    const s = await platformSetup();
    await priced(s, 6000);
    const a = await attended(s);
    const first = await s.p.billing.invoiceForAppointment(s.owner, a);
    expect(await s.p.billing.liveInvoiceForAppointment(s.clinicId, a)).toMatchObject({ id: first });
    await s.p.billing.creditInvoice(s.owner, first, "Wrong payer");
    expect(await s.p.billing.liveInvoiceForAppointment(s.clinicId, a)).toBeNull();
    const second = await s.p.billing.invoiceForAppointment(s.owner, a, { payerType: "insurer", payerName: "AXA" });
    expect((await s.p.billing.getInvoice(s.clinicId, second)).number).toBe("INV-000002");
  });
});

describe("lists and figures", () => {
  it("lists outstanding and paid invoices, and gives a patient's balance", async () => {
    const s = await platformSetup();
    const a = await s.p.billing.createInvoice(s.owner, manual(s));
    const b = await s.p.billing.createInvoice(s.owner, manual(s, { lines: [{ description: "Taping", quantity: 1, unitPence: 2500 }] }));
    await s.p.billing.recordPayment(s.owner, a, { amountPence: 5000, method: "cash" });
    expect((await s.p.billing.listInvoices(s.clinicId, { status: "outstanding" })).map((i) => i.id)).toEqual([b]);
    expect((await s.p.billing.listInvoices(s.clinicId, { status: "paid" })).map((i) => i.id)).toEqual([a]);
    expect(await s.p.billing.listInvoices(s.clinicId, { patientId: s.patient })).toHaveLength(2);
    expect(await s.p.billing.patientBalance(s.clinicId, s.patient)).toBe(2500);
  });

  it("adds up invoiced, credited, collected by method, outstanding and overdue", async () => {
    const s = await platformSetup();
    const a = await s.p.billing.createInvoice(s.owner, manual(s));
    const b = await s.p.billing.createInvoice(s.owner, manual(s, { lines: [{ description: "Taping", quantity: 1, unitPence: 2500 }] }));
    const c = await s.p.billing.createInvoice(s.owner, manual(s, { lines: [{ description: "Wrong", quantity: 1, unitPence: 900 }] }));
    await s.p.billing.recordPayment(s.owner, a, { amountPence: 3000, method: "cash" });
    await s.p.billing.recordPayment(s.owner, a, { amountPence: 2000, method: "card" });
    await s.p.billing.creditInvoice(s.owner, c, "Duplicate");
    const day = s.clock.now.toISOString().slice(0, 10);
    expect(await s.p.billing.summary(s.clinicId, day, day)).toMatchObject({
      invoicedPence: 5000 + 2500 + 900,
      creditedPence: 900,
      collectedPence: 5000,
      byMethod: [{ method: "card", pence: 2000 }, { method: "cash", pence: 3000 }],
      outstandingPence: 2500,
      overduePence: 0,
      invoiceCount: 3,
    });
    s.clock.now = new Date(s.clock.now.getTime() + 20 * 86_400_000);
    const later = s.clock.now.toISOString().slice(0, 10);
    const sum = await s.p.billing.summary(s.clinicId, later, later);
    expect(sum).toMatchObject({ invoicedPence: 0, collectedPence: 0, outstandingPence: 2500, overduePence: 2500 });
    void b;
    await expect(s.p.billing.summary(s.clinicId, "2026-10-02", "2026-10-01")).rejects.toThrow();
  });
});

describe("tenancy and the audit trail", () => {
  it("never shows or touches another clinic's invoices", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    const other = await s.p.accounts.bootstrap({ clinicName: "Other Clinic", ownerName: "Oz", email: "oz@example.com", password: PW }).catch(() => null);
    if (!other) return;
    const oz: SessionUser = { id: other.userId, clinicId: other.clinicId, name: "Oz", email: "oz@example.com", role: "owner" };
    await expect(s.p.billing.getInvoice(other.clinicId, id)).rejects.toThrow(/not found/);
    await expect(s.p.billing.recordPayment(oz, id, { amountPence: 100, method: "cash" })).rejects.toThrow(/not found/);
    await expect(s.p.billing.creditInvoice(oz, id, "x")).rejects.toThrow(/not found/);
    expect(await s.p.billing.listInvoices(other.clinicId)).toEqual([]);
    expect((await s.p.billing.getSettings(other.clinicId)).invoicePrefix).toBe("INV");
  });

  it("cannot be edited or deleted by the application, only added to", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    const pay = await s.p.billing.recordPayment(s.owner, id, { amountPence: 100, method: "cash" });
    const run = (sql: string, params: unknown[]) => s.db.scope(s.clinicId, () => s.db.run(sql, params));
    await expect(run("UPDATE invoices SET total_pence = 1 WHERE id = ?", [id])).rejects.toThrow(/permission denied/);
    await expect(run("DELETE FROM invoices WHERE id = ?", [id])).rejects.toThrow(/permission denied/);
    await expect(run("UPDATE invoice_lines SET net_pence = 1 WHERE invoice_id = ?", [id])).rejects.toThrow(/permission denied/);
    await expect(run("DELETE FROM invoice_lines WHERE invoice_id = ?", [id])).rejects.toThrow(/permission denied/);
    await expect(run("UPDATE payments SET amount_pence = 1 WHERE id = ?", [pay])).rejects.toThrow(/permission denied/);
    await expect(run("DELETE FROM payments WHERE id = ?", [pay])).rejects.toThrow(/permission denied/);
  });

  it("holds the database to the rules too", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    const t = s.clock.now.toISOString();
    const insert = (kind: string, total: number, credits: string | null, number: string) =>
      s.q.run(
        `INSERT INTO invoices (id, clinic_id, number, kind, patient_id, credits_invoice_id, payer_type, issued_at, due_at, subtotal_pence, vat_pence, total_pence, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'self', ?, ?, ?, 0, ?, 't')`,
        [`x-${number}`, s.clinicId, number, kind, s.patient, credits, t, t, total, total],
      );
    await expect(insert("invoice", -100, null, "BAD-1")).rejects.toThrow();
    await expect(insert("credit_note", -100, null, "BAD-2")).rejects.toThrow();
    await insert("credit_note", -5000, id, "CN-X1");
    await expect(insert("credit_note", -5000, id, "CN-X2")).rejects.toThrow(/one_credit_per_invoice/);
    await expect(insert("invoice", 100, null, "INV-000001")).rejects.toThrow(/unique|duplicate/);
  });

  it("audits issuing, paying, reversing and crediting", async () => {
    const s = await platformSetup();
    const id = await s.p.billing.createInvoice(s.owner, manual(s));
    const pay = await s.p.billing.recordPayment(s.owner, id, { amountPence: 100, method: "cash" });
    await s.p.billing.reversePayment(s.owner, pay, "Entered twice");
    await s.p.billing.creditInvoice(s.owner, id, "Cancelled");
    const actions = (await s.q.all("SELECT action FROM audit_log WHERE action LIKE 'invoice.%' OR action LIKE 'payment.%' ORDER BY at, action")).map((r) => r.action as string);
    expect(actions).toEqual(expect.arrayContaining(["invoice.issued", "payment.recorded", "payment.reversed", "invoice.credited"]));
  });
});
