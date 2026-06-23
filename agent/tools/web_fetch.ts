import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { fetchWebPage } from "../lib/web.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Fetch and extract a public web page: title, readable text, links, and media URLs. Use for URL inspection and lightweight scraping before escalating to browser_control.",
	inputSchema: z.object({
		url: z.string().url(),
		maxBytes: z.number().int().min(1).max(10_000_000).optional(),
		maxTextChars: z.number().int().min(1).max(100_000).optional(),
	}),
	async execute(input) {
		return await fetchWebPage(input);
	},
	toModelOutput(output) {
		return {
			type: "json",
			value: {
				finalUrl: output.finalUrl,
				status: output.status,
				contentType: output.contentType,
				title: output.title,
				text: output.text,
				truncated: output.truncated,
				links: output.links.slice(0, 30),
				media: output.media.slice(0, 30),
			},
		};
	},
});

