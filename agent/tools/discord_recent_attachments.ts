import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordRecentAttachments } from "../lib/discord/media.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Find recent Discord attachments, embeds, GIFs, videos, and optional media links in a channel. Can optionally download them into local artifacts for media_inspect or web_capture_frames.",
	inputSchema: z.object({
		channelId: z.string().min(1),
		messageId: z.string().min(1).optional(),
		limit: z.number().int().min(1).max(100).optional(),
		mediaLimit: z.number().int().min(1).max(50).optional(),
		before: z.string().min(1).optional(),
		after: z.string().min(1).optional(),
		around: z.string().min(1).optional(),
		since: z.string().min(1).optional(),
		until: z.string().min(1).optional(),
		includeLinks: z.boolean().optional(),
		download: z.boolean().optional(),
		maxBytes: z.number().int().min(1).max(100_000_000).optional(),
	}),
	async execute(input) {
		return await discordRecentAttachments(input);
	},
	toModelOutput(output) {
		const downloadedPaths = output.media.flatMap((item) => item.downloaded?.path ?? []);
		return {
			type: "json",
			value: {
				channelId: output.channelId,
				targetMessageId: output.targetMessageId,
				targetMessageFound: output.targetMessageFound,
				scannedMessageCount: output.scannedMessageCount,
				mediaCount: output.mediaCount,
				downloadedCount: output.downloadedCount,
				media: output.media.map((item) => ({
					mediaIndex: item.mediaIndex,
					messageId: item.messageId,
					channelId: item.channelId,
					authorId: item.authorId,
					authorUsername: item.authorUsername,
					timestamp: item.timestamp,
					kind: item.kind,
					source: item.source,
					sourceDetail: item.sourceDetail,
					url: item.url,
					originalUrl: item.originalUrl,
					proxyUrl: item.proxyUrl,
					contentType: item.contentType,
					filename: item.filename,
					size: item.size,
					width: item.width,
					height: item.height,
					title: item.title,
					provider: item.provider,
					embedType: item.embedType,
					status: item.status,
					statusReason: item.statusReason,
					downloadedPath: item.downloaded?.path,
					downloadedBytes: item.downloaded?.bytes,
					downloadedWidth: item.downloaded?.width,
					downloadedHeight: item.downloaded?.height,
				})),
				skipped: output.skipped,
				visualInspectionNextStep:
					downloadedPaths.length === 0
						? undefined
						: {
								paths: downloadedPaths,
								reason:
									"Use media_inspect for image/GIF artifacts. For video or motion-sensitive GIFs, call web_capture_frames on the downloaded path first, then media_inspect the returned frames.",
							},
			},
		};
	},
});
