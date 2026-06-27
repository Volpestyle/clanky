import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordReadMessages } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Read recent Discord channel messages, including attachment, embed, link, and media metadata. This returns text metadata only, not pixels. To actually see images in a channel, call discord_recent_attachments, which downloads and describes them with Clanky's own vision model in one step. Do not infer from this metadata that no vision is available.",
	inputSchema: z.object({
		channelId: z.string().min(1),
		limit: z.number().int().min(1).max(100).optional(),
		before: z.string().optional(),
		after: z.string().optional(),
		around: z
			.string()
			.optional()
			.describe("Message ID to center results on. Ignored when since/until is set."),
		since: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Lower time bound. ISO timestamp/date (2026-06-26T00:00:00Z or 2026-06-26), month/day date like June 24, 'today', 'yesterday', 'now', or relative duration like 30m, 24h, 7d. Takes precedence over around.",
			),
		until: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Upper time bound. ISO timestamp/date (2026-06-26T00:00:00Z or 2026-06-26), month/day date like June 24, 'today', 'yesterday', 'now', or relative duration like 30m, 24h, 7d. Takes precedence over around.",
			),
	}),
	async execute(input) {
		return { messages: await discordReadMessages(input) };
	},
});
