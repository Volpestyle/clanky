import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { generateGeminiImage } from "../lib/media.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Generate images with Google Gemini (Nano Banana). Defaults to CLANKY_GEMINI_IMAGE_MODEL or gemini-3.1-flash-image. Requires CLANKY_GEMINI_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY. Strong at legible text and conversational edits. Saves files locally so they can be shared through discord_send_message.",
	inputSchema: z.object({
		prompt: z.string().min(1),
		model: z.string().optional(),
		outputDir: z.string().optional(),
		filenamePrefix: z.string().optional(),
	}),
	async execute(input) {
		return await generateGeminiImage(input);
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
