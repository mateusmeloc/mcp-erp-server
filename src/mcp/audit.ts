import type { Logger } from "../logger.js";

export interface AuditEvent {
  event: "preview" | "executed" | "denied" | "sensitive-read";
  tool: string;
  user: string;
  role: string;
  [detail: string]: unknown;
}

export interface Audit {
  record(e: AuditEvent): void;
}

/** Writes audit events to the structured log. Details must be ids and amounts, never personal data. */
export function createAudit(logger: Logger): Audit {
  return { record: (e) => logger.info("audit", e.event, e) };
}
