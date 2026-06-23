import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordWhoami } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description: "Return the Discord identity attached to Clanky's configured Discord credential.",
	inputSchema: z.object({}),
	async execute() {
		return { identity: await discordWhoami() };
	},
});
