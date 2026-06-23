import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { mediaBackendStatus } from "../lib/media.ts";

export default defineTool({
	needsApproval: never(),
	description: "Check configured media generation backends and default model IDs without revealing credentials.",
	inputSchema: z.object({}),
	execute() {
		return mediaBackendStatus();
	},
});

