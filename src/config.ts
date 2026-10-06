import { isRole, type Role } from "./auth/roles.js";

export interface UserEntry {
  /** Short name used in audit logs. Never the token. */
  name: string;
  role: Role;
  /** Static bearer token for this person. One token per person, so revoking one does not affect the others. */
  token: string;
}

export interface Config {
  port: number;
  /** Public base URL, used in OAuth metadata. Falls back to the request's own host. */
  publicUrl?: string;
  /** HMAC secret for OAuth access/refresh tokens and confirmation tokens. */
  tokenSecret: string;
  users: UserEntry[];
  /** Global kill switch for every write tool. */
  allowWrites: boolean;
  trustProxy: boolean;
  /** Write-tool calls allowed per person, per family, per minute. */
  writesPerMinute: number;
  /** How long a preview stays confirmable. */
  confirmTtlSeconds: number;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

const MIN_SECRET = 32;
const MIN_TOKEN = 24;
const DEMO_MARKER = "change-me";

export class ConfigError extends Error {}

function bool(v: string | undefined, fallback: boolean): boolean {
  return v === undefined || v === "" ? fallback : ["1", "true", "yes"].includes(v.toLowerCase());
}

/** Reads and validates the environment. Fails loudly at boot instead of running half-configured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.TOKEN_SECRET ?? "";
  if (secret.length < MIN_SECRET) throw new ConfigError(`TOKEN_SECRET must have at least ${MIN_SECRET} characters`);

  let raw: unknown;
  try {
    raw = JSON.parse(env.ERP_USERS ?? "");
  } catch {
    throw new ConfigError('ERP_USERS must be a JSON array like [{"name":"alice","role":"admin","token":"..."}]');
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError("ERP_USERS must list at least one user");

  const names = new Set<string>();
  const users = raw.map((u: unknown): UserEntry => {
    const e = (u ?? {}) as Record<string, unknown>;
    if (typeof e.name !== "string" || !/^[a-z0-9._-]{1,40}$/i.test(e.name)) throw new ConfigError("each user needs a short `name`");
    if (names.has(e.name)) throw new ConfigError(`duplicate user name: ${e.name}`);
    names.add(e.name);
    if (!isRole(e.role)) throw new ConfigError(`user ${e.name}: unknown role`);
    if (typeof e.token !== "string" || e.token.length < MIN_TOKEN) {
      throw new ConfigError(`user ${e.name}: token must have at least ${MIN_TOKEN} characters`);
    }
    return { name: e.name, role: e.role, token: e.token };
  });
  const tokens = new Set(users.map((u) => u.token));
  if (tokens.size !== users.length) throw new ConfigError("two users share the same token");

  if (env.NODE_ENV === "production") {
    const demo = users.some((u) => u.token.includes(DEMO_MARKER)) || secret.includes(DEMO_MARKER);
    if (demo) throw new ConfigError("demo credentials (containing 'change-me') are not allowed in production");
  }

  return {
    port: Number(env.PORT) || 3000,
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, "") || undefined,
    tokenSecret: secret,
    users,
    allowWrites: bool(env.ALLOW_WRITES, true),
    trustProxy: bool(env.TRUST_PROXY, false),
    writesPerMinute: Number(env.WRITES_PER_MINUTE) || 10,
    confirmTtlSeconds: Number(env.CONFIRM_TTL_SECONDS) || 300,
    accessTtlSeconds: Number(env.ACCESS_TTL_SECONDS) || 3600,
    refreshTtlSeconds: Number(env.REFRESH_TTL_SECONDS) || 30 * 24 * 3600,
  };
}
