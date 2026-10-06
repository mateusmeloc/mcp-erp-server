import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { customerContact, customerMasked, customerSummary } from "../../erp/privacy.js";
import { fail, json } from "../helpers.js";
import type { ToolContext } from "../context.js";
import { READ } from "./shared.js";

export function registerCustomerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "customer_search",
    {
      title: "Search customers",
      description: "Finds customers by name, id or city. Returns who they are (id, name, city, last visit), never contact details.",
      inputSchema: { query: z.string().max(80).default("").describe("Part of a name, a city or an exact id like C-003."), limit: z.number().int().min(1).max(20).default(10) },
      annotations: READ,
    },
    ({ query, limit }) => {
      const rows = ctx.store.searchCustomers(query, limit);
      return json({ count: rows.length, customers: rows.map(customerSummary) });
    },
  );

  server.registerTool(
    "customer_get",
    {
      title: "Get a customer",
      description: "A customer profile with contact details MASKED (e.g. a***@example.test, ***-0110). Use customer_get_contact only when the full value is truly needed.",
      inputSchema: { customer_id: z.string().regex(/^C-\d{3}$/, "ids look like C-003") },
      annotations: READ,
    },
    ({ customer_id }) => {
      const c = ctx.store.getCustomer(customer_id);
      return c ? json(customerMasked(c)) : fail(`customer ${customer_id} not found`);
    },
  );
}

/** Registered separately: full contact details are their own family, so roles can be denied it. */
export function registerCustomerContactTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "customer_get_contact",
    {
      title: "Get full contact details",
      description: "Full email, phone and document id of one customer. Every call is written to the audit log with your reason, so state a real one.",
      inputSchema: { customer_id: z.string().regex(/^C-\d{3}$/), reason: z.string().min(5).max(200).describe("Why the full details are needed, in a sentence.") },
      annotations: READ,
    },
    ({ customer_id, reason }) => {
      const c = ctx.store.getCustomer(customer_id);
      if (!c) return fail(`customer ${customer_id} not found`);
      ctx.audit.record({ event: "sensitive-read", tool: "customer_get_contact", user: ctx.who.name, role: ctx.who.role, customer_id, reason });
      return json(customerContact(c));
    },
  );
}
