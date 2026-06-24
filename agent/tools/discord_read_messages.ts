import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordReadMessages } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Read recent Discord channel messages, including attachment, embed, link, and media metadata. This does not visually inspect pixels; download and pass media to media_inspect before describing images. Do not infer that no vision model is available from this metadata.",
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
