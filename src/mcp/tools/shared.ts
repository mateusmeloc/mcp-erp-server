import { z } from "zod";

/** Shape shared by every write tool: the two-step confirmation fields. */
export const confirmShape = {
  confirm: z
    .boolean()
    .default(false)
    .describe("false (default) returns a PREVIEW and changes nothing. true executes, and requires confirmation_token."),
  confirmation_token: z.string().optional().describe("The token from the preview of these exact arguments. Required when confirm=true."),
};

export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
