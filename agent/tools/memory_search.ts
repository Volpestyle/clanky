import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { searchMemories } from "../lib/memory.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Search Clanky's durable memory for relevant user, Discord, server, or project facts before claiming recall or personal context.",
	inputSchema: z.object({
		query: z.string().optional(),
		subjectKind: z.enum(["main_user", "discord_user", "discord_server", "project", "other"]).optional(),
		subjectId: z.string().optional(),
		tags: z.array(z.string()).optional(),
		limit: z.number().int().min(1).max(100).optional(),
	}),
	async execute(input) {
		return { memories: await searchMemories(input) };
	},
});

