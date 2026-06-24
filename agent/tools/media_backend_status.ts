import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { mediaBackendStatus } from "../lib/media.ts";

export default defineTool({
	needsApproval: never(),
	description: "Check configured media generation and visual inspection backends without revealing credentials. Call this before telling the user that no vision model or visual inspection backend is available.",
	inputSchema: z.object({}),
	async execute() {
		return await mediaBackendStatus();
	},
});
