// Builds the McpServer for ONE request (the transport is stateless) with only the tools the caller's
// role can reach. See auth/roles.ts for why the role decides what is registered instead of filtering.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Identity } from "../auth/identity.js";
import { roleAllows } from "../auth/roles.js";
import type { Deps, ToolContext } from "./context.js";
import { registerCustomerContactTool, registerCustomerTools } from "./tools/customers.js";
import { registerFinanceDeleteTools, registerFinanceTools, registerFinanceWriteTools } from "./tools/finance.js";
import { registerSchedulingTools, registerSchedulingWriteTools } from "./tools/scheduling.js";
import { registerSystemTools } from "./tools/system.js";

const INSTRUCTIONS =
  "Tools for a small service business ERP (customers, appointments, invoices, bills). " +
  "Dates are YYYY-MM-DD and times are UTC ISO 8601. Money is in USD. " +
  "Read tools are safe. Write tools work in two steps: call once to get a PREVIEW, show it to the user, " +
  "and only after they approve call again with confirm=true and the confirmation_token. " +
  "Personal data is masked by default. Not every role has every tool: what is not listed is not available " +
  "to this account, so say so instead of looking for a workaround.";

export function buildServer(deps: Deps, who: Identity): McpServer {
  const server = new McpServer({ name: "mcp-erp-server", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = { ...deps, who };
  const has = (f: Parameters<typeof roleAllows>[1]) => roleAllows(who.role, f);

  if (has("system")) registerSystemTools(server, ctx);
  if (has("customers")) registerCustomerTools(server, ctx);
  if (has("customers-pii")) registerCustomerContactTool(server, ctx);
  if (has("scheduling")) registerSchedulingTools(server, ctx);
  if (has("scheduling-write")) registerSchedulingWriteTools(server, ctx);
  if (has("finance")) registerFinanceTools(server, ctx);
  if (has("finance-write")) registerFinanceWriteTools(server, ctx);
  if (has("finance-delete")) registerFinanceDeleteTools(server, ctx);
  return server;
}
