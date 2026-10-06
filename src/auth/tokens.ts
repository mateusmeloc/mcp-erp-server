// Signed tokens (HMAC-SHA256) issued by this server: base64url(payload) + "." + base64url(mac).
// Stateless, so they survive a restart. Native crypto only. Revocation works by removing the user
// from ERP_USERS (verified on every request) or by rotating TOKEN_SECRET (revokes everything).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type TokenType = "access" | "refresh";

export interface TokenPayload {
  typ: TokenType;
  sub: string;
  iat: number;
  exp: number; // epoch seconds
  jti: string;
}

export interface TokenService {
  issue(typ: TokenType, sub: string, ttlSeconds: number): string;
  verify(token: string, expected: TokenType): TokenPayload | null;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba); // keep the cost similar
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function createTokenService(secret: string, now: () => number = Date.now): TokenService {
  const mac = (payloadB64: string) => b64url(createHmac("sha256", secret).update(payloadB64).digest());

  return {
    issue(typ, sub, ttlSeconds) {
      const iat = Math.floor(now() / 1000);
      const payload: TokenPayload = { typ, sub, iat, exp: iat + ttlSeconds, jti: randomBytes(12).toString("hex") };
      const body = b64url(Buffer.from(JSON.stringify(payload)));
      return `${body}.${mac(body)}`;
    },
    verify(token, expected) {
      const dot = token.lastIndexOf(".");
      if (dot <= 0) return null;
      const body = token.slice(0, dot);
      if (!safeEqual(token.slice(dot + 1), mac(body))) return null;
      try {
        const p = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
        if (p.typ !== expected || typeof p.sub !== "string" || p.exp * 1000 < now()) return null;
        return p;
      } catch {
        return null;
      }
    },
  };
}
