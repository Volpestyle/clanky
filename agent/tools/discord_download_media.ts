import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordDownloadMedia } from "../lib/discord/media.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Download Discord message media, attachments, embeds, GIFs, videos, or direct media URLs into local artifacts for inspection or later sharing. Uses Discord auth only for Discord-owned CDN/API URLs and never sends the token to third-party links.",
	inputSchema: z.object({
		channelId: z.string().min(1).optional(),
		messageId: z.string().min(1).optional(),
		urls: z.array(z.string().url()).optional(),
		includeLinks: z.boolean().optional(),
		maxItems: z.number().int().min(1).max(50).optional(),
		maxBytes: z.number().int().min(1).max(100_000_000).optional(),
	}),
	async execute(input) {
		return await discordDownloadMedia(input);
	},
	toModelOutput(output) {
		return {
			type: "json",
			value: {
				items: output.items.map((item) => ({
					url: item.url,
					path: item.path,
					kind: item.kind,
					source: item.source,
					sourceDetail: item.sourceDetail,
					originalUrl: item.originalUrl,
					proxyUrl: item.proxyUrl,
					contentType: item.contentType,
					filename: item.filename,
					bytes: item.bytes,
					width: item.width,
					height: item.height,
					channelId: item.channelId,
					messageId: item.messageId,
					title: item.title,
					provider: item.provider,
					embedType: item.embedType,
				})),
				skipped: output.skipped,
			},
		};
	},
});
