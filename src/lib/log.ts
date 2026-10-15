/**
 * Error logging that cannot leak patient data. Database errors often quote the offending value ("invalid input
 * syntax for type date: '1980-02-30'", or the key of a duplicate row), so those are logged by code and constraint
 * only. Anything else is logged by name and call stack, without its message.
 */
export function describeError(err: unknown): string {
  const e = err as { name?: string; code?: unknown; constraint?: string; table?: string; severity?: string; stack?: string } | null;
  if (!e || typeof e !== "object") return "unknown error";
  if (typeof e.code === "string" && typeof e.severity === "string") {
    return ["database error", e.code, e.constraint && `constraint ${e.constraint}`, e.table && `table ${e.table}`].filter(Boolean).join(" ");
  }
  const frames = (e.stack ?? "").split("\n").filter((l) => l.trim().startsWith("at ")).slice(0, 4).map((l) => l.trim());
  return [e.name ?? "Error", ...frames].join(" | ");
}

export function logError(where: string, err: unknown): void {
  console.error(`[${where}] ${describeError(err)}`);
}
