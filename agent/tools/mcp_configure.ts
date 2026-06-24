import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { gated } from "../lib/approvals.ts";
import { upsertMcpServer } from "../lib/mcp.ts";

export default defineTool({
	needsApproval: gated(always()),
	description:
		"Add or update a persistent MCP server config in ~/.clanky/mcp-servers.json. Use for user-approved setup such as Minecraft MCP.",
	inputSchema: z.object({
		name: z.string().min(1),
		type: z.enum(["stdio", "http", "streamable-http", "sse"]).optional(),
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		cwd: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
		url: z.string().optional(),
		description: z.string().optional(),
		allowedTools: z.array(z.string()).optional(),
		disabled: z.boolean().optional(),
	}),
	async execute(input) {
		const { name, ...config } = input;
		return await upsertMcpServer(name, config);
	},
});

