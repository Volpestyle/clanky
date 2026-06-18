import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { herdrRequest } from "../lib/herdr-socket.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Inspect the live host herdr session: agents, workspaces, tabs, and panes. Use before summarizing swarm state or deciding where to send work.",
	inputSchema: z.object({
		includeWorkspaces: z.boolean().default(true),
		includeTabs: z.boolean().default(true),
		includePanes: z.boolean().default(true),
	}),
	async execute(input) {
		const [agents, workspaces, tabs, panes] = await Promise.all([
			herdrRequest("agent.list"),
			input.includeWorkspaces ? herdrRequest("workspace.list") : Promise.resolve(null),
			input.includeTabs ? herdrRequest("tab.list") : Promise.resolve(null),
			input.includePanes ? herdrRequest("pane.list") : Promise.resolve(null),
		]);
		return { agents, workspaces, tabs, panes };
	},
});

