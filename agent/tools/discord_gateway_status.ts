import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { discordGatewayToolStatus } from "../lib/discord/gateway-status.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Inspect Clanky's live Discord gateway/presence state, including readiness, reply scope, and active accepted DM/channel sessions. Use this before answering questions about what Discord presence session is currently active or who just reached Clanky.",
	inputSchema: z.object({}),
	async execute() {
		return discordGatewayToolStatus();
	},
});
