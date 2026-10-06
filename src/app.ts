import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAuthenticator, type Identity } from "./auth/identity.js";
import { buildOAuthRouter, publicUrl } from "./auth/oauth.js";
import { createTokenService } from "./auth/tokens.js";
import type { Config } from "./config.js";
import { createStore, type Store } from "./erp/store.js";
import { createWindowLimiter } from "./limits.js";
import { createLogger, type Logger } from "./logger.js";
import { createAudit, type Audit } from "./mcp/audit.js";
import { createConfirmations } from "./mcp/confirm.js";
import type { Deps } from "./mcp/context.js";
import { buildServer } from "./mcp/server.js";

export interface AppOptions {
  store?: Store;
  logger?: Logger;
  audit?: Audit;
  now?: () => Date;
}

type AuthedRequest = Request & { identity?: Identity };

/** Builds the Express app. Everything is injectable so tests run without a network or real secrets. */
export function createApp(config: Config, opts: AppOptions = {}): Express {
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger ?? createLogger();
  const tokens = createTokenService(config.tokenSecret, () => now().getTime());
  const auth = createAuthenticator(config, tokens);
  const writeLimiters = Object.fromEntries(
    ["scheduling-write", "finance-write", "finance-delete"].map((f) => [f, createWindowLimiter({ max: config.writesPerMinute, windowMs: 60_000, now: () => now().getTime() })]),
  );
  const deps: Deps = {
    config,
    store: opts.store ?? createStore(now),
    confirmations: createConfirmations(config.tokenSecret, config.confirmTtlSeconds, () => now().getTime()),
    audit: opts.audit ?? createAudit(logger),
    writeLimiters,
    now,
  };

  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));
  app.use(buildOAuthRouter({ config, tokens, auth, logger, now: () => now().getTime() }));

  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const identity = auth.identify(req.headers.authorization);
    if (identity) {
      req.identity = identity;
      return next();
    }
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${publicUrl(config, req)}/.well-known/oauth-protected-resource/mcp"`)
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: authenticate with OAuth or a bearer token" }, id: null });
  };

  // Stateless Streamable HTTP: a fresh server and transport per request, nothing kept between calls.
  app.post("/mcp", requireAuth, express.json({ limit: "1mb" }), async (req: AuthedRequest, res) => {
    const server = buildServer(deps, req.identity as Identity);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logger.error("mcp", "handler failed", { err: (e as Error).message.slice(0, 200) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) =>
    void res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless" }, id: null });
  app.get("/mcp", requireAuth, notAllowed);
  app.delete("/mcp", requireAuth, notAllowed);

  // Last resort: never leak a stack trace or internal detail.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("http", "unhandled error", { err: err.message.slice(0, 200) });
    if (!res.headersSent) res.status(400).json({ error: "bad_request" });
  });

  return app;
}
