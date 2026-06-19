import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { callMcpTool } from "../lib/mcp.ts";

export default defineTool({
	needsApproval: always(),
	description:
		"Call a configured no-auth/static-token dynamic MCP server tool by server and tool name. Use mcp_list_tools first unless the exact server, tool, and schema are already known. Do not use for OAuth SaaS such as Linear or Figma.",
	inputSchema: z.object({
		server: z.string().min(1),
		tool: z.string().min(1),
		arguments: z.record(z.string(), z.unknown()).optional(),
		timeoutMs: z.number().int().min(100).max(120_000).optional(),
	}),
	async execute(input) {
		return await callMcpTool(input);
	},
});
