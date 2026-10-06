import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { json } from "../helpers.js";
import type { ToolContext } from "../context.js";
import { READ } from "./shared.js";

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "erp_status",
    { title: "ERP status", description: "Who you are connected as, which role you have and whether write tools are enabled.", annotations: READ },
    () =>
      json({
        service: "mcp-erp-server",
        user: ctx.who.name,
        role: ctx.who.role,
        writes_enabled: ctx.config.allowWrites,
        server_time: ctx.now().toISOString(),
      }),
  );
}
