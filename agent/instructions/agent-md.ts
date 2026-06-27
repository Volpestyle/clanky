import { defineDynamic, defineInstructions } from "eve/instructions";
import {
	agentMdRootFromEnv,
	buildAgentMdInstructions,
	collectAgentMdFiles,
	isAgentMdIngestionEnabled,
} from "../lib/agent-md.ts";

export default defineDynamic({
	events: {
		"turn.started": async () => {
			if (!isAgentMdIngestionEnabled()) return null;
			const files = await collectAgentMdFiles({ root: agentMdRootFromEnv() });
			const markdown = buildAgentMdInstructions(files);
			return markdown.length === 0 ? null : defineInstructions({ markdown });
		},
	},
});
