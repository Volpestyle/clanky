import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { generateOpenAiImage } from "../lib/media.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Generate images with the OpenAI Images API. Defaults to CLANKY_OPENAI_IMAGE_MODEL or gpt-image-2. Saves files locally so they can be shared through discord_send_message.",
	inputSchema: z.object({
		prompt: z.string().min(1),
		model: z.string().optional(),
		n: z.number().int().min(1).max(10).optional(),
		size: z.string().optional(),
		quality: z.enum(["low", "medium", "high", "auto"]).optional(),
		background: z.enum(["auto", "opaque", "transparent"]).optional(),
		outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
		outputCompression: z.number().int().min(0).max(100).optional(),
		moderation: z.enum(["auto", "low"]).optional(),
		outputDir: z.string().optional(),
		filenamePrefix: z.string().optional(),
	}),
	async execute(input) {
		return await generateOpenAiImage(input);
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
					reason: "Generated image files are local artifacts; upload them with discord_send_message after approval when the user wants them posted.",
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
