import type { Identity } from "../auth/identity.js";
import type { Family } from "../auth/roles.js";
import type { Config } from "../config.js";
import type { Store } from "../erp/store.js";
import type { WindowLimiter } from "../limits.js";
import type { Audit } from "./audit.js";
import type { Confirmations } from "./confirm.js";

/** Everything a tool needs, injected so tests can swap any piece. */
export interface Deps {
  config: Config;
  store: Store;
  confirmations: Confirmations;
  audit: Audit;
  /** One limiter per write family; keyed by person inside. */
  writeLimiters: Record<string, WindowLimiter>;
  now: () => Date;
}

export interface ToolContext extends Deps {
  who: Identity;
}

export type { Family };
