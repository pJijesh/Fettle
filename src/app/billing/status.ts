import type { InvoiceStatus } from "@/lib/billing";

export const STATUS_LABEL: Record<InvoiceStatus, string> = {
  unpaid: "unpaid",
  part_paid: "part paid",
  paid: "paid",
  overdue: "overdue",
  credited: "cancelled",
  credit_note: "credit note",
};
export const STATUS_PILL: Record<InvoiceStatus, string> = {
  unpaid: "booked",
  part_paid: "offered",
  paid: "arrived",
  overdue: "cancelled",
  credited: "completed",
  credit_note: "completed",
};
