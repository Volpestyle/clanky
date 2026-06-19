import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { renderWebPage } from "../lib/headless-browser.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Render a public web page in Clanky's own headless browser and extract visible text, links, rendered media, OpenGraph/Twitter metadata, and optionally a screenshot artifact. Use media_inspect on the returned screenshot path when pixels must be visually understood.",
	inputSchema: z.object({
		url: z.string().url(),
		waitUntil: z.enum(["domcontentloaded", "load", "networkidle"]).optional(),
		waitMs: z.number().int().min(0).max(10_000).optional(),
		timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
		maxTextChars: z.number().int().min(1).max(100_000).optional(),
		maxLinks: z.number().int().min(0).max(300).optional(),
		maxMedia: z.number().int().min(0).max(300).optional(),
		screenshot: z.boolean().optional(),
		viewport: z
			.object({
				width: z.number().int().min(320).max(3840),
				height: z.number().int().min(240).max(2160),
			})
			.optional(),
	}),
	async execute(input) {
		return await renderWebPage(input);
	},
	toModelOutput(output) {
		return {
			type: "json",
			value: {
				finalUrl: output.finalUrl,
				title: output.title,
				text: output.text,
				truncated: output.truncated,
				links: output.links.slice(0, 40),
				media: output.media.slice(0, 40),
				meta: output.meta.slice(0, 30),
				screenshotPath: output.screenshotPath,
				visualInspectionNextStep:
					output.screenshotPath === undefined
						? undefined
						: {
								tool: "media_inspect",
								paths: [output.screenshotPath],
								reason: "web_render saved a screenshot artifact; call media_inspect before claiming visual inspection of the page.",
							},
			},
		};
	},
});
