import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordListChannels } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description: "List channels in a Discord guild/server visible to Clanky.",
	inputSchema: z.object({
		guildId: z.string().min(1),
		since: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Only channels with activity since this point. ISO timestamp (2026-06-26T00:00:00Z) or relative duration like 30m, 24h, 7d.",
			),
	}),
	async execute(input) {
		return { channels: await discordListChannels(input) };
	},
});
