import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordRecentActivity } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description: "Summarize recent activity across the most recently active text channels in a Discord guild/server.",
	inputSchema: z.object({
		guildId: z.string().min(1),
		since: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Lower time bound for activity. ISO timestamp (2026-06-26T00:00:00Z) or relative duration like 30m, 24h, 7d.",
			),
		channelIds: z.array(z.string().min(1)).optional(),
		channelNameQuery: z.string().min(1).optional(),
		channelLimit: z.number().int().min(1).max(20).optional(),
		messageLimit: z.number().int().min(1).max(100).optional(),
		includeMessages: z.boolean().optional(),
	}),
	async execute(input) {
		return await discordRecentActivity(input);
	},
});
