import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.js";
import { createTokenService } from "../src/auth/tokens.js";
import { canonical, createConfirmations } from "../src/mcp/confirm.js";
import { createWindowLimiter } from "../src/limits.js";
import { createLogger } from "../src/logger.js";
import { maskDocument, maskEmail, maskPhone } from "../src/erp/privacy.js";
import { roleAllows } from "../src/auth/roles.js";
import { SECRET, testConfig } from "./helpers.js";

test("config: valid environment loads, with safe defaults", () => {
  const c = testConfig();
  assert.equal(c.users.length, 4);
  assert.equal(c.allowWrites, true);
  assert.equal(c.trustProxy, false);
});

for (const [name, env] of [
  ["short secret", { TOKEN_SECRET: "short" }],
  ["no users", { ERP_USERS: "[]" }],
  ["bad JSON", { ERP_USERS: "{nope" }],
  ["unknown role", { ERP_USERS: JSON.stringify([{ name: "x", role: "root", token: "t".repeat(30) }]) }],
  ["short token", { ERP_USERS: JSON.stringify([{ name: "x", role: "admin", token: "short" }]) }],
  ["duplicate tokens", { ERP_USERS: JSON.stringify([{ name: "a", role: "admin", token: "t".repeat(30) }, { name: "b", role: "agent", token: "t".repeat(30) }]) }],
  ["duplicate names", { ERP_USERS: JSON.stringify([{ name: "a", role: "admin", token: "t".repeat(30) }, { name: "a", role: "agent", token: "u".repeat(30) }]) }],
] as const) {
  test(`config: rejects ${name}`, () => {
    assert.throws(() => testConfig(env as Record<string, string>), ConfigError);
  });
}

test("config: demo credentials are refused in production", () => {
  const users = JSON.stringify([{ name: "a", role: "admin", token: "demo-token-change-me-0000000000" }]);
  assert.throws(() => loadConfig({ TOKEN_SECRET: SECRET, ERP_USERS: users, NODE_ENV: "production" }), /production/);
  assert.doesNotThrow(() => loadConfig({ TOKEN_SECRET: SECRET, ERP_USERS: users }));
});

test("tokens: round trip, tampering, wrong type and expiry", () => {
  let t = 1_000_000_000_000;
  const svc = createTokenService(SECRET, () => t);
  const access = svc.issue("access", "mia", 60);
  assert.equal(svc.verify(access, "access")?.sub, "mia");
  assert.equal(svc.verify(access, "refresh"), null, "an access token is not a refresh token");
  const [body, mac] = access.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), sub: "root" })).toString("base64url");
  assert.equal(svc.verify(`${forged}.${mac}`, "access"), null, "payload edits invalidate the MAC");
  assert.equal(createTokenService("another-secret-with-32-characters!!!!", () => t).verify(access, "access"), null);
  t += 61_000;
  assert.equal(svc.verify(access, "access"), null, "expired");
});

test("confirmations: single use, bound to tool, person and exact arguments, with expiry", () => {
  let t = 1_000_000;
  const c = createConfirmations(SECRET, 300, () => t);
  const args = { invoice_id: "INV-1001", paid_on: "2026-03-01", method: "card" };
  const { token } = c.issue("invoice_mark_paid", "mia", args);

  assert.equal(c.consume(undefined, "invoice_mark_paid", "mia", args).ok, false, "token required");
  assert.equal(c.consume(token, "payable_delete", "mia", args).ok, false, "other tool");
  assert.equal(c.consume(token, "invoice_mark_paid", "root", args).ok, false, "other person");
  assert.equal(c.consume(token, "invoice_mark_paid", "mia", { ...args, method: "cash" }).ok, false, "other arguments");
  assert.equal(c.consume(token + "x", "invoice_mark_paid", "mia", args).ok, false, "tampered token");
  assert.equal(c.consume(token, "invoice_mark_paid", "mia", { method: "card", paid_on: "2026-03-01", invoice_id: "INV-1001" }).ok, true, "key order does not matter");
  const again = c.consume(token, "invoice_mark_paid", "mia", args);
  assert.equal(again.ok, false);
  assert.match((again as { reason: string }).reason, /already used/);

  const second = c.issue("invoice_mark_paid", "mia", args).token;
  t += 301_000;
  assert.match((c.consume(second, "invoice_mark_paid", "mia", args) as { reason: string }).reason, /expired/);
});

test("canonical JSON ignores key order and undefined values", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), canonical({ a: [2, { d: 1 }], b: 1 }));
});

test("window limiter blocks past the maximum and recovers after the window", () => {
  let t = 0;
  const l = createWindowLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.equal(l.hit("k"), null);
  assert.equal(l.hit("k"), null);
  assert.ok((l.hit("k") ?? 0) >= 1);
  assert.equal(l.hit("other"), null, "keys are independent");
  t = 1001;
  assert.equal(l.hit("k"), null);
});

test("logger redacts anything that looks like a credential", () => {
  const lines: string[] = [];
  createLogger((l) => lines.push(l)).info("t", "m", { token: "abc", nested: { Authorization: "Bearer x", ok: 1 }, code_verifier: "v", user: "mia" });
  const out = JSON.parse(lines[0] as string);
  assert.equal(out.token, "[redacted]");
  assert.equal(out.nested.Authorization, "[redacted]");
  assert.equal(out.code_verifier, "[redacted]");
  assert.equal(out.nested.ok, 1);
  assert.equal(out.user, "mia");
});

test("privacy masks", () => {
  assert.equal(maskEmail("alex.rivera@example.test"), "a***@example.test");
  assert.equal(maskPhone("+1-555-0110"), "***-0110");
  assert.equal(maskDocument("DOC-100000"), "***000");
});

test("roles: admin gets everything, others only their lists", () => {
  assert.equal(roleAllows("admin", "finance-delete"), true);
  assert.equal(roleAllows("manager", "finance-delete"), false);
  assert.equal(roleAllows("frontdesk", "finance"), false);
  assert.equal(roleAllows("frontdesk", "customers-pii"), false);
  assert.equal(roleAllows("agent", "customers"), false);
  assert.equal(roleAllows("agent", "scheduling-write"), true);
});
