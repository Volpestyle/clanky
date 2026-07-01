import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { searchHerdrHistory } from "../lib/history-search.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Full-text search across all durable herdr history on the host: worker transcripts and session-wide pane recordings, including compressed archives. Matches attribute back to the worker run or pane recording; follow up with herdr_read (source recording/transcript, anchor/skip) to read around a hit.",
	inputSchema: z.object({
		query: z.string().min(1).describe("text to find; treated literally unless regex is true"),
		limit: z.number().int().min(1).max(100).default(20),
		regex: z.boolean().default(false),
		case_sensitive: z.boolean().default(false),
	}),
	async execute(input) {
		return searchHerdrHistory(input.query, {
			limit: input.limit,
			regex: input.regex,
			caseSensitive: input.case_sensitive,
		});
	},
});
