import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordReadMessages } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Read recent Discord channel messages, including attachment, embed, link, and media metadata. Use before summarizing server context or choosing where to reply.",
	inputSchema: z.object({
		channelId: z.string().min(1),
		limit: z.number().int().min(1).max(100).optional(),
		before: z.string().optional(),
		after: z.string().optional(),
		around: z.string().optional(),
		since: z.string().min(1).optional(),
		until: z.string().min(1).optional(),
	}),
	async execute(input) {
		return { messages: await discordReadMessages(input) };
	},
});
