import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
export const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));
export const fail = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }], isError: true });

export const cents = (n: number) => Math.round(n) / 100;

/** YYYY-MM-DD that is also a real calendar date (rejects 2026-02-31). */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "not a real date");

export const isoDateTime = z.string().datetime({ message: "use an ISO 8601 UTC timestamp, e.g. 2026-03-02T14:00:00Z" });

/** Maps the store's domain errors to a plain message the model can act on. */
export function domainError(e: unknown): CallToolResult {
  const known = ["ConflictError", "NotFoundError", "InvalidStateError"];
  if (e instanceof Error && known.includes(e.constructor.name)) return fail(e.message);
  throw e;
}
