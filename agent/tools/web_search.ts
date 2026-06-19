import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { searchWeb } from "../lib/web.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Search the public web and return result URLs. Use for current public discovery, then call web_fetch or browser_control on promising pages.",
	inputSchema: z.object({
		query: z.string().min(1),
		limit: z.number().int().min(1).max(20).optional(),
	}),
	async execute(input) {
		return await searchWeb(input);
	},
});

