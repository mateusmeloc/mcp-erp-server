// Preview-and-confirm for write tools.
//
// A write is two calls. The first returns a PREVIEW (nothing changes) and a confirmation token.
// The second repeats the same arguments plus `confirm: true` and that token. The token is bound to
// the tool, the person and a hash of the exact arguments, expires, and works once. So a model
// cannot skip the preview, cannot execute something different from what was shown, and cannot
// replay an old approval.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "../auth/tokens.js";

export type ConfirmResult = { ok: true } | { ok: false; reason: string };

export interface Confirmations {
  issue(tool: string, user: string, args: unknown): { token: string; ttlSeconds: number };
  consume(token: string | undefined, tool: string, user: string, args: unknown): ConfirmResult;
}

/** JSON with sorted keys, so the same arguments always hash the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createConfirmations(secret: string, ttlSeconds: number, now: () => number = Date.now): Confirmations {
  const used = new Map<string, number>(); // jti -> expiry (ms); in memory, single instance
  const b64 = (b: Buffer) => b.toString("base64url");
  const mac = (body: string) => b64(createHmac("sha256", secret).update(`confirm:${body}`).digest());
  const hash = (tool: string, user: string, args: unknown) => createHash("sha256").update(`${tool}|${user}|${canonical(args)}`).digest("hex");

  return {
    issue(tool, user, args) {
      const payload = { h: hash(tool, user, args), exp: now() + ttlSeconds * 1000, jti: randomBytes(9).toString("hex") };
      const body = b64(Buffer.from(JSON.stringify(payload)));
      return { token: `${body}.${mac(body)}`, ttlSeconds };
    },
    consume(token, tool, user, args) {
      if (!token) return { ok: false, reason: "a confirmation_token from the preview is required" };
      const dot = token.lastIndexOf(".");
      if (dot <= 0 || !safeEqual(token.slice(dot + 1), mac(token.slice(0, dot)))) return { ok: false, reason: "the confirmation_token is not valid" };
      let p: { h: string; exp: number; jti: string };
      try {
        p = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString());
      } catch {
        return { ok: false, reason: "the confirmation_token is not valid" };
      }
      if (p.exp < now()) return { ok: false, reason: "the confirmation_token expired, request a new preview" };
      if (!safeEqual(p.h, hash(tool, user, args))) return { ok: false, reason: "the arguments differ from the ones that were previewed, request a new preview" };
      if (used.has(p.jti)) return { ok: false, reason: "this confirmation_token was already used" };
      used.set(p.jti, p.exp);
      for (const [k, exp] of used) if (exp < now()) used.delete(k);
      return { ok: true };
    },
  };
}
