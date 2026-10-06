// The single door every write tool goes through, so the guardrails cannot drift apart:
//   1. global kill switch (ALLOW_WRITES)
//   2. rate limit per person and family
//   3. revalidate against the current state
//   4. preview first, execute only with a matching confirmation token
//   5. audit log for every step

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Family } from "../auth/roles.js";
import { domainError, fail, text } from "./helpers.js";
import type { ToolContext } from "./context.js";

export interface WritePlan {
  /** One or two sentences saying exactly what will happen, with the real values. */
  summary: string;
  /** Applies the change. Only called after a valid confirmation. */
  run: () => CallToolResult;
  /** Ids and amounts for the audit log. Never personal data. */
  auditDetail?: Record<string, unknown>;
}

export function runWrite(
  ctx: ToolContext,
  spec: {
    tool: string;
    family: Family;
    /** The business arguments, without `confirm` and `confirmation_token`. */
    args: Record<string, unknown>;
    confirm: boolean;
    confirmationToken?: string;
    plan: () => WritePlan;
  },
): CallToolResult {
  const { who } = ctx;
  const base = { tool: spec.tool, user: who.name, role: who.role };

  if (!ctx.config.allowWrites) {
    ctx.audit.record({ event: "denied", ...base, reason: "writes disabled" });
    return fail("Write tools are disabled on this server (ALLOW_WRITES=false). Read tools still work.");
  }

  const wait = ctx.writeLimiters[spec.family]?.hit(`${spec.family}:${who.name}`);
  if (wait != null) {
    ctx.audit.record({ event: "denied", ...base, reason: "rate limit" });
    return fail(`Rate limit: at most ${ctx.config.writesPerMinute} ${spec.family} operations per minute. Try again in ${wait}s.`);
  }

  let plan: WritePlan;
  try {
    plan = spec.plan();
  } catch (e) {
    const result = domainError(e);
    ctx.audit.record({ event: "denied", ...base, reason: (e as Error).message });
    return result;
  }

  if (!spec.confirm) {
    const { token, ttlSeconds } = ctx.confirmations.issue(spec.tool, who.name, spec.args);
    ctx.audit.record({ event: "preview", ...base, ...plan.auditDetail });
    return text(
      `PREVIEW — nothing has been changed.\n\n${plan.summary}\n\n` +
        `Show this to the user. If they approve, call ${spec.tool} again with the same arguments plus ` +
        `confirm=true and confirmation_token="${token}" (valid for ${Math.round(ttlSeconds / 60)} min, single use).`,
    );
  }

  const check = ctx.confirmations.consume(spec.confirmationToken, spec.tool, who.name, spec.args);
  if (!check.ok) {
    ctx.audit.record({ event: "denied", ...base, reason: check.reason });
    return fail(`Not executed: ${check.reason}.`);
  }

  try {
    const result = plan.run();
    ctx.audit.record({ event: "executed", ...base, ...plan.auditDetail });
    return result;
  } catch (e) {
    const result = domainError(e);
    ctx.audit.record({ event: "denied", ...base, reason: (e as Error).message });
    return result;
  }
}
