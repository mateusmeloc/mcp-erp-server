// Minimal OAuth 2.1 authorization server + protected-resource metadata, enough for MCP clients
// such as Claude, ChatGPT or Claude Code to connect to this server as a custom connector.
//
// Flow:
//   1. Client calls /mcp without a token            -> 401 + WWW-Authenticate (resource_metadata)
//   2. GET /.well-known/oauth-protected-resource    (RFC 9728)
//   3. GET /.well-known/oauth-authorization-server  (RFC 8414)
//   4. POST /register                               (RFC 7591 dynamic client registration, public clients)
//   5. GET/POST /authorize                          consent page: the person pastes their own access key
//   6. POST /token                                  authorization_code + PKCE S256, and refresh_token
//
// Registration is open by design (that is what DCR is), so it is not trusted: redirect URIs must be
// https or loopback and are matched exactly, the consent page names the client and where it will
// send the person, and nothing is granted without a valid access key.

import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { createWindowLimiter } from "../limits.js";
import type { Authenticator } from "./identity.js";
import type { TokenService } from "./tokens.js";

interface AuthCode {
  challenge: string;
  redirectUri: string;
  clientId: string;
  sub: string;
  exp: number;
}

interface Client {
  redirectUris: string[];
  name: string;
}

const MAX_CLIENTS = 500;
const CODE_TTL_MS = 5 * 60_000;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname); // RFC 8252 loopback
  } catch {
    return false;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function consentPage(client: Client, params: Record<string, string>, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  const host = (() => {
    try {
      return new URL(params.redirect_uri ?? "").host;
    } catch {
      return "?";
    }
  })();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize access</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#191c23;border:1px solid #2a2e38;border-radius:12px;padding:2rem;max-width:400px;width:100%}
h1{font-size:1.1rem;margin:0 0 .5rem}p{font-size:.85rem;color:#9aa2b1;line-height:1.5}b{color:#e6e6e6}
input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #2a2e38;background:#0f1115;color:#e6e6e6;margin:.75rem 0}
button{width:100%;padding:.65rem;border:0;border-radius:8px;background:#5dd39e;color:#0f1115;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:.8rem;margin:.25rem 0 0}
</style></head><body>
<div class="card">
<h1>Authorize access to the ERP</h1>
<p><b>${escapeHtml(client.name)}</b> is asking to use the ERP tools on your behalf. After you approve, you will be sent to <b>${escapeHtml(host)}</b>. Only continue if you started this connection.</p>
<form method="POST" action="/authorize">
${hidden}
<input type="password" name="access_key" placeholder="Your access key" autocomplete="off" autofocus required>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<button type="submit">Authorize</button>
</form>
</div></body></html>`;
}

export interface OAuthDeps {
  config: Config;
  tokens: TokenService;
  auth: Authenticator;
  logger: Logger;
  now?: () => number;
}

export function publicUrl(config: Config, req: Request): string {
  if (config.publicUrl) return config.publicUrl;
  return `${req.protocol}://${req.get("host")}`;
}

export function buildOAuthRouter({ config, tokens, auth, logger, now = Date.now }: OAuthDeps): Router {
  const router = express.Router();
  const codes = new Map<string, AuthCode>();
  const clients = new Map<string, Client>();
  const consentLimiter = createWindowLimiter({ max: 10, windowMs: 15 * 60_000, now });

  const resourceMetadata = (req: Request, res: Response) => {
    const base = publicUrl(config, req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_name: "ERP MCP server",
    });
  };
  const serverMetadata = (req: Request, res: Response) => {
    const base = publicUrl(config, req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  };
  router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], resourceMetadata);
  router.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], serverMetadata);

  router.post("/register", express.json({ limit: "16kb" }), (req, res) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirect)) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https or loopback URLs" });
      return;
    }
    if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value as string); // evict the oldest
    const clientId = `mcpc_${randomBytes(12).toString("hex")}`;
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "An MCP client";
    clients.set(clientId, { redirectUris: uris, name });
    logger.info("oauth", "client registered", { clientId, redirects: uris.length });
    res.status(201).json({
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  const checkAuthorizeParams = (q: Record<string, string | undefined>): { client?: Client; problem?: string } => {
    const client = q.client_id ? clients.get(q.client_id) : undefined;
    if (!client) return { problem: "unknown client_id" };
    if (q.response_type !== "code") return { problem: "response_type must be 'code'" };
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return { problem: "redirect_uri does not match the registration" };
    if (q.code_challenge_method !== "S256" || !q.code_challenge || !CHALLENGE.test(q.code_challenge)) return { problem: "PKCE with S256 is required" };
    return { client };
  };

  const noFraming = (res: Response) => {
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", "frame-ancestors 'none'");
    res.set("Cache-Control", "no-store");
  };

  router.get("/authorize", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const { client, problem } = checkAuthorizeParams(q);
    if (!client) {
      res.status(400).send(`Invalid authorization request: ${escapeHtml(problem ?? "")}`);
      return;
    }
    noFraming(res);
    res.type("html").send(
      consentPage(client, {
        response_type: "code",
        client_id: q.client_id ?? "",
        redirect_uri: q.redirect_uri ?? "",
        code_challenge: q.code_challenge ?? "",
        code_challenge_method: "S256",
        state: q.state ?? "",
      }),
    );
  });

  router.post("/authorize", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    const { client, problem } = checkAuthorizeParams(b);
    if (!client) {
      res.status(400).send(`Invalid authorization request: ${escapeHtml(problem ?? "")}`);
      return;
    }
    const wait = consentLimiter.hit(req.ip ?? "unknown");
    if (wait !== null) {
      res.status(429).set("Retry-After", String(wait)).send("Too many attempts. Try again later.");
      return;
    }
    const identity = auth.byAccessKey(b.access_key ?? "");
    const params = {
      response_type: "code",
      client_id: b.client_id ?? "",
      redirect_uri: b.redirect_uri ?? "",
      code_challenge: b.code_challenge ?? "",
      code_challenge_method: "S256",
      state: b.state ?? "",
    };
    noFraming(res);
    if (!identity) {
      logger.warn("oauth", "consent denied: wrong access key", { ip: req.ip });
      res.status(401).type("html").send(consentPage(client, params, "Wrong access key."));
      return;
    }
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { challenge: params.code_challenge, redirectUri: params.redirect_uri, clientId: params.client_id, sub: identity.name, exp: now() + CODE_TTL_MS });
    const target = new URL(params.redirect_uri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    logger.info("oauth", "consent approved", { clientId: params.client_id, user: identity.name });
    res.redirect(302, target.toString());
  });

  const issueResponse = (sub: string) => ({
    access_token: tokens.issue("access", sub, config.accessTtlSeconds),
    token_type: "Bearer",
    expires_in: config.accessTtlSeconds,
    refresh_token: tokens.issue("refresh", sub, config.refreshTtlSeconds),
  });

  router.post("/token", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    const grantError = (description: string) => res.status(400).json({ error: "invalid_grant", error_description: description });

    if (b.grant_type === "authorization_code") {
      const entry = b.code ? codes.get(b.code) : undefined;
      if (b.code) codes.delete(b.code); // single use, even when the checks below fail
      if (!entry || now() > entry.exp) return void grantError("code is invalid or expired");
      if (entry.clientId !== b.client_id) return void grantError("client_id does not match the code");
      if (entry.redirectUri !== b.redirect_uri) return void grantError("redirect_uri does not match the code");
      const digest = createHash("sha256").update(b.code_verifier ?? "").digest("base64url");
      if (!b.code_verifier || digest !== entry.challenge) return void grantError("PKCE verification failed");
      logger.info("oauth", "tokens issued (authorization_code)", { user: entry.sub });
      res.json(issueResponse(entry.sub));
      return;
    }

    if (b.grant_type === "refresh_token") {
      const payload = b.refresh_token ? tokens.verify(b.refresh_token, "refresh") : null;
      const stillExists = payload && config.users.some((u) => u.name === payload.sub);
      if (!payload || !stillExists) return void grantError("refresh_token is invalid or expired");
      logger.info("oauth", "tokens issued (refresh)", { user: payload.sub });
      res.json(issueResponse(payload.sub)); // a fresh pair every time; stateless, so the old refresh token is not revoked (see README)
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  return router;
}
