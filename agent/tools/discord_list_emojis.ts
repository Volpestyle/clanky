import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordListEmojis } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description: "List custom Discord emojis in a guild/server, including reaction strings usable with discord_add_reaction.",
	inputSchema: z.object({
		guildId: z.string().min(1),
	}),
	async execute(input) {
		return { emojis: await discordListEmojis(input.guildId) };
	},
});
