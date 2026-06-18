import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { herdrRequest } from "../lib/herdr-socket.ts";

export default defineTool({
	needsApproval: never(),
	description:
		"Send text or discrete keys to a live herdr agent/pane on the host. Use to unblock or steer visible workers.",
	inputSchema: z.object({
		agent: z.string().optional(),
		pane: z.string().optional(),
		text: z.string().optional(),
		keys: z.array(z.string()).optional(),
	}),
	async execute(input) {
		if (input.agent) {
			if (!input.text) throw new Error("sending to an agent requires text");
			return herdrRequest("agent.send", { target: input.agent, text: input.text });
		}
		if (!input.pane) throw new Error("herdr_send requires agent or pane");
		if (input.keys && input.keys.length > 0) {
			return herdrRequest("pane.send_keys", { pane_id: input.pane, keys: input.keys });
		}
		if (!input.text) throw new Error("sending to a pane requires text or keys");
		return herdrRequest("pane.send_input", { pane_id: input.pane, text: input.text, keys: ["Enter"] });
	},
});

