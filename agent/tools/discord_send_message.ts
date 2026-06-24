import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordSendMessage } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Send a Discord channel message and optionally upload local files such as generated images.",
	inputSchema: z.object({
		channelId: z.string().min(1),
		content: z.string().optional(),
		filePaths: z.array(z.string()).optional(),
		replyToMessageId: z.string().optional(),
	}),
	async execute(input) {
		return await discordSendMessage(input);
	},
});
