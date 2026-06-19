import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordListChannels } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description: "List channels in a Discord guild/server visible to Clanky.",
	inputSchema: z.object({
		guildId: z.string().min(1),
		since: z.string().min(1).optional(),
	}),
	async execute(input) {
		return { channels: await discordListChannels(input) };
	},
});
