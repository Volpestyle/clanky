import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { generateXaiImage } from "../lib/media.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Generate images with xAI Grok Imagine. Defaults to CLANKY_XAI_IMAGE_MODEL or grok-imagine-image-quality. Requires CLANKY_XAI_API_KEY or XAI_API_KEY. Saves files locally so they can be shared through discord_send_message.",
	inputSchema: z.object({
		prompt: z.string().min(1),
		model: z.string().optional(),
		n: z.number().int().min(1).max(10).optional(),
		aspectRatio: z
			.string()
			.optional()
			.describe("Aspect ratio, e.g. 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, or auto."),
		resolution: z.enum(["1k", "2k"]).optional().describe("1k for normal output, 2k for higher-resolution finals."),
		outputDir: z.string().optional(),
		filenamePrefix: z.string().optional(),
	}),
	async execute(input) {
		return await generateXaiImage(input);
	},
	toModelOutput(output) {
		const paths = output.files.map((file) => file.path);
		return {
			type: "json",
			value: {
				provider: output.provider,
				model: output.model,
				files: output.files,
				discordShareNextStep: {
					tool: "discord_send_message",
					filePaths: paths,
					reason: "Generated image files are local artifacts; upload them with discord_send_message when the user wants them posted.",
				},
				inspectNextStep: {
					tool: "media_inspect",
					paths,
					reason: "Use media_inspect first when image quality or visual details need checking before sharing.",
				},
			},
		};
	},
});
