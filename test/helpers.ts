import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Identity } from "../src/auth/identity.js";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { createStore } from "../src/erp/store.js";
import { createWindowLimiter } from "../src/limits.js";
import { createLogger } from "../src/logger.js";
import type { AuditEvent } from "../src/mcp/audit.js";
import { createConfirmations } from "../src/mcp/confirm.js";
import type { Deps } from "../src/mcp/context.js";
import { buildServer } from "../src/mcp/server.js";

export const SECRET = "test-secret-with-more-than-32-characters!!";
export const TOKENS = {
  root: "root-token-0000000000000000000000",
  mia: "mia-token-0000000000000000000000",
  fred: "fred-token-000000000000000000000",
  bot: "bot-token-0000000000000000000000",
} as const;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    TOKEN_SECRET: SECRET,
    ERP_USERS: JSON.stringify([
      { name: "root", role: "admin", token: TOKENS.root },
      { name: "mia", role: "manager", token: TOKENS.mia },
      { name: "fred", role: "frontdesk", token: TOKENS.fred },
      { name: "bot", role: "agent", token: TOKENS.bot },
    ]),
    ...overrides,
  });
}

/** A fixed, movable clock. Monday 2026-03-02 12:00 UTC. */
export function makeClock(start = "2026-03-02T12:00:00Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms), set: (iso: string) => void (t = Date.parse(iso)) };
}

export function makeDeps(config = testConfig(), clock = makeClock()) {
  const events: AuditEvent[] = [];
  const deps: Deps = {
    config,
    store: createStore(clock.now),
    confirmations: createConfirmations(config.tokenSecret, config.confirmTtlSeconds, () => clock.now().getTime()),
    audit: { record: (e) => void events.push(e) },
    writeLimiters: Object.fromEntries(
      ["scheduling-write", "finance-write", "finance-delete"].map((f) => [f, createWindowLimiter({ max: config.writesPerMinute, windowMs: 60_000, now: () => clock.now().getTime() })]),
    ),
    now: clock.now,
  };
  return { deps, events, clock };
}

/** An MCP client connected in memory to the server built for this identity (no HTTP involved). */
export async function connectAs(deps: Deps, who: Identity) {
  const server = buildServer(deps, who);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    tools: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      const text = r.content[0]?.text ?? "";
      return { text, isError: Boolean(r.isError), json: () => JSON.parse(text) as any };
    },
    close: () => client.close(),
  };
}

export const ADMIN: Identity = { name: "root", role: "admin" };
export const MANAGER: Identity = { name: "mia", role: "manager" };
export const FRONTDESK: Identity = { name: "fred", role: "frontdesk" };
export const AGENT: Identity = { name: "bot", role: "agent" };

/** The real Express app on an ephemeral port, for the HTTP and OAuth tests. */
export async function startHttp(config = testConfig(), clock = makeClock()) {
  const quiet = createLogger(() => {});
  const app = createApp(config, { now: clock.now, logger: quiet });
  const server = await new Promise<import("node:http").Server>((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mcpClient = async (token: string) => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  return { base, clock, mcpClient, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
