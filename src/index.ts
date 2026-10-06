import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { logger } from "./logger.js";

let config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`Configuration error: ${e.message}\nSee .env.example.\n`);
    process.exit(1);
  }
  throw e;
}

// Without these, one rejected promise would take the whole service down mid-request.
process.on("unhandledRejection", (r) => logger.error("process", "unhandledRejection", { err: String(r).slice(0, 200) }));
process.on("uncaughtException", (e) => logger.error("process", "uncaughtException", { err: e.message.slice(0, 200) }));

createApp(config).listen(config.port, () => {
  logger.info("boot", `mcp-erp-server listening on :${config.port}`, { writes: config.allowWrites, users: config.users.length });
});
