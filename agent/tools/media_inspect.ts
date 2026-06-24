import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { inspectVisualMedia } from "../lib/media.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Inspect local image artifacts. Prefers Clanky's current brain model when it is vision-capable, and falls back to the configured OpenAI vision model when the active model cannot inspect images. Use after web_render screenshots, web_capture_frames, discord_download_media, or generated image files when visual content must be understood.",
	inputSchema: z.object({
		paths: z.array(z.string().min(1)).min(1).max(12),
		prompt: z.string().min(1).max(4_000).optional(),
		model: z.string().min(1).optional(),
		maxImages: z.number().int().min(1).max(12).optional(),
		maxBytesPerImage: z.number().int().min(1).max(20 * 1024 * 1024).optional(),
	}),
	async execute(input) {
		return await inspectVisualMedia(input);
	},
	toModelOutput(output) {
		return {
			type: "json",
			value: {
				provider: output.provider,
				model: output.model,
				text: output.text,
				items: output.items,
				totalRequested: output.totalRequested,
				truncated: output.truncated,
			},
		};
	},
});
