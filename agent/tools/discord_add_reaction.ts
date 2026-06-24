import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { gated } from "../lib/approvals.ts";
import { discordAddReaction } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: gated(always()),
	description:
		"Add a reaction to a Discord message. Use a Unicode emoji or a custom emoji reaction string from discord_list_emojis. Requires approval because it mutates Discord.",
	inputSchema: z.object({
		channelId: z.string().min(1),
		messageId: z.string().min(1),
		emoji: z.string().min(1),
	}),
	async execute(input) {
		return await discordAddReaction(input);
	},
});
