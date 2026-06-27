import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordRecentAttachments } from "../lib/discord/media.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Find recent Discord attachments, embeds, GIFs, videos, and optional media links in a channel. By default (describe), it downloads still images and describes them with Clanky's own vision-capable brain model in this same call, returning a visualInspection field — you do not need a separate media_inspect step to see fetched images. Video (and motion-sensitive GIFs) still route to web_capture_frames on the downloaded path.",
	inputSchema: z.object({
		channelId: z.string().min(1),
		messageId: z.string().min(1).optional().describe("Anchor message ID. Ignored when since/until is set."),
		limit: z.number().int().min(1).max(100).optional(),
		mediaLimit: z.number().int().min(1).max(50).optional(),
		before: z.string().min(1).optional(),
		after: z.string().min(1).optional(),
		around: z
			.string()
			.min(1)
			.optional()
			.describe("Message ID to center results on. Ignored when since/until is set."),
		since: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Lower time bound. ISO timestamp (2026-06-26T00:00:00Z) or relative duration like 30m, 24h, 7d. Takes precedence over messageId/around.",
			),
		until: z
			.string()
			.min(1)
			.optional()
			.describe("Upper time bound. ISO timestamp or relative duration like 30m, 24h, 7d."),
		includeLinks: z.boolean().optional(),
		download: z.boolean().optional(),
		maxBytes: z.number().int().min(1).max(100_000_000).optional(),
		describe: z
			.boolean()
			.optional()
			.describe(
				"Default true. Download still images and describe them with Clanky's brain vision model in this call (returned as visualInspection). Set false for metadata only.",
			),
		describePrompt: z
			.string()
			.min(1)
			.max(4_000)
			.optional()
			.describe("Optional custom instruction for the visual description pass."),
	}),
	async execute(input) {
		return await discordRecentAttachments(input);
	},
	toModelOutput(output) {
		const inspectedIndexes = new Set(output.visualInspection?.inspectedMediaIndexes ?? []);
		// Only point at the frame-grab path for media this call did not already describe directly:
		// downloaded artifacts that are video, or stills that fell outside the inspection batch.
		const framePaths = output.media.flatMap((item) =>
			item.downloaded !== undefined && !inspectedIndexes.has(item.mediaIndex) ? item.downloaded.path : [],
		);
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
				visualInspection: output.visualInspection,
				frameCaptureNextStep:
					framePaths.length === 0
						? undefined
						: {
								paths: framePaths,
								reason:
									"These artifacts were not described inline (video, or stills beyond the describe batch). For video or motion-sensitive GIFs, call web_capture_frames on the downloaded path, then media_inspect the returned frames.",
							},
			},
		};
	},
});
