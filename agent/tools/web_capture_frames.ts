import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { captureWebFrames } from "../lib/headless-browser.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Capture timed viewport screenshot artifacts from a public URL or local media artifact in Clanky's headless browser. Use for GIFs, videos, YouTube/X/social previews, Discord-downloaded media, and pages where visual changes over time matter. Use media_inspect on returned frame paths to understand pixels.",
	inputSchema: z.object({
		url: z.string().url().optional(),
		path: z.string().min(1).optional(),
		waitUntil: z.enum(["domcontentloaded", "load", "networkidle"]).optional(),
		waitMs: z.number().int().min(0).max(10_000).optional(),
		timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
		frameCount: z.number().int().min(1).max(12).optional(),
		intervalMs: z.number().int().min(0).max(10_000).optional(),
		autoplay: z.boolean().optional(),
		clickSelector: z.string().min(1).optional(),
		viewport: z
			.object({
				width: z.number().int().min(320).max(3840),
				height: z.number().int().min(240).max(2160),
			})
			.optional(),
	}),
	async execute(input) {
		return await captureWebFrames(input);
	},
	toModelOutput(output) {
		const paths = output.frames.map((frame) => frame.path);
		return {
			type: "json",
			value: {
				source: output.source,
				finalUrl: output.finalUrl,
				title: output.title,
				frameCount: output.frameCount,
				frames: output.frames,
				mediaState: output.mediaState,
				visualInspectionNextStep: {
					tool: "media_inspect",
					paths,
					reason: "web_capture_frames saved frame artifacts; call media_inspect before claiming visual inspection of motion or frame content.",
				},
			},
		};
	},
});
