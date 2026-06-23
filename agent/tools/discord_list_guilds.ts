import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordListGuilds } from "../lib/discord/rest.ts";

export default defineTool({
	needsApproval: never(),
	description: "List Discord servers/guilds visible to Clanky's configured Discord credential.",
	inputSchema: z.object({}),
	async execute() {
		return { guilds: await discordListGuilds() };
	},
});

