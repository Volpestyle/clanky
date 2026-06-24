import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordAddReaction } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Add a reaction to a Discord message. Use a Unicode emoji or a custom emoji reaction string from discord_list_emojis.",
	inputSchema: z.object({
		channelId: z.string().min(1),
		messageId: z.string().min(1),
		emoji: z.string().min(1),
	}),
	async execute(input) {
		return await discordAddReaction(input);
	},
});
