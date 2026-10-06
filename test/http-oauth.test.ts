import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { TOKENS, startHttp, testConfig } from "./helpers.js";

const REDIRECT = "http://127.0.0.1:8123/callback";
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o), redirect: "manual" as const });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(base: string, redirect = REDIRECT, name = "Test Client") {
  const r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: name }) });
  return { status: r.status, body: (await r.json()) as any };
}

/** Runs consent and returns the authorization code (or the response, when it fails). */
async function authorize(base: string, clientId: string, challenge: string, accessKey: string, state = "xyz") {
  return fetch(`${base}/authorize`, form({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state, access_key: accessKey }));
}

test("/mcp without a token: 401 with the resource metadata pointer; metadata is published", async () => {
  const s = await startHttp();
  try {
    const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);

    const prm = (await (await fetch(`${s.base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    assert.equal(prm.resource, `${s.base}/mcp`);
    const as = (await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json()) as any;
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.ok(as.registration_endpoint.endsWith("/register"));
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  } finally {
    await s.close();
  }
});

test("a static bearer token works over real HTTP and gets its own role's tools", async () => {
  const s = await startHttp();
  try {
    const client = await s.mcpClient(TOKENS.bot);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["appointment_book", "appointment_cancel", "appointments_availability", "appointments_list"]);
    await client.close();
    const wrong = await fetch(`${s.base}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(wrong.status, 401);
  } finally {
    await s.close();
  }
});

test("GET and DELETE on /mcp are 405: the server is stateless", async () => {
  const s = await startHttp();
  try {
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(`${s.base}/mcp`, { method, headers: { Authorization: `Bearer ${TOKENS.root}` } });
      assert.equal(r.status, 405);
    }
  } finally {
    await s.close();
  }
});

test("full OAuth flow: register, consent, PKCE token, MCP call as the person who consented, refresh", async () => {
  const s = await startHttp();
  try {
    const reg = await register(s.base);
    assert.equal(reg.status, 201);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();

    const page = await fetch(`${s.base}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    const html = await page.text();
    assert.match(html, /Test Client/);
    assert.match(html, /127\.0\.0\.1:8123/, "the consent page says where the person will be sent");

    const consent = await authorize(s.base, clientId, challenge, TOKENS.mia);
    assert.equal(consent.status, 302);
    const target = new URL(consent.headers.get("location") as string);
    assert.equal(target.origin + target.pathname, REDIRECT);
    assert.equal(target.searchParams.get("state"), "xyz");
    const code = target.searchParams.get("code") as string;

    const tokenReq = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier };
    const tok = await fetch(`${s.base}/token`, form(tokenReq));
    assert.equal(tok.status, 200);
    assert.equal(tok.headers.get("cache-control"), "no-store");
    const tokens = (await tok.json()) as any;
    assert.equal(tokens.token_type, "Bearer");

    const client = await s.mcpClient(tokens.access_token);
    const status = JSON.parse(((await client.callTool({ name: "erp_status", arguments: {} })) as any).content[0].text);
    assert.equal(status.user, "mia");
    assert.equal(status.role, "manager");
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("invoice_mark_paid") && !names.includes("payable_delete"));
    await client.close();

    const replay = await fetch(`${s.base}/token`, form(tokenReq));
    assert.equal(replay.status, 400, "authorization codes are single use");

    const refreshed = await fetch(`${s.base}/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }));
    assert.equal(refreshed.status, 200);
    assert.notEqual(((await refreshed.json()) as any).access_token, tokens.access_token);
    const asAccess = await fetch(`${s.base}/token`, form({ grant_type: "refresh_token", refresh_token: tokens.access_token }));
    assert.equal(asAccess.status, 400, "an access token cannot be used as a refresh token");
  } finally {
    await s.close();
  }
});

test("OAuth: PKCE, client and redirect mismatches are refused", async () => {
  const s = await startHttp();
  try {
    const clientId = (await register(s.base)).body.client_id as string;
    const other = (await register(s.base, "http://127.0.0.1:9999/cb")).body.client_id as string;
    const getCode = async () => {
      const p = pkce();
      const r = await authorize(s.base, clientId, p.challenge, TOKENS.root);
      return { ...p, code: new URL(r.headers.get("location") as string).searchParams.get("code") as string };
    };
    const base = { grant_type: "authorization_code", redirect_uri: REDIRECT, client_id: clientId };

    const a = await getCode();
    assert.equal((await fetch(`${s.base}/token`, form({ ...base, code: a.code, code_verifier: randomBytes(32).toString("base64url") }))).status, 400, "wrong verifier");
    assert.equal((await fetch(`${s.base}/token`, form({ ...base, code: a.code, code_verifier: a.verifier }))).status, 400, "a failed attempt burns the code");

    const b = await getCode();
    assert.equal((await fetch(`${s.base}/token`, form({ ...base, client_id: other, code: b.code, code_verifier: b.verifier }))).status, 400, "other client");

    const c = await getCode();
    assert.equal((await fetch(`${s.base}/token`, form({ ...base, redirect_uri: "http://127.0.0.1:9999/cb", code: c.code, code_verifier: c.verifier }))).status, 400, "other redirect");

    const d = await getCode();
    assert.equal((await fetch(`${s.base}/token`, form({ ...base, code: d.code }))).status, 400, "no verifier");
    assert.equal((await fetch(`${s.base}/token`, form({ grant_type: "password" }))).status, 400);
  } finally {
    await s.close();
  }
});

test("OAuth: registration and authorization reject unsafe redirects and weak PKCE", async () => {
  const s = await startHttp();
  try {
    for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "not a url", "https://ok.example/cb#frag"]) {
      assert.equal((await register(s.base, bad)).status, 400, bad);
    }
    assert.equal((await register(s.base, "https://claude.ai/api/mcp/auth_callback")).status, 201);
    const clientId = (await register(s.base)).body.client_id as string;
    const { challenge } = pkce();
    const q = (o: Record<string, string>) => new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", ...o });
    assert.equal((await fetch(`${s.base}/authorize?${q({ redirect_uri: "http://127.0.0.1:1/other" })}`)).status, 400, "unregistered redirect");
    assert.equal((await fetch(`${s.base}/authorize?${q({ code_challenge_method: "plain" })}`)).status, 400, "plain PKCE");
    assert.equal((await fetch(`${s.base}/authorize?${q({ client_id: "mcpc_unknown" })}`)).status, 400, "unknown client");
    assert.equal((await fetch(`${s.base}/authorize?${q({ response_type: "token" })}`)).status, 400);
  } finally {
    await s.close();
  }
});

test("OAuth: a wrong access key is refused, and repeated guesses are rate limited", async () => {
  const s = await startHttp();
  try {
    const clientId = (await register(s.base)).body.client_id as string;
    const { challenge } = pkce();
    const wrong = await authorize(s.base, clientId, challenge, "guess-0");
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Wrong access key/);
    let last = 0;
    for (let i = 1; i < 12; i++) last = (await authorize(s.base, clientId, challenge, `guess-${i}`)).status;
    assert.equal(last, 429);
    assert.equal((await authorize(s.base, clientId, challenge, TOKENS.root)).status, 429, "even the right key waits for the window");
  } finally {
    await s.close();
  }
});

test("revocation: removing a user from the configuration kills the tokens issued to them", async () => {
  const s1 = await startHttp();
  let tokens: any;
  try {
    const clientId = (await register(s1.base)).body.client_id as string;
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(s1.base, clientId, challenge, TOKENS.mia)).headers.get("location") as string).searchParams.get("code") as string;
    tokens = await (await fetch(`${s1.base}/token`, form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }))).json();
    assert.equal((await fetch(`${s1.base}/mcp`, { method: "GET", headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405, "valid while the user exists");
  } finally {
    await s1.close();
  }

  // Same secret, but "mia" is gone from ERP_USERS.
  const without = testConfig({ ERP_USERS: JSON.stringify([{ name: "root", role: "admin", token: TOKENS.root }]) });
  const s2 = await startHttp(without);
  try {
    assert.equal((await fetch(`${s2.base}/mcp`, { method: "GET", headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
    const refresh = await fetch(`${s2.base}/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }));
    assert.equal(refresh.status, 400);
  } finally {
    await s2.close();
  }
});

test("a two-step write works end to end over HTTP", async () => {
  const s = await startHttp();
  try {
    const client = await s.mcpClient(TOKENS.mia);
    const args = { supplier: "Acme Cleaning", description: "Window cleaning", amount: 120, due_date: "2026-03-25" };
    const preview = ((await client.callTool({ name: "payable_create", arguments: args })) as any).content[0].text as string;
    const token = /confirmation_token="([^"]+)"/.exec(preview)?.[1];
    assert.ok(token);
    const done = (await client.callTool({ name: "payable_create", arguments: { ...args, confirm: true, confirmation_token: token } })) as any;
    assert.equal(done.isError ?? false, false);
    assert.match(done.content[0].text, /BILL-/);
    await client.close();
  } finally {
    await s.close();
  }
});
