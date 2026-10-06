import type { Config } from "../config.js";
import type { Role } from "./roles.js";
import { safeEqual, type TokenService } from "./tokens.js";

export interface Identity {
  /** Short name for the audit log. Never the token. */
  name: string;
  role: Role;
}

export interface Authenticator {
  /** Resolves an `Authorization` header to an identity, or null. */
  identify(authorization: string | undefined): Identity | null;
  /** Finds the user that owns a static access key (used by the OAuth consent screen). */
  byAccessKey(key: string): Identity | null;
}

export function createAuthenticator(config: Config, tokens: TokenService): Authenticator {
  const toIdentity = (u: { name: string; role: Role }): Identity => ({ name: u.name, role: u.role });

  // Compares against EVERY configured token, with no early exit, so timing does not reveal
  // which keys exist.
  const byAccessKey = (key: string): Identity | null => {
    let found: Identity | null = null;
    for (const u of config.users) if (safeEqual(key, u.token) && !found) found = toIdentity(u);
    return found;
  };

  return {
    byAccessKey,
    identify(authorization) {
      const header = authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) return null;

      const direct = byAccessKey(token);
      if (direct) return direct;

      // OAuth-issued token. The role comes from the CURRENT config, not from the token, so removing
      // a user (or changing a role) takes effect immediately.
      const payload = tokens.verify(token, "access");
      const user = payload && config.users.find((u) => u.name === payload.sub);
      return user ? toIdentity(user) : null;
    },
  };
}
