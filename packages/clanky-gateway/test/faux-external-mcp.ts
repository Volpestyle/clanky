import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const server = new McpServer({ name: "faux-external-mcp", version: "0.0.0" });

server.registerTool(
	"echo",
	{
		title: "Echo",
		description: "Echo a message and environment marker.",
		inputSchema: {
			message: z.string().min(1),
		},
	},
	async (args) => ({
		content: [
			{
				type: "text",
				text: JSON.stringify({
					message: args.message,
					marker: process.env.CLANKY_FAUX_MCP_MARKER ?? "missing",
				}),
			},
		],
	}),
);

await server.connect(new StdioServerTransport());
