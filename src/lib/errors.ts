import type { Issue } from "./validation";

export type ErrorCode =
  | "not_found"
  | "invalid_state"
  | "consent_required"
  | "validation"
  | "draft_failed"
  | "rate_limited"
  | "writeback_unavailable"
  | "forbidden"
  | "unauthenticated"
  | "conflict";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
    this.name = "DomainError";
  }
}
