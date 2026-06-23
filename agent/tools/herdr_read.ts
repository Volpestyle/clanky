import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { herdrRequest } from "../lib/herdr-socket.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Read recent or visible output from a live herdr agent or pane on the host. Use for blocked workers, status checks, and remote inspection.",
	inputSchema: z.object({
		agent: z.string().optional().describe("agent name, for example clanky:fix-tests"),
		pane: z.string().optional().describe("pane id, for example 1-2"),
		source: z.enum(["visible", "recent", "recent_unwrapped", "detection"]).default("recent"),
		lines: z.number().int().min(1).max(1000).default(120),
	}),
	async execute(input) {
		if (input.agent) {
			return herdrRequest("agent.read", {
				target: input.agent,
				source: input.source,
				lines: input.lines,
			});
		}
		if (input.pane) {
			return herdrRequest("pane.read", {
				pane_id: input.pane,
				source: input.source,
				lines: input.lines,
			});
		}
		throw new Error("herdr_read requires agent or pane");
	},
});

