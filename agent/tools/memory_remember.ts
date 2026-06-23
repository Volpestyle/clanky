import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { rememberMemory } from "../lib/memory.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Save an explicit or obviously important durable memory about the main user, a Discord user/server, a project, or another stable subject. Use for requests like 'remember this', preferred names, durable preferences, and important context.",
	inputSchema: z.object({
		subjectKind: z.enum(["main_user", "discord_user", "discord_server", "project", "other"]),
		subjectId: z.string().optional(),
		subjectName: z.string().optional(),
		fact: z.string().min(1),
		source: z.string().optional(),
		tags: z.array(z.string()).optional(),
		importance: z.number().int().min(1).max(5).optional(),
	}),
	async execute(input) {
		return await rememberMemory(input);
	},
});

