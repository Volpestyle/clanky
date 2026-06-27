import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { generateXaiVideo } from "../lib/media.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Generate videos with xAI Grok Imagine (text-to-video). Defaults to CLANKY_XAI_VIDEO_MODEL or grok-imagine-video. Requires CLANKY_XAI_API_KEY or XAI_API_KEY. Generation is async and can take several minutes; the SDK polls until done. Saves the video locally and reports the path (and hosted URL when present) so it can be shared with discord_send_message.",
	inputSchema: z.object({
		prompt: z.string().min(1),
		model: z.string().optional(),
		duration: z.number().int().min(1).max(15).optional().describe("Video length in seconds (1-15)."),
		aspectRatio: z.string().optional().describe("Aspect ratio, e.g. 16:9 (default), 9:16, 1:1, 4:3."),
		resolution: z.enum(["480p", "720p"]).optional().describe("480p for faster drafts, 720p for HD."),
		outputDir: z.string().optional(),
		filenamePrefix: z.string().optional(),
	}),
	async execute(input) {
		return await generateXaiVideo(input);
	},
	toModelOutput(output) {
		return {
			type: "json",
			value: {
				provider: output.provider,
				model: output.model,
				path: output.path,
				bytes: output.bytes,
				url: output.url,
				duration: output.duration,
				discordShareNextStep: {
					tool: "discord_send_message",
					filePaths: [output.path],
					reason: "The generated video is a local artifact; upload it with discord_send_message when the user wants it posted. Hosted xAI URLs are temporary.",
				},
			},
		};
	},
});
