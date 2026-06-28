import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { allowedCodingHarnesses, resolveCodingHarness } from "../lib/coding-harness.ts";
import { herdrRequest } from "../lib/herdr-socket.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Inspect the live host herdr session: agents, workspaces, tabs, panes, and configured coding harness allowlist. Use before summarizing swarm state or deciding where to send work.",
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
		return { agents, workspaces, tabs, panes, codingHarnesses: codingHarnessStatus() };
	},
});

function codingHarnessStatus(): unknown {
	try {
		const allowed = allowedCodingHarnesses();
		return {
			allowed,
			profiles: allowed.map((harness) => {
				try {
					const profile = resolveCodingHarness({ harness });
					return {
						id: profile.id,
						label: profile.label,
						runtime: profile.runtime,
						performer: profile.performer,
						launcher: profile.launcher,
						model: profile.model,
						command: profile.command,
					};
				} catch (error) {
					return {
						id: harness,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		};
	} catch (error) {
		return {
			allowed: safeAllowedHarnesses(),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function safeAllowedHarnesses(): readonly string[] {
	try {
		return allowedCodingHarnesses();
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}
