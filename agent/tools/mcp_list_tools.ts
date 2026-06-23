import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { listMcpTools } from "../lib/mcp.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"List tools from runtime-added no-auth/static-token MCP servers such as Minecraft, local automations, or other user-added local servers. OAuth SaaS such as Linear/Figma belongs in eve connections, not this layer. Reads ~/.clanky/mcp-servers.json and CLANKY_MCP_SERVERS.",
	inputSchema: z.object({
		server: z.string().optional(),
		timeoutMs: z.number().int().min(100).max(120_000).optional(),
	}),
	async execute(input) {
		return { servers: await listMcpTools(input) };
	},
});
